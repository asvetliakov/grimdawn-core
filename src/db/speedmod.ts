/**
 * Changing how fast the character walks, in the archive the game actually loads.
 *
 * Movement speed is two numbers in the game's own records: the player's base
 * rate (`characterRunSpeed`, 0.93 on the two player creature records) and the
 * ceiling that `+% movement speed` gear counts up to (`playerRunSpeedCapMax`,
 * 135 on the engine record, and 500 in Path of Grim Dawn). Changing them is a
 * data change, not a save edit — it is true of every character, including ones
 * made later.
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
 * already has gets that one value overwritten, a record it lacks is added, and
 * every other byte of the file is carried over as it was. An archive edited
 * that way is confirmed to load, both as a base mod and as a Custom Game one.
 * Nothing here touches the disk — the caller backs the archive up, and writes.
 *
 * The `baseline` is what keeps this honest across builds. Editing in place
 * means the next read sees this tool's own output, so a percentage would
 * compound: +30% of 500 is 650, and +30% again would be 845. Each build records
 * what a field held *before* it first wrote there and what it wrote, and the
 * next one measures from the first of those — while the second still matches,
 * which is how a mod updated underneath is noticed rather than re-based
 * silently.
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
  readArzRaw,
  writeArz,
  type ArzValueEdit,
  type RawArzRecord,
} from './arz.js';
import { gameArchives } from './gamefiles.js';
import { listMods, modArchivePath, resolveModArchive } from './mods.js';

/** The player creature records — one per gender, identical in every field that matters here. */
const PLAYER_RECORDS = ['records/creatures/pc/malepc01.dbr', 'records/creatures/pc/femalepc01.dbr'];
const ENGINE_RECORD = 'records/game/gameengine.dbr';

const RUN_SPEED_FIELD = 'characterRunSpeed';
const RUN_CAP_FIELD = 'playerRunSpeedCapMax';

/** The archive `/basemods` loads for the main campaign: loose in `mods/`, and named for nobody. */
export const BASE_MOD_ARCHIVE = 'database.arz';

export const SPEED_MOD_RECORDS = [...PLAYER_RECORDS, ENGINE_RECORD];

/** Which archive the change goes into. */
export type SpeedModTarget = { kind: 'campaign' } | { kind: 'mod'; mod: string };

export interface SpeedModChange {
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

/** A field left exactly where it already is. */
export interface SpeedModUntouched {
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
 * still holds it, `original` is what the percentages mean. When it does not,
 * the mod has been updated or something else edited it, and what is there now
 * is the new original.
 */
export interface SpeedModBaseline {
  record: string;
  field: string;
  original: number;
  written: number;
}

export type SpeedModRefusal =
  | { kind: 'record-missing'; record: string }
  | { kind: 'field-missing'; record: string; field: string }
  /** Both percentages leave every field where it already is. */
  | { kind: 'nothing-to-change' }
  /** Below -100% a character walks backwards, and at -100% it does not walk. */
  | { kind: 'percent-out-of-range'; which: 'run' | 'cap'; percent: number }
  /** The mod named as the target is not installed. */
  | { kind: 'target-mod-missing'; mod: string; installed: string[] }
  /** The archive to be edited is there and cannot be read. */
  | { kind: 'target-unreadable'; path: string; detail: string }
  | { kind: 'verify-mismatch'; detail: string };

export interface SpeedModPlan {
  target: SpeedModTarget;
  /** The archive that will be written. */
  arzPath: string;
  /** `patch` merges into an archive that is already there; `create` writes a new one. */
  action: 'patch' | 'create';
  changes: SpeedModChange[];
  untouched: SpeedModUntouched[];
  refusals: SpeedModRefusal[];
  /** The archive bytes. Present only when `refusals` is empty. */
  output?: Buffer;
  /** What to remember, so the next build measures from the same place. Present with `output`. */
  baseline?: SpeedModBaseline[];
  /**
   * Set when a field no longer holds what this tool last wrote there — the mod
   * was updated, or something else edited it. What is there now is treated as
   * the original, and saying so is better than quietly re-basing.
   */
  drifted: boolean;
  /** What to put in Steam's launch options. Only the campaign needs one. */
  launchHint?: string;
}

export interface SpeedModPlanInput {
  gameDir: string;
  /** Defaults to the campaign — `mods/database.arz`. */
  target?: SpeedModTarget;
  /**
   * Percentage added to the base run speed.
   *
   * Always relative to `original`, never to what the archive holds now, so
   * building at +30% twice is +30% rather than +69%. Negative slows the
   * character down, which is a real thing to want: these two numbers are a
   * ceiling as much as a floor, and someone playing a mod that has already
   * raised them may want them back. At or below -100% it is refused rather than
   * clamped.
   *
   * 0 means *leave this one where it started*: no edit at all when nothing has
   * moved it, and a change back to `original` when a previous build did.
   */
  runPercent?: number;
  /** Percentage added to the movement-speed cap. Defaults to `runPercent`. */
  capPercent?: number;
  /** What a previous build recorded — for this same target, or not at all. */
  baseline?: readonly SpeedModBaseline[];
}

/** The stored `u16` type word for a float field. */
const FLOAT_FIELD = 1;

/** A value in the field's own type: `1.35 × 0.93` as float32, or a rounded int. */
function encodeAs(type: number, value: number): number {
  return type === FLOAT_FIELD ? Math.fround(value) : Math.round(value);
}

/** The same record with one single-valued field replaced. */
function withValue(rec: RawArzRecord, field: string, value: number): RawArzRecord {
  return {
    ...rec,
    fields: rec.fields.map((f) => (f.key === field ? { ...f, values: [value] } : f)),
  };
}

/** Where the change goes, by the convention the game itself follows. */
export function targetArchivePath(gameDir: string, target: SpeedModTarget): string {
  if (target.kind === 'campaign') return join(gameDir, 'mods', BASE_MOD_ARCHIVE);
  return resolveModArchive(gameDir, target.mod)?.archivePath ?? modArchivePath(gameDir, target.mod);
}

/** Everywhere this change could go on this install, in the order a chooser should offer them. */
export function speedModTargets(gameDir: string): { target: SpeedModTarget; label: string; exists: boolean }[] {
  const campaign = targetArchivePath(gameDir, { kind: 'campaign' });
  const out = [{ target: { kind: 'campaign' } as SpeedModTarget, label: 'Campaign', exists: readable(campaign) }];
  for (const mod of listMods(gameDir)) {
    out.push({ target: { kind: 'mod', mod: mod.name } as SpeedModTarget, label: mod.name, exists: true });
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
export function planSpeedMod(input: SpeedModPlanInput): SpeedModPlan {
  const { gameDir, runPercent = 35 } = input;
  const target = input.target ?? { kind: 'campaign' };
  const capPercent = input.capPercent ?? runPercent;

  const refusals: SpeedModRefusal[] = [];
  const changes: SpeedModChange[] = [];
  const untouched: SpeedModUntouched[] = [];

  const plan: SpeedModPlan = {
    target,
    arzPath: targetArchivePath(gameDir, target),
    action: 'create',
    changes,
    untouched,
    refusals,
    drifted: false,
    ...(target.kind === 'campaign' ? { launchHint: '/basemods' } : {}),
  };

  for (const [which, percent] of [
    ['run', runPercent],
    ['cap', capPercent],
  ] as const) {
    if (!Number.isFinite(percent) || percent <= -100) refusals.push({ kind: 'percent-out-of-range', which, percent });
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

  const wanted = new Set(SPEED_MOD_RECORDS);

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

  const marks = new Map((input.baseline ?? []).map((b) => [`${b.record.toLowerCase()} ${b.field.toLowerCase()}`, b]));
  const edits: ArzValueEdit[] = [];
  const additions: RawArzRecord[] = [];
  const expected = new Map<string, RawArzRecord>();
  const baseline: SpeedModBaseline[] = [];

  for (const path of SPEED_MOD_RECORDS) {
    const found = winners.get(path);
    if (!found) {
      refusals.push({ kind: 'record-missing', record: path });
      continue;
    }
    const field = path === ENGINE_RECORD ? RUN_CAP_FIELD : RUN_SPEED_FIELD;
    const percent = path === ENGINE_RECORD ? capPercent : runPercent;

    const stored = found.record.fields.find((f) => f.key === field);
    const current = stored?.values[0];
    if (stored === undefined || typeof current !== 'number') {
      refusals.push({ kind: 'field-missing', record: path, field });
      continue;
    }

    const mark = marks.get(`${path.toLowerCase()} ${field.toLowerCase()}`);
    const stillOurs = mark !== undefined && encodeAs(stored.type, mark.written) === current;
    if (mark !== undefined && !stillOurs) plan.drifted = true;
    const original = stillOurs ? encodeAs(stored.type, mark.original) : current;
    const to = percent === 0 ? original : encodeAs(stored.type, original * (1 + percent / 100));

    baseline.push({ record: path, field, original, written: to });

    if (to === current) {
      untouched.push({ record: path, field, value: current, sourceArchive: found.archive });
      continue;
    }

    const inTarget = held.get(path);
    changes.push({
      record: path,
      field,
      from: current,
      to,
      original,
      sourceArchive: found.archive,
      how: inTarget ? 'overwrite' : 'add',
    });
    if (inTarget) {
      edits.push({ record: path, field, value: to });
      expected.set(path, withValue(inTarget, field, to));
    } else {
      const added = withValue(found.record, field, to);
      additions.push(added);
      expected.set(path, added);
    }
  }

  if (!changes.length) refusals.push({ kind: 'nothing-to-change' });
  if (refusals.length) return plan;

  let output: Buffer;
  try {
    if (existing) {
      output = edits.length ? patchArzValues(existing, edits) : existing;
      if (additions.length) output = appendArzRecords(output, additions);
    } else {
      output = writeArz(additions);
    }
  } catch (err) {
    // An edit the archive will not take is a refusal, not a thrown stack: the
    // caller is about to overwrite somebody's mod with whatever this returns.
    refusals.push({ kind: 'verify-mismatch', detail: (err as Error).message });
    return plan;
  }

  const detail = verify(output, existing, expected, additions.length);
  if (detail) {
    refusals.push({ kind: 'verify-mismatch', detail });
    return plan;
  }
  plan.output = output;
  plan.baseline = baseline;
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
  return undefined;
}
