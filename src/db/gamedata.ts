/**
 * Changing the game's own numbers, in the archive the game actually loads.
 *
 * Four numbers, in three of the game's records, and they are all the same kind
 * of change — a data change rather than a save edit, so it is true of every
 * character including ones made later:
 *
 * - **base movement speed** (`characterRunSpeed`, 0.93 on the two player
 *   creature records) and **the ceiling `+% movement speed` gear counts up to**
 *   (`playerRunSpeedCapMax`, 135 on the engine record, 500 in Path of Grim
 *   Dawn). Both are asked for as a **percentage** of what they started at.
 * - **the maximum character level** (`maxPlayerLevel`, 100) and **the maximum
 *   devotion points** (`maxDevotionPoints`, 55), both on
 *   `records/creatures/pc/playerlevels.dbr`. Both are asked for as an
 *   **absolute** number, because "+35% of the level cap" means nothing.
 *
 * A knob nobody asked for is **left out entirely** — not set to zero. That is
 * the difference between "put the speed back where it started" (0%) and "this
 * run is not about the speed", and it is what keeps a cap-only change from
 * having an opinion about `malepc01.dbr`, or a speed-only change from needing
 * `playerlevels.dbr` to exist at all.
 *
 * **Where it goes is the whole question, and a mod of our own was the wrong
 * answer.** Grim Dawn loads one mod at a time: a `mods/gdspeed/` is not read
 * while somebody is playing Path of Grim Dawn, and `/basemods` does not stack
 * on top of a Custom Game mod — tested in the game, which is the only place
 * that question could be settled. So there are two targets, and both of them
 * are a file somebody else made:
 *
 * - **the campaign** — `mods/database.arz`, the loose base-mod archive that
 *   `/basemods` loads over the main game. Created when it is not there, and
 *   **merged into** when it is, because it is where every other base mod's
 *   records live too.
 * - **a Custom Game mod** — `mods/<name>/database/<name>.arz`, the only
 *   database that game reads.
 *
 * `patchArzValues` and `appendArzRecords` do the writing: a record the target
 * already has gets its values overwritten, a record it lacks is added, and
 * every other byte of the file is carried over as it was. An archive edited
 * that way is confirmed to load, both as a base mod and as a Custom Game one.
 * Nothing here touches the disk — the caller backs the archive up, and writes.
 *
 * **Two knobs can share one record, and that is why the loop groups by record
 * before it builds anything.** `maxPlayerLevel` and `maxDevotionPoints` both
 * live on `playerlevels.dbr`; building one edit per *field* appended that
 * record twice, and because the reader keeps the last of a duplicated name, the
 * verify gate was satisfied by the second copy while the first one's change
 * quietly went missing. A silent wrong write is the one outcome this whole
 * module exists to prevent.
 *
 * The `baseline` is what keeps this honest across builds. Editing in place
 * means the next read sees this tool's own output, so a percentage would
 * compound: +30% of 500 is 650, and +30% again would be 845. Each build records
 * what a field held *before* it first wrote there and what it wrote, and the
 * next one measures from the first of those — while the second still matches,
 * which is how a mod updated underneath is noticed rather than re-based
 * silently. A build **carries forward the marks it did not look at**, so
 * changing the level cap alone cannot forget what the speed started at.
 *
 * **Built on the user's machine from the user's install, never shipped.** The
 * records are read out of the archives that are actually there and written back
 * with one field changed. Anything built against another install's records
 * would quietly revert whatever that build changed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  appendArzRecords,
  patchArzValues,
  replaceArzRecords,
  readArzRaw,
  writeArz,
  type ArzValueEdit,
  type RawArzRecord,
} from './arz.js';
import { gameArchives } from './gamefiles.js';
import type { SweepIndex, SweepRule } from './sweepindex.js';
import { listMods, modArchivePath, resolveModArchive } from './mods.js';

/** The player creature records — one per gender, identical in every field that matters here. */
const PLAYER_RECORDS = ['records/creatures/pc/malepc01.dbr', 'records/creatures/pc/femalepc01.dbr'];
const ENGINE_RECORD = 'records/game/gameengine.dbr';
const PLAYER_LEVELS_RECORD = 'records/creatures/pc/playerlevels.dbr';

/**
 * The per-level skill point grant, on the levels record. Not edited — read, so
 * a level cap can be refused for going past the last level the game has an
 * entry for. It is a list, which `patchArzValues` will not write anyway.
 */
const SKILL_TABLE_FIELD = 'skillModifierPoints';

/** The archive `/basemods` loads for the main campaign: loose in `mods/`, and named for nobody. */
export const BASE_MOD_ARCHIVE = 'database.arz';

/**
 * The numbers this can change, and how each one is asked for.
 *
 * `percent` is measured from what the field held before this tool first wrote
 * to the target, so building twice at the same percentage changes nothing; `0`
 * means *put this one back where it started*. `absolute` is the number itself,
 * so `min: 1` rather than a zero that would have to mean two things.
 */
export const KNOBS = {
  run: { records: PLAYER_RECORDS, field: 'characterRunSpeed', mode: 'percent', min: -99, max: 500 },
  cap: { records: [ENGINE_RECORD], field: 'playerRunSpeedCapMax', mode: 'percent', min: -99, max: 500 },
  maxLevel: { records: [PLAYER_LEVELS_RECORD], field: 'maxPlayerLevel', mode: 'absolute', min: 1, max: 9999 },
  maxDevotionPoints: {
    records: [PLAYER_LEVELS_RECORD],
    field: 'maxDevotionPoints',
    mode: 'absolute',
    min: 1,
    max: 9999,
  },
} as const satisfies Record<string, { records: readonly string[]; field: string; mode: 'percent' | 'absolute'; min: number; max: number }>;

export type KnobName = keyof typeof KNOBS;

export const KNOB_NAMES = Object.keys(KNOBS) as KnobName[];

/**
 * The game's own container highlight.
 *
 * The QoL base mod invents a `lootsparkle05_fx.dbr` for this. It does not have
 * to: `chestloop01_fx.dbr` is what the game already puts on 69 of the 142
 * containers that glow, so pointing at it keeps this a field edit rather than a
 * field edit plus a record nobody but us has.
 */
export const CONTAINER_HIGHLIGHT_FX = 'records/fx/itemfx/chestloop01_fx.dbr';

/**
 * The other shape of change: one value set on **every record matching a rule**,
 * rather than on records this file knows by name.
 *
 * These are the quality-of-life edits the base mods make — see quest markers
 * sooner, take iron in one pile, light up every container. Each is genuinely one
 * constant across many records, which is why they are worth having without the
 * mod that reverts a patch's content along the way.
 *
 * Which records a rule selects cannot be known from a record's *name*, so it
 * costs a scan of the database — see `sweepindex.ts`, which does that once and
 * remembers it. Nothing here scans; the caller passes the index in.
 */
export const SWEEPS = {
  /**
   * `raiseOnly` matters more than it looks. `markerRange` is not one number
   * across the game — it runs from 0 to 500 — so setting every record to 250
   * would pull in every marker already visible from farther than that, which is
   * the opposite of what asking for it means. A record already at or above the
   * value is left alone instead. Iron is not raise-only: "one pile" is exactly
   * one, and 1 is below every stock value.
   */
  markerRange: { rule: 'has-markerRange', fields: ['markerRange'], adds: false, raiseOnly: true, min: 1, max: 5000 },
  ironPiles: { rule: 'has-goldSplit', fields: ['goldSplitMin', 'goldSplitMax'], adds: false, raiseOnly: false, min: 1, max: 50 },
  /** A string field the record does not have yet, which is why it is its own case. */
  highlightContainers: { rule: 'containers', fields: ['IdleEffect'], adds: true, raiseOnly: false, min: 0, max: 1 },
} as const satisfies Record<
  string,
  { rule: SweepRule; fields: readonly string[]; adds: boolean; raiseOnly: boolean; min: number; max: number }
>;

export type SweepName = keyof typeof SWEEPS;

export const SWEEP_NAMES = Object.keys(SWEEPS) as SweepName[];

/**
 * What each sweep is set to. A sweep left out is not applied at all, exactly as
 * an omitted knob is not — and `highlightContainers` is a yes/no, so it takes
 * `true` rather than a number nobody would pick.
 */
export type GameDataSweeps = Partial<{
  markerRange: number;
  ironPiles: number;
  highlightContainers: boolean;
}>;

/** What a knob is asked for as: a percentage of where it started, or the number itself. */
export type KnobMode = (typeof KNOBS)[KnobName]['mode'];

/** Which numbers a build is about. A knob left out is not touched at all. */
export type GameDataKnobs = Partial<Record<KnobName, number>>;

/** Every record a build has to read, given what it was asked to change. */
export function recordsForKnobs(knobs: GameDataKnobs): string[] {
  const out: string[] = [];
  for (const name of KNOB_NAMES) {
    if (knobs[name] === undefined) continue;
    for (const record of KNOBS[name].records) if (!out.includes(record)) out.push(record);
  }
  return out;
}

/** Which archive the change goes into. */
export type GameDataTarget = { kind: 'campaign' } | { kind: 'mod'; mod: string };

export interface GameDataChange {
  /** Which of the four numbers this row is. */
  knob: KnobName;
  record: string;
  field: string;
  /** What the game reads today: the target's value, or the merged one when the target has no such record. */
  from: number;
  to: number;
  /** What the field held before this tool first wrote to this target. */
  original: number;
  /** Which archive `from` won the merge from. */
  sourceArchive: string;
  /** `overwrite` when the target already holds this record, `add` when it does not. */
  how: 'overwrite' | 'add';
}

/** A field asked about and left exactly where it already is. */
export interface GameDataUntouched {
  knob: KnobName;
  record: string;
  field: string;
  value: number;
  sourceArchive: string;
}

/**
 * What a field held before this tool first wrote to this target, and what it
 * wrote there.
 *
 * `written` is a check rather than a value anyone needs back: while the archive
 * still holds it, `original` is what a percentage means and what "put it back"
 * would put back. When it does not, the mod has been updated or something else
 * edited it, and what is there now is the new original.
 */
export interface GameDataBaseline {
  record: string;
  field: string;
  original: number;
  written: number;
}

/**
 * A sweep, as a plan reports it: one line for thousands of records, because a
 * table with ten thousand rows in it is not a plan anybody reads.
 */
export interface GameDataSweepChange {
  sweep: SweepName;
  /** What every selected record will hold. A path, for the container highlight. */
  to: number | string;
  /** What they hold now, as a range — `0–1`, or `absent`. */
  from: string;
  /** Records this will change. */
  changing: number;
  /** Records already holding it, which are left alone. */
  already: number;
  /** Of `changing`, how many the target archive does not have and must be added. */
  adding: number;
}

export type GameDataRefusal =
  | { kind: 'record-missing'; record: string }
  | { kind: 'field-missing'; record: string; field: string }
  /** No knob was named, so there is nothing to plan. */
  | { kind: 'nothing-asked-for' }
  /** Every knob that was named already holds the value it was asked for. */
  | { kind: 'nothing-to-change' }
  /**
   * Below -100% a character walks backwards, and at -100% it does not walk. A
   * cap of zero has no second meaning to fall back on, so it is refused too.
   */
  | { kind: 'value-out-of-range'; knob: KnobName; value: number; min: number; max: number }
  /**
   * A level cap past the last level `skillModifierPoints` has an entry for. The
   * table is a list, so it cannot be extended by an in-place value patch, and a
   * cap the game has no per-level grant for is worse than not raising it.
   */
  | { kind: 'level-above-skill-table'; value: number; entries: number }
  /** The mod named as the target is not installed. */
  | { kind: 'target-mod-missing'; mod: string; installed: string[] }
  /** A sweep was asked for and no index of the install was supplied. */
  | { kind: 'sweep-index-missing' }
  | { kind: 'sweep-out-of-range'; sweep: SweepName; value: number; min: number; max: number }
  /** The archive to be edited is there and cannot be read. */
  | { kind: 'target-unreadable'; path: string; detail: string }
  /** The edit could not be applied to the archive at all. */
  | { kind: 'build-failed'; detail: string }
  /** It was applied, and the result does not read back as what it was meant to be. */
  | { kind: 'verify-mismatch'; detail: string };

export interface GameDataPlan {
  target: GameDataTarget;
  /** The archive that will be written. */
  arzPath: string;
  /** `patch` merges into an archive that is already there; `create` writes a new one. */
  action: 'patch' | 'create';
  changes: GameDataChange[];
  untouched: GameDataUntouched[];
  /** One entry per sweep asked for, whether or not it changes anything. */
  sweeps: GameDataSweepChange[];
  refusals: GameDataRefusal[];
  /** The archive bytes. Present only when `refusals` is empty. */
  output?: Buffer;
  /**
   * What to remember, so the next build measures from the same place. Present
   * with `output`, and it carries forward every mark this build did not look
   * at — a build that changed only the level cap must not forget where the
   * movement speed started.
   */
  baseline?: GameDataBaseline[];
  /**
   * Set when a field no longer holds what this tool last wrote there — the mod
   * was updated, or something else edited it. What is there now is treated as
   * the original, and saying so is better than quietly re-basing.
   */
  drifted: boolean;
  /** What to put in Steam's launch options. Only the campaign needs one. */
  launchHint?: string;
}

export interface GameDataPlanInput {
  gameDir: string;
  /** Defaults to the campaign — `mods/database.arz`. */
  target?: GameDataTarget;
  /**
   * The numbers to change, and what to change them to. A knob left out is not
   * touched, and the record it lives on is not even read.
   *
   * `run` and `cap` are **percentages**, always relative to `original` and
   * never to what the archive holds now, so building at +30% twice is +30%
   * rather than +69%. Negative slows the character down, which is a real thing
   * to want: these two numbers are a ceiling as much as a floor, and someone
   * playing a mod that has already raised them may want them back. `0` means
   * *put this one back where it started*.
   *
   * `maxLevel` and `maxDevotionPoints` are **the numbers themselves**.
   */
  knobs: GameDataKnobs;
  /**
   * The rule-selected changes to make. Requires `index`.
   *
   * A sweep records **no baseline**: it is absolute and idempotent, so nothing
   * compounds, and remembering what ten thousand records held before would put
   * about a megabyte of it in `settings.json`. Putting a sweep back means
   * restoring the archive from the copy taken before the first write — which is
   * a blunter undo than the percentages have, and is worth saying out loud.
   */
  sweeps?: GameDataSweeps;
  /** Which records each rule selects, and what they hold. From `sweepIndex()`. */
  index?: SweepIndex;
  /**
   * Whether to produce the archive bytes, or only describe the edit.
   *
   * Defaults to producing them, which is what every caller wanted while this
   * only ever touched three records. A sweep makes the build the expensive half
   * — thousands of records recompressed and read back — so a caller re-planning
   * for display passes `false` and builds once, at the moment it writes.
   */
  build?: boolean;
  /** What a previous build recorded — for this same target, or not at all. */
  baseline?: readonly GameDataBaseline[];
}

/** The stored `u16` type words: 0 int, 1 float, 2 string. */
const INT_FIELD = 0;
const FLOAT_FIELD = 1;
const STRING_FIELD = 2;

/** A float read into a double prints as 0.9300000071525574; four places is plenty. */
function round4(v: number): number {
  return Number(v.toFixed(4));
}

/** A value in the field's own type: `1.35 × 0.93` as float32, or a rounded int. */
function encodeAs(type: number, value: number): number {
  return type === FLOAT_FIELD ? Math.fround(value) : Math.round(value);
}

/**
 * The same record with each named single-valued field replaced.
 *
 * Takes every edit for the record at once, rather than one field at a time:
 * two knobs share `playerlevels.dbr`, and building a record per field left the
 * archive with two entries of the same name, of which the reader keeps only
 * the last.
 */
function withValues(rec: RawArzRecord, edits: ReadonlyMap<string, number | string>): RawArzRecord {
  const replaced = new Set<string>();
  const fields = rec.fields.map((f) => {
    const value = edits.get(f.key);
    if (value === undefined) return f;
    replaced.add(f.key);
    // Through the field's own type on the way in. A float field holds 2.7 as
    // `2.700000047683716`, so an expectation carrying the JS number would fail
    // `verify` against an archive that is in fact correct — which is exactly
    // what it did, and exactly what the gate is for.
    return { ...f, values: [typeof value === 'number' ? encodeAs(f.type, value) : value] };
  });
  // A field the record does not have yet is appended. `patchArzValues` cannot
  // do this — it overwrites values in place and throws for a key that is not
  // there — which is why a record gaining a field goes through
  // `replaceArzRecords` instead. The container highlight is the case: a chest
  // that has never glowed has no `IdleEffect` to overwrite.
  for (const [key, value] of edits) {
    if (replaced.has(key)) continue;
    fields.push({ key, type: typeof value === 'string' ? STRING_FIELD : INT_FIELD, values: [value] });
  }
  return { ...rec, fields };
}

/** Where the change goes, by the convention the game itself follows. */
export function targetArchivePath(gameDir: string, target: GameDataTarget): string {
  if (target.kind === 'campaign') return join(gameDir, 'mods', BASE_MOD_ARCHIVE);
  return resolveModArchive(gameDir, target.mod)?.archivePath ?? modArchivePath(gameDir, target.mod);
}

/** Everywhere this change could go on this install, in the order a chooser should offer them. */
export function gameDataTargets(gameDir: string): { target: GameDataTarget; label: string; exists: boolean }[] {
  const campaign = targetArchivePath(gameDir, { kind: 'campaign' });
  const out = [{ target: { kind: 'campaign' } as GameDataTarget, label: 'Campaign', exists: readable(campaign) }];
  for (const mod of listMods(gameDir)) {
    out.push({ target: { kind: 'mod', mod: mod.name } as GameDataTarget, label: mod.name, exists: true });
  }
  return out;
}

function readable(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Work out the edit and build the archive. `output` is present only when
 * nothing refused, and nothing here writes to disk.
 */
export function planGameData(input: GameDataPlanInput): GameDataPlan {
  const { gameDir, knobs } = input;
  const target = input.target ?? { kind: 'campaign' };

  const sweepsAsked = input.sweeps ?? {};

  const refusals: GameDataRefusal[] = [];
  const changes: GameDataChange[] = [];
  const untouched: GameDataUntouched[] = [];
  const sweeps: GameDataSweepChange[] = [];

  const plan: GameDataPlan = {
    target,
    arzPath: targetArchivePath(gameDir, target),
    action: 'create',
    changes,
    untouched,
    sweeps,
    refusals,
    drifted: false,
    ...(target.kind === 'campaign' ? { launchHint: '/basemods' } : {}),
  };

  const asked = KNOB_NAMES.filter((name) => knobs[name] !== undefined);
  const sweepNames = SWEEP_NAMES.filter((name) => sweepsAsked[name] !== undefined && sweepsAsked[name] !== false);
  if (!asked.length && !sweepNames.length) {
    // Not `nothing-to-change`: that one means the numbers are already where
    // they were asked to be, which is a different sentence and a different
    // thing to tell somebody.
    refusals.push({ kind: 'nothing-asked-for' });
    return plan;
  }
  if (sweepNames.length && !input.index) {
    refusals.push({ kind: 'sweep-index-missing' });
    return plan;
  }

  for (const name of asked) {
    const { min, max } = KNOBS[name];
    const value = knobs[name]!;
    if (!Number.isFinite(value) || value < min || value > max) {
      refusals.push({ kind: 'value-out-of-range', knob: name, value, min, max });
    }
  }
  for (const name of sweepNames) {
    const spec = SWEEPS[name];
    if (spec.adds) continue; // a yes/no has no range to be outside of
    const value = sweepsAsked[name] as number;
    if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
      refusals.push({ kind: 'sweep-out-of-range', sweep: name, value, min: spec.min, max: spec.max });
    }
  }

  // The mod is resolved before anything is read: a name that is not installed
  // would otherwise fall through to editing the campaign instead, which is a
  // different file and a different game.
  let modArchive: string | undefined;
  if (target.kind === 'mod') {
    const found = resolveModArchive(gameDir, target.mod);
    if (!found) {
      refusals.push({ kind: 'target-mod-missing', mod: target.mod, installed: listMods(gameDir).map((m) => m.name) });
    } else {
      modArchive = found.archivePath;
      plan.arzPath = found.archivePath;
    }
  }
  if (refusals.length) return plan;

  // Only the records the knobs that were actually named live on. A speed-only
  // build never looks for `playerlevels.dbr`, so it can never refuse for a
  // record it has no business needing.
  const records = recordsForKnobs(knobs);
  const wanted = new Set(records);

  // The archive being edited, if it is there at all.
  let existing: Buffer | undefined;
  let held = new Map<string, RawArzRecord>();
  try {
    existing = readFileSync(plan.arzPath);
  } catch {
    existing = undefined; // a campaign base mod nobody has made yet
  }
  if (existing) {
    plan.action = 'patch';
    try {
      held = readArzRaw(existing, { filter: (r) => wanted.has(r) });
    } catch (err) {
      refusals.push({ kind: 'target-unreadable', path: plan.arzPath, detail: (err as Error).message });
      return plan;
    }
  }

  // What the target already holds for the sweep records. Read with only the
  // fields the rules ask about: there can be ten thousand of these, and a whole
  // record apiece is fifty times more object than the question needs. They are
  // never written back from here — the build re-reads in full whatever it has
  // to carry.
  const sweepFields = new Set(sweepNames.flatMap((n) => [...SWEEPS[n].fields]));
  const sweepPaths = new Set<string>();
  for (const name of sweepNames) for (const p of Object.keys(input.index!.rules[SWEEPS[name].rule])) sweepPaths.add(p);
  const sweepHeld = new Map<string, RawArzRecord>();
  if (existing && sweepPaths.size) {
    try {
      for (const [k, v] of readArzRaw(existing, { filter: (r) => sweepPaths.has(r), fields: sweepFields })) {
        sweepHeld.set(k, v);
      }
    } catch (err) {
      refusals.push({ kind: 'target-unreadable', path: plan.arzPath, detail: (err as Error).message });
      return plan;
    }
  }

  // Last wins, per record — the same merge the game does, and the reason each
  // winner remembers which archive it came from. The target's own records go
  // last, because they are the ones that game reads.
  const winners = new Map<string, { record: RawArzRecord; archive: string }>();
  const archives: { expansion: string; path: string }[] = gameArchives(gameDir).map((a) => ({
    expansion: a.expansion,
    path: a.path,
  }));
  if (modArchive && target.kind === 'mod') archives.push({ expansion: target.mod, path: modArchive });
  for (const archive of archives) {
    let raw: Map<string, RawArzRecord>;
    try {
      raw = readArzRaw(readFileSync(archive.path), { filter: (r) => wanted.has(r) });
    } catch {
      continue; // an archive this install does not have
    }
    for (const [key, record] of raw) winners.set(key, { record, archive: archive.expansion || 'base' });
  }
  if (target.kind === 'campaign') {
    for (const [key, record] of held) winners.set(key, { record, archive: `mods/${BASE_MOD_ARCHIVE}` });
  }

  // A level cap the game has no per-level skill point entry for is refused
  // rather than written. The length is read out of the merged record, because
  // it is the mod's table that decides, not a number from this file.
  if (knobs.maxLevel !== undefined) {
    const levels = winners.get(PLAYER_LEVELS_RECORD);
    const table = levels?.record.fields.find((f) => f.key === SKILL_TABLE_FIELD);
    if (table && knobs.maxLevel > table.values.length) {
      refusals.push({ kind: 'level-above-skill-table', value: knobs.maxLevel, entries: table.values.length });
      return plan;
    }
  }

  const markKey = (record: string, field: string) => `${record.toLowerCase()} ${field.toLowerCase()}`;
  const marks = new Map((input.baseline ?? []).map((b) => [markKey(b.record, b.field), b]));

  /** The new values this build settled on, grouped by the record they live in. */
  const perRecord = new Map<string, Map<string, number>>();
  const baseline: GameDataBaseline[] = [];
  const considered = new Set<string>();

  for (const name of asked) {
    const knob = KNOBS[name];
    const wantedValue = knobs[name]!;

    for (const path of knob.records) {
      const found = winners.get(path);
      if (!found) {
        refusals.push({ kind: 'record-missing', record: path });
        continue;
      }
      const stored = found.record.fields.find((f) => f.key === knob.field);
      const current = stored?.values[0];
      if (stored === undefined || typeof current !== 'number') {
        refusals.push({ kind: 'field-missing', record: path, field: knob.field });
        continue;
      }

      const mark = marks.get(markKey(path, knob.field));
      const stillOurs = mark !== undefined && encodeAs(stored.type, mark.written) === current;
      if (mark !== undefined && !stillOurs) plan.drifted = true;
      const original = stillOurs ? encodeAs(stored.type, mark.original) : current;
      const to =
        knob.mode === 'absolute'
          ? encodeAs(stored.type, wantedValue)
          : wantedValue === 0
            ? original
            : encodeAs(stored.type, original * (1 + wantedValue / 100));

      considered.add(markKey(path, knob.field));
      baseline.push({ record: path, field: knob.field, original, written: to });

      if (to === current) {
        untouched.push({ knob: name, record: path, field: knob.field, value: current, sourceArchive: found.archive });
        continue;
      }

      changes.push({
        knob: name,
        record: path,
        field: knob.field,
        from: current,
        to,
        original,
        sourceArchive: found.archive,
        how: held.has(path) ? 'overwrite' : 'add',
      });

      const forRecord = perRecord.get(path);
      if (forRecord) forRecord.set(knob.field, to);
      else perRecord.set(path, new Map([[knob.field, to]]));
    }
  }

  // ---------------------------------------------------------------------
  // Sweeps: one value across every record a rule selected.
  // ---------------------------------------------------------------------
  //
  // No baseline is written for these. A percentage needs one because it
  // compounds; an absolute value set on ten thousand records does not, and
  // keeping ten thousand originals would put about a megabyte of them in
  // settings.json to serve an undo the archive backup already provides.
  const sweepEdits = new Map<string, Map<string, number | string>>();
  for (const name of sweepNames) {
    const spec = SWEEPS[name];
    const selection = input.index!.rules[spec.rule];
    const to: number | string = spec.adds ? CONTAINER_HIGHLIGHT_FX : (sweepsAsked[name] as number);

    let changing = 0;
    let already = 0;
    let adding = 0;
    // The spread of the records that will move…
    let lo = Infinity;
    let hi = -Infinity;
    // …and of every record the rule picked, which is what there is to say when
    // none of them will.
    const held = { lo: Infinity, hi: -Infinity };

    for (const path of Object.keys(selection)) {
      // The target's own copy wins when it has one — it is what the game reads.
      const inTarget = sweepHeld.get(path);
      const stored = inTarget?.fields.find((f) => f.key === spec.fields[0]!);
      const current = stored ? stored.values[0] : selection[path];

      if (spec.adds) {
        // Only records that have no highlight yet: one that already glows is
        // already doing the thing being asked for.
        if (current !== null && current !== undefined) {
          already++;
          continue;
        }
      } else {
        if (typeof current === 'number') {
          held.lo = Math.min(held.lo, current);
          held.hi = Math.max(held.hi, current);
        }
        // At or above what was asked for is already doing the job, when the
        // sweep only ever raises.
        if (
          current === Math.fround(to as number) ||
          current === to ||
          (spec.raiseOnly && typeof current === 'number' && current >= (to as number))
        ) {
          already++;
          continue;
        }
        // The reported range covers only the records that will actually move.
        // Spanning the whole selection made the row read `250–500 → 250` — a
        // promise to pull down the one record already showing from farther,
        // which is the opposite of what a raise-only sweep does.
        if (typeof current === 'number') {
          lo = Math.min(lo, current);
          hi = Math.max(hi, current);
        }
      }

      changing++;
      if (!inTarget) adding++;
      const forRecord = sweepEdits.get(path) ?? new Map<string, number | string>();
      for (const f of spec.fields) forRecord.set(f, to);
      sweepEdits.set(path, forRecord);
    }

    const span = (a: number, b: number) => (a === Infinity ? 'unknown' : a === b ? String(round4(a)) : `${round4(a)}–${round4(b)}`);
    sweeps.push({
      sweep: name,
      to,
      from: spec.adds ? (changing ? 'absent' : 'already set') : changing ? span(lo, hi) : span(held.lo, held.hi),
      changing,
      already,
      adding,
    });
  }

  const sweepChanging = sweeps.reduce((n, s) => n + s.changing, 0);
  if (!changes.length && !sweepChanging && !refusals.length) refusals.push({ kind: 'nothing-to-change' });
  if (refusals.length) return plan;

  // The plan is complete as a *description* now. Building the archive is the
  // expensive half — a sweep recompresses thousands of records and `verify`
  // reads every one of them back — and the window re-plans on every keystroke,
  // so it asks for the description and leaves the bytes until the moment it
  // writes. The commit path builds, verifies, and refuses exactly as before;
  // nothing is written that was not read back first.
  if (input.build === false) return plan;

  // A mark this build never looked at is still true, and dropping it would let
  // the next percentage measure from this tool's own output. Carried first, so
  // anything reconsidered above overwrites it.
  const carried = (input.baseline ?? []).filter((b) => !considered.has(markKey(b.record, b.field)));

  // One edit set per record, so a record with two changed fields is appended
  // once carrying both rather than twice carrying one each.
  const edits: ArzValueEdit[] = [];
  const additions: RawArzRecord[] = [];
  const replacements: RawArzRecord[] = [];
  const expected = new Map<string, RawArzRecord>();
  for (const [path, values] of perRecord) {
    const inTarget = held.get(path);
    if (inTarget) {
      for (const [field, value] of values) edits.push({ record: path, field, value });
      expected.set(path, withValues(inTarget, values));
    } else {
      const added = withValues(winners.get(path)!.record, values);
      additions.push(added);
      expected.set(path, added);
    }
  }

  /**
   * What `verify` will require of a swept record.
   *
   * The named knobs hand it whole records and it compares them field for field,
   * which is the strongest check available and cheap for three of them. Ten
   * thousand is a different question: holding every built record until the read
   * back was most of this build's memory, and comparing two hundred fields
   * apiece to prove that one changed is work the prefix memcmp already does —
   * every byte that was not meant to move is checked to be where it was.
   *
   * So a swept record is checked on **the fields it was swept for**, and a
   * bounded sample is checked in full as well, which is what would catch an
   * encoder that had drifted.
   */
  const sweepExpected = new Map<string, Map<string, number | string>>();
  const SAMPLE = 25;
  let sampled = 0;
  const noteSweepExpectation = (
    path: string,
    base: RawArzRecord,
    values: ReadonlyMap<string, number | string>,
    /** Whether `base` carries every field, or only the ones the rules read. */
    whole: boolean,
  ) => {
    const want = new Map<string, number | string>();
    for (const [field, value] of values) {
      const f = base.fields.find((x) => x.key === field);
      want.set(field, typeof value === 'number' && f ? encodeAs(f.type, value) : value);
    }
    sweepExpected.set(path, want);
    // Only ever from a record read in full: a partial one would tell `verify` to
    // expect the two fields the rules looked at and nothing else, and it would
    // duly refuse the forty-two that are correctly there.
    if (whole && sampled < SAMPLE) {
      expected.set(path, withValues(base, values));
      sampled++;
    }
  };

  // The sweeps, now that bytes are actually being made.
  //
  // Three ways in, and which one applies is decided per record: a value already
  // in the target is patched in place, a record the target lacks is appended
  // whole, and a record that is there but has no such field has to be *replaced*
  // whole, because an in-place patch cannot make a field that is not there.
  if (sweepEdits.size) {
    const needWhole = new Set<string>();
    for (const [path, values] of sweepEdits) {
      const inTarget = sweepHeld.get(path);
      if (!inTarget || [...values.keys()].some((f) => !inTarget.fields.some((x) => x.key === f))) needWhole.add(path);
    }

    // Read in full only those — `sweepHeld` was read with a field whitelist and
    // is a partial record, which would be a catastrophe to write back.
    const whole = new Map<string, RawArzRecord>();
    if (needWhole.size) {
      for (const archive of archives) {
        try {
          for (const [k, v] of readArzRaw(readFileSync(archive.path), { filter: (r) => needWhole.has(r) })) {
            whole.set(k, v);
          }
        } catch {
          continue;
        }
      }
      // The target last, for the same reason the merge puts it last.
      if (existing) {
        for (const [k, v] of readArzRaw(existing, { filter: (r) => needWhole.has(r) })) whole.set(k, v);
      }
    }

    for (const [path, values] of sweepEdits) {
      const inTarget = sweepHeld.get(path);
      if (!needWhole.has(path)) {
        for (const [field, value] of values) edits.push({ record: path, field, value: value as number });
        noteSweepExpectation(path, inTarget!, values, false);
        continue;
      }
      const base = whole.get(path);
      if (!base) {
        refusals.push({ kind: 'record-missing', record: path });
        continue;
      }
      const built = withValues(base, values);
      if (inTarget) replacements.push(built);
      else additions.push(built);
      noteSweepExpectation(path, built, values, true);
    }
    if (refusals.length) return plan;
  }

  let output: Buffer;
  try {
    if (existing) {
      output = edits.length ? patchArzValues(existing, edits) : existing;
      if (replacements.length) output = replaceArzRecords(output, replacements);
      if (additions.length) output = appendArzRecords(output, additions);
    } else {
      output = writeArz([...additions, ...replacements]);
    }
  } catch (err) {
    // An edit the archive will not take is a refusal, not a thrown stack: the
    // caller is about to overwrite somebody's mod with whatever this returns.
    // Distinct from `verify-mismatch`, which means it *was* built and then did
    // not read back — telling somebody their archive does not round-trip when
    // in fact the edit never applied sends them looking in the wrong place.
    refusals.push({ kind: 'build-failed', detail: (err as Error).message });
    return plan;
  }

  const detail = verify(output, existing, expected, additions.length, sweepExpected);
  if (detail) {
    refusals.push({ kind: 'verify-mismatch', detail });
    return plan;
  }
  plan.output = output;
  plan.baseline = [...carried, ...baseline];
  return plan;
}

/**
 * The gate the save writer has, in the only form this format allows.
 *
 * Read the archive back with the ordinary reader and require it to say what it
 * was meant to say — and, when it was built by editing one that already
 * existed, require every byte that was not meant to move to still be where it
 * was. An encoder that has drifted from its decoder fails here rather than
 * replacing 79 MB of somebody's mod with a file the game will not load.
 */
function verify(
  output: Buffer,
  source: Buffer | undefined,
  expected: ReadonlyMap<string, RawArzRecord>,
  added: number,
  sweptFields?: ReadonlyMap<string, ReadonlyMap<string, number | string>>,
): string | undefined {
  const recordTableStart = output.readUInt32LE(4);
  const recordTableSize = output.readUInt32LE(8);
  const recordCount = output.readUInt32LE(12);
  const stringTableStart = output.readUInt32LE(16);
  const stringTableSize = output.readUInt32LE(20);

  // The regions have to meet exactly, which is the arithmetic every offset in
  // the file depends on.
  if (recordTableStart + recordTableSize !== stringTableStart) {
    return `the record table ends at ${recordTableStart + recordTableSize}, the string table starts at ${stringTableStart}`;
  }
  if (stringTableStart + stringTableSize > output.length) {
    return `the string table runs ${stringTableStart + stringTableSize - output.length} bytes past the end of the file`;
  }

  if (source) {
    const sourceData = source.readUInt32LE(4);
    if (!output.subarray(24, sourceData).equals(source.subarray(24, sourceData))) {
      return 'a block that was already in the archive has moved';
    }
    if (recordCount !== source.readUInt32LE(12) + added) {
      return `${source.readUInt32LE(12)} records in, ${recordCount} out, ${added} added`;
    }
    const wasTail = source.length - (source.readUInt32LE(16) + source.readUInt32LE(20));
    const nowTail = output.length - (stringTableStart + stringTableSize);
    if (wasTail !== nowTail) return `the ${wasTail} bytes after the string table became ${nowTail}`;
  }

  let readBack: Map<string, RawArzRecord>;
  try {
    // The filter is consulted for every entry in the table, so this walks all of
    // it — a name index that no longer resolves throws here — and decompresses
    // only the records that were touched.
    readBack = readArzRaw(output, { filter: (r) => expected.has(r) });
  } catch (err) {
    return `the archive just written does not read back: ${(err as Error).message}`;
  }
  if (readBack.size !== expected.size) return `${expected.size} records went in, ${readBack.size} came out`;

  for (const [path, want] of expected) {
    const after = readBack.get(path);
    if (!after) return `${path}: missing from the archive just written`;
    if (after.type !== want.type) return `${path}: template class changed (${want.type} → ${after.type})`;
    if (after.fileTime !== want.fileTime) return `${path}: timestamp changed`;
    if (after.fields.length !== want.fields.length) {
      return `${path}: ${want.fields.length} fields in, ${after.fields.length} out`;
    }
    for (const [i, was] of want.fields.entries()) {
      const now = after.fields[i]!;
      if (now.key !== was.key) return `${path}: field ${i} is ${now.key}, expected ${was.key}`;
      if (now.type !== was.type) return `${path}.${was.key}: type ${was.type} → ${now.type}`;
      if (now.values.length !== was.values.length) {
        return `${path}.${was.key}: ${was.values.length} values in, ${now.values.length} out`;
      }
      for (const [j, value] of was.values.entries()) {
        if (now.values[j] !== value) {
          return `${path}.${was.key}[${j}]: wrote ${String(now.values[j])}, meant ${String(value)}`;
        }
      }
    }
  }

  // The swept records: every one of them, on the fields it was swept for. Read
  // with a field whitelist, in batches, so proving ten thousand records right
  // costs a bounded amount of memory rather than a copy of all of them.
  if (sweptFields?.size) {
    const keys = new Set<string>();
    for (const want of sweptFields.values()) for (const k of want.keys()) keys.add(k);
    const paths = [...sweptFields.keys()];
    const BATCH = 2000;
    for (let i = 0; i < paths.length; i += BATCH) {
      const slice = new Set(paths.slice(i, i + BATCH));
      let readBackSlice: Map<string, RawArzRecord>;
      try {
        readBackSlice = readArzRaw(output, { filter: (r) => slice.has(r), fields: keys });
      } catch (err) {
        return `the archive just written does not read back: ${(err as Error).message}`;
      }
      for (const path of slice) {
        const after = readBackSlice.get(path);
        if (!after) return `${path}: missing from the archive just written`;
        for (const [key, value] of sweptFields.get(path)!) {
          const got = after.fields.find((f) => f.key === key)?.values[0];
          if (got !== value) return `${path}.${key}: wrote ${String(got)}, meant ${String(value)}`;
        }
      }
    }
  }
  return undefined;
}
