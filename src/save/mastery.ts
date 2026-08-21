/**
 * Removing a mastery from a character.
 *
 * Grim Dawn refunds every point you spent in a mastery and then keeps the
 * mastery: the last point in the bar cannot be taken back, and a second mastery
 * cannot be swapped. So this edits `player.gdc` — the only thing in this tool
 * that writes a save.
 *
 * Three regions change: the header's class tag, block 2's unspent skill points,
 * and block 8's skill list. Everything between and after them is re-enciphered
 * from the recorded transcript, which is why `gdc.ts` decodes all fifteen
 * blocks rather than the seven the rest of the app reads.
 *
 * Every check here reports rather than repairs. A plan with any refusal on it
 * is not written, and `roundtripMismatch` means we could not even reproduce the
 * file we were about to edit — the strongest of them, and the cheapest.
 */

import type { GameDb } from '../db/types.js';
import { saveEditRefusals, type SaveEditRefusal } from './edit.js';
import { encodeBlock2, encodeBlock8, encodeHeader } from './gdc.js';
import { replay, spliceRegion, type Seg, type Transcript } from './transcript.js';
import type { CharacterSave, CharacterSkill } from './types.js';

/**
 * `records/skills/playerclass04/…` and `records/skills/playerclassmonk/…` — the
 * capture is the **class key**, which is the directory and nothing else.
 *
 * The base game numbers its ten classes and a mod names its own, so the key is
 * a number for one and a word for the other. That is all the path can tell us:
 * the *class number* a mod's mastery occupies in the class tag is a fact about
 * the mod's database, not about the path, and is resolved separately below.
 *
 * The bar test carries no capture on purpose. Path of Grim Dawn ships
 * `playerclassrunewords/_classtraining_runewords.dbr` — the filename does not
 * repeat the word "class" — so a filename read as an identifier is wrong before
 * it is unhelpful. The directory decides membership; the filename only says
 * which entry in it is the bar.
 */
const MASTERY_PATH = /^records\/skills\/playerclass([^/]+)\//i;
const MASTERY_BAR = /\/_classtraining_[^/]*\.dbr$/i;

export interface MasteryRef {
  /** The `_classtraining_*.dbr` record. */
  record: string;
  /**
   * The directory that decides membership: `04` for `playerclass04`, `monk` for
   * `playerclassmonk`. Always known, because the save itself carries it.
   */
  classKey: string;
  /**
   * The two-digit number this mastery takes in the class tag. Absent when only
   * the mod that defines the mastery knows it and that database was not loaded.
   */
  classNumber?: string;
  name?: string;
  /** Rank of the mastery bar itself: 1 for a fully respecced mastery. */
  barLevel: number;
  /** Entries in block 8 belonging to this mastery, the bar included. */
  entryCount: number;
  /** Skill points sunk into it, the bar included. */
  pointsInvested: number;
}

/**
 * What stands in the way of *naming* the classes an edit would rewrite the tag
 * from. Shared by both planners: neither may write a class tag it had to guess
 * at any part of.
 */
export type MasteryModelRefusal =
  | { kind: 'unknown-class-number'; record: string }
  | { kind: 'class-tag-mismatch'; expected: string; actual: string }
  | { kind: 'class-number-conflict'; record: string; fromPath: string; fromDb: string };

/** The file-level refusals (`edit.ts`) plus the three this operation adds. */
export type MasteryRemovalRefusal =
  | SaveEditRefusal
  | MasteryModelRefusal
  | { kind: 'unknown-mastery'; record: string }
  | { kind: 'last-mastery' }
  | { kind: 'mastery-not-reset'; entryCount: number; pointsInvested: number };

export interface MasteryRemovalPlan {
  character: string;
  mastery: MasteryRef;
  /** Every block-8 entry that goes, the bar included. */
  removed: { record: string; name?: string; level: number }[];
  skillPointsBefore: number;
  skillPointsRefunded: number;
  skillPointsAfter: number;
  classRecordBefore: string;
  classRecordAfter: string;
  classNameBefore: string;
  classNameAfter: string;
  remaining: MasteryRef[];
  /** Hot slots and auto-cast bindings naming a removed skill. Expected empty. */
  danglingReferences: string[];
  refusals: MasteryRemovalRefusal[];
  /** The edited file, when there is nothing standing in the way of writing it. */
  output?: Buffer;
}

/** The class key of any record inside a mastery tree, bar included. */
export function masteryClassKey(record: string): string | undefined {
  return MASTERY_PATH.exec(record)?.[1];
}

function belongsTo(record: string, classKey: string): boolean {
  return MASTERY_PATH.exec(record)?.[1]?.toLowerCase() === classKey.toLowerCase();
}

/** The number a numeric class key stands for; a mod's key stands for nothing. */
function numberFromKey(classKey: string): string | undefined {
  return /^\d+$/.test(classKey) ? classKey.padStart(2, '0') : undefined;
}

/**
 * The character's masteries, read off block 8 rather than off any stored field
 * — the save has none. Membership is decided by the record path and not by a
 * database lookup, because the database deliberately excludes pet subtrees and
 * would answer `undefined` for skills a character really has invested in.
 *
 * The database is asked one thing only, and only when it is there: what number
 * a mastery takes in the class tag. A numbered class answers that from its own
 * path; a mod's does not, and a `classNumber` left `undefined` here is what
 * makes the refusal downstream honest rather than a guess.
 */
export function characterMasteries(save: CharacterSave, db?: GameDb): MasteryRef[] {
  const byClass = new Map<string, CharacterSkill[]>();
  for (const entry of save.skillEntries) {
    const cls = MASTERY_PATH.exec(entry.record)?.[1];
    if (!cls) continue;
    const list = byClass.get(cls);
    if (list) list.push(entry);
    else byClass.set(cls, [entry]);
  }

  const out: MasteryRef[] = [];
  for (const [classKey, entries] of byClass) {
    const bar = entries.find((e) => MASTERY_BAR.test(e.record));
    if (!bar) continue; // invested skills with no bar is not a mastery we know
    const ref: MasteryRef = {
      record: bar.record,
      classKey,
      barLevel: bar.level,
      entryCount: entries.length,
      pointsInvested: entries.reduce((n, e) => n + Math.max(0, e.level), 0),
    };
    const classNumber = db?.masteryNumber(bar.record) ?? numberFromKey(classKey);
    if (classNumber !== undefined) ref.classNumber = classNumber;
    const name = db?.getSkill(bar.record)?.name;
    if (name !== undefined) ref.name = name;
    out.push(ref);
  }
  return out.sort((a, b) => a.classKey.localeCompare(b.classKey));
}

/**
 * The class tag for a set of class numbers: two digits each, ascending,
 * concatenated. `tagSkillClassName0410` is Nightblade + Berserker (Reaver);
 * drop the Nightblade and it becomes `tagSkillClassName10`, Berserker.
 *
 * Mods follow the same rule — Path of Grim Dawn's Monk is `12` and its Tempest
 * `38`, and taking both gives `tagSkillClassName1238`, which its own text
 * archive names Windrunner. Only where the *numbers* come from differs.
 */
export function classTagFor(numbers: readonly string[]): string {
  const sorted = [...numbers].sort();
  return sorted.length ? `tagSkillClassName${sorted.join('')}` : '';
}

/**
 * Every mastery's class number, and proof that we have them all.
 *
 * The proof is the class tag itself: the numbers we resolved, recomposed, must
 * equal the tag the save already carries. If they do not, this tool is looking
 * at a character whose classes it cannot fully see — a mastery outside
 * `records/skills/playerclass…`, a number the database disagrees with — and a
 * tag rewritten from a partial view would silently *delete a mastery the
 * character keeps*. So it refuses, which is the whole reason this is checked
 * before any of the three edits rather than after.
 */
export function reconcileClassNumbers(
  masteries: readonly MasteryRef[],
  classRecord: string,
  db?: GameDb,
): { numbers?: Map<string, string>; refusals: MasteryModelRefusal[] } {
  const refusals: MasteryModelRefusal[] = [];
  const numbers = new Map<string, string>();

  for (const mastery of masteries) {
    const fromPath = numberFromKey(mastery.classKey);
    const fromDb = db?.masteryNumber(mastery.record);
    if (fromPath !== undefined && fromDb !== undefined && fromPath !== fromDb) {
      refusals.push({ kind: 'class-number-conflict', record: mastery.record, fromPath, fromDb });
      continue;
    }
    const number = fromDb ?? fromPath;
    if (number === undefined) {
      refusals.push({ kind: 'unknown-class-number', record: mastery.record });
      continue;
    }
    numbers.set(mastery.classKey, number);
  }
  if (refusals.length) return { refusals };

  const expected = classTagFor([...numbers.values()]);
  if (expected !== classRecord) {
    refusals.push({ kind: 'class-tag-mismatch', expected, actual: classRecord });
    return { refusals };
  }
  return { numbers, refusals };
}

export interface PlanInput {
  character: string;
  save: CharacterSave;
  transcript: Transcript;
  /** The bytes the save was parsed from, for the round-trip check. */
  source: Buffer;
  db?: GameDb;
  /** A mastery record path, its class key, its class number, or its name. */
  mastery: string;
}

/** Does this reference name that mastery? Record path, key, number, or name. */
function matches(mastery: MasteryRef, wanted: string): boolean {
  return (
    mastery.record.toLowerCase() === wanted ||
    mastery.classKey.toLowerCase() === wanted ||
    (mastery.classNumber !== undefined && mastery.classNumber === wanted.padStart(2, '0')) ||
    (mastery.name ?? '').toLowerCase() === wanted
  );
}

/**
 * Work out what removing a mastery would do, and whether it may be done at all.
 * The edited bytes come back on `output` only when `refusals` is empty.
 */
export function planMasteryRemoval(input: PlanInput): MasteryRemovalPlan {
  const { character, save, transcript, source, db } = input;
  const refusals: MasteryRemovalRefusal[] = [];

  const masteries = characterMasteries(save, db);
  const wanted = input.mastery.trim().toLowerCase();
  const target = masteries.find((m) => matches(m, wanted));

  const remaining = target ? masteries.filter((m) => m.classKey !== target.classKey) : masteries;
  const classRecordBefore = save.classRecord;
  const localize = (tag: string) => db?.localize(tag) ?? tag;

  // This operation always rewrites the class tag, so it always needs every
  // number — the ones it keeps as much as the one it drops.
  const { numbers, refusals: modelRefusals } = reconcileClassNumbers(masteries, classRecordBefore, db);
  // `numbers` is present only when *every* current mastery resolved, so each
  // one the character keeps is in it. A `?? ''` here would turn a hole in that
  // invariant into a plausible-looking wrong tag.
  const classRecordAfter =
    target && numbers ? classTagFor(remaining.map((m) => numbers.get(m.classKey)!)) : classRecordBefore;

  const removed = target
    ? save.skillEntries
        .filter((e) => belongsTo(e.record, target.classKey))
        .map((e) => {
          const name = db?.getSkill(e.record)?.name;
          return name === undefined ? { record: e.record, level: e.level } : { record: e.record, name, level: e.level };
        })
    : [];
  const refunded = removed.reduce((n, e) => n + Math.max(0, e.level), 0);

  // --- what stands in the way -------------------------------------------
  refusals.push(...saveEditRefusals(save, transcript, source));
  refusals.push(...modelRefusals);

  if (!target) refusals.push({ kind: 'unknown-mastery', record: input.mastery });
  else if (!remaining.length) refusals.push({ kind: 'last-mastery' });
  else if (target.entryCount > 1 || target.barLevel > 1) {
    refusals.push({
      kind: 'mastery-not-reset',
      entryCount: target.entryCount,
      pointsInvested: target.pointsInvested,
    });
  }

  const dangling = target ? danglingReferences(save, target.classKey) : [];

  const plan: MasteryRemovalPlan = {
    character,
    mastery: target ?? {
      record: input.mastery,
      classKey: '??',
      barLevel: 0,
      entryCount: 0,
      pointsInvested: 0,
    },
    removed,
    skillPointsBefore: save.attributes.skillPoints,
    skillPointsRefunded: refunded,
    skillPointsAfter: save.attributes.skillPoints + refunded,
    classRecordBefore,
    classRecordAfter,
    classNameBefore: localize(classRecordBefore),
    classNameAfter: localize(classRecordAfter),
    remaining,
    danglingReferences: dangling,
    refusals,
  };

  if (!refusals.length && target) {
    try {
      plan.output = buildEditedSave(save, transcript, target.classKey, refunded, classRecordAfter);
    } catch (err) {
      refusals.push({ kind: 'encoder-prefix-mismatch', detail: (err as Error).message });
    }
  }
  return plan;
}

/**
 * Auto-cast bindings that would be left pointing at a skill that has gone.
 *
 * Expected to be empty, and the direction is the reason: a binding lives on the
 * *host* player skill and names a devotion, so removing a mastery takes its
 * bindings with it. Kept as a check rather than a repair — a non-empty result
 * means the model of the save is wrong, which is a refusal, not a fix-up.
 */
function danglingReferences(save: CharacterSave, classKey: string): string[] {
  const going = new Set(
    save.skillEntries.filter((e) => belongsTo(e.record, classKey)).map((e) => e.record.toLowerCase()),
  );
  const out: string[] = [];
  for (const entry of save.skillEntries) {
    if (belongsTo(entry.record, classKey)) continue;
    for (const ref of [entry.autoCastSkill, entry.autoCastController]) {
      if (ref && going.has(ref.toLowerCase())) out.push(`${entry.record} → ${ref}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The edit
// ---------------------------------------------------------------------------

/**
 * Apply the three edits to the transcript and re-encipher.
 *
 * Each region is spliced by encoding the *unedited* save and requiring it to
 * match what was read, field for field, before substituting the edited encoding.
 * That check is what makes this safe: an encoder that has drifted from its
 * decoder throws here instead of writing a plausible-looking wrong file.
 */
function buildEditedSave(
  save: CharacterSave,
  transcript: Transcript,
  classKey: string,
  refunded: number,
  classRecordAfter: string,
): Buffer {
  const after: CharacterSave = {
    ...save,
    classRecord: classRecordAfter,
    attributes: { ...save.attributes, skillPoints: save.attributes.skillPoints + refunded },
    skillEntries: save.skillEntries.filter((e) => !belongsTo(e.record, classKey)),
  };

  const segments = [...transcript.segments];

  // The header is not a block: it is the leading run of segments up to the
  // first `checksum`, which is the standalone word it ends on.
  const headerEnd = segments.findIndex((s) => s.kind === 'checksum');
  if (headerEnd < 0) throw new Error('header: no trailing checksum in the transcript');
  const header = segments.slice(0, headerEnd + 1);
  const spliced = spliceRegion(header, encodeHeader(save), encodeHeader(after), 'header');
  segments.splice(0, headerEnd + 1, ...spliced);

  editBlock(segments, 2, (body) => {
    const version = versionOf(body, 2);
    return spliceRegion(body, encodeBlock2(save, version), encodeBlock2(after, version), 'block 2');
  });
  editBlock(segments, 8, (body) => {
    const version = versionOf(body, 8);
    return spliceRegion(body, encodeBlock8(save, version), encodeBlock8(after, version), 'block 8');
  });

  return replay({ ...transcript, segments });
}

/** Every block body starts with its version word. */
function versionOf(body: Seg[], blockId: number): number {
  const first = body[0];
  if (first?.kind !== 'u32') throw new Error(`block ${blockId}: body does not start with a version word`);
  return first.value;
}

function editBlock(segments: Seg[], id: number, edit: (body: Seg[]) => Seg[]): void {
  const at = segments.findIndex((s) => s.kind === 'block' && s.id === id);
  if (at < 0) throw new Error(`block ${id}: not in this save`);
  const block = segments[at]!;
  if (block.kind !== 'block') throw new Error(`block ${id}: not a block`);
  segments[at] = { kind: 'block', id, body: edit(block.body) };
}
