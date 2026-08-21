/**
 * Respec: give back skill points, devotion points, or a whole mastery.
 *
 * The neighbouring `planMasteryRemoval` refuses unless the mastery has already
 * been reduced to its bar at rank 1 — it exists to finish a job the game itself
 * starts, and its refusal is faithful to the game's own rule. This one does the
 * whole job. It takes back every point in what it removes, in one edit, at any
 * time, which is the operation a Spirit Guide performs and charges for.
 *
 * Four regions move, and the last two are the reason this is not just the
 * mastery planner with a flag:
 *
 *   header    the class tag, which names the masteries that remain
 *   block 2   the unspent skill and devotion point pools
 *   block 8   the skill entries, *and* the auto-cast bindings on the survivors
 *   block 14  the hotbar and the skill sets, which name skills by record
 *
 * Removing a mastery never had to touch the last two. A binding lives on the
 * *host* player skill and names a devotion, so taking a mastery away takes its
 * bindings with it; wiping devotions goes the other way, and leaves every host
 * pointing at a devotion that is gone. Likewise the hotbar: a character has
 * their skills on it, and a slot naming a skill the character no longer has is
 * a reference into nothing.
 *
 * Everything is reported rather than repaired where the model might be wrong —
 * the one exception being the two kinds of dangling reference above, which are
 * *expected* consequences of the edit and are cleared as part of it.
 */

import type { GameDb } from '../db/types.js';
import { saveEditRefusals, type SaveEditRefusal } from './edit.js';
import {
  encodeBlock14,
  encodeBlock2,
  encodeBlock8,
  encodeHeader,
  isDevotionRecord,
} from './gdc.js';
import { characterMasteries, classTagFor, masteryClassNumber, type MasteryRef } from './mastery.js';
import { replay, spliceRegion, type Seg, type Transcript } from './transcript.js';
import type { CharacterSave, CharacterSkill, HotSlot, SkillSet } from './types.js';

/** What to take back. */
export interface RespecScope {
  /**
   * `'all'` for every mastery the character has, or specific ones by record
   * path, class number or localized name. An empty list removes no mastery,
   * which is how a devotions-only respec is asked for.
   */
  masteries: 'all' | string[];
  /** Refund every devotion point and unbind every celestial power. */
  devotions: boolean;
}

export type RespecRefusal =
  | SaveEditRefusal
  | { kind: 'unknown-mastery'; record: string }
  | { kind: 'nothing-to-respec' }
  | { kind: 'devotion-ledger-mismatch'; unspent: number; refunded: number; total: number };

export interface RemovedEntry {
  record: string;
  name?: string;
  level: number;
}

export interface RespecPlan {
  character: string;
  /** Masteries being removed entirely. */
  removedMasteries: MasteryRef[];
  /** Skill entries going away — mastery skills, including the bars. */
  removedSkills: RemovedEntry[];
  /** Devotion entries going away. */
  removedDevotions: RemovedEntry[];
  skillPointsBefore: number;
  skillPointsRefunded: number;
  skillPointsAfter: number;
  devotionPointsBefore: number;
  devotionPointsRefunded: number;
  devotionPointsAfter: number;
  classRecordBefore: string;
  classRecordAfter: string;
  classNameBefore: string;
  classNameAfter: string;
  /** Masteries the character keeps. */
  remaining: MasteryRef[];
  /** Auto-cast bindings cleared on skills that survive: `host → reference`. */
  clearedBindings: string[];
  /** Hotbar positions emptied because they named a skill that is going. */
  clearedHotSlots: number[];
  /** Skill-set entries blanked, as `set index/primary|secondary`. */
  clearedSkillSets: string[];
  refusals: RespecRefusal[];
  /** The edited save. Present only when `refusals` is empty. */
  output?: Buffer;
}

export interface RespecPlanInput {
  character: string;
  save: CharacterSave;
  transcript: Transcript;
  /** The bytes the save was parsed from, for the round-trip check. */
  source: Buffer;
  db?: GameDb;
  scope: RespecScope;
}

/**
 * Work out what a respec would do, and whether it may be done at all.
 * The edited bytes come back on `output` only when `refusals` is empty.
 */
export function planRespec(input: RespecPlanInput): RespecPlan {
  const { character, save, transcript, source, db, scope } = input;
  const refusals: RespecRefusal[] = [];
  const localize = (tag: string) => db?.localize(tag) ?? tag;
  const nameOf = (record: string) => db?.getSkill(record)?.name;

  const masteries = characterMasteries(save, db);
  const targets: MasteryRef[] = [];
  if (scope.masteries === 'all') {
    targets.push(...masteries);
  } else {
    for (const wanted of scope.masteries) {
      const key = wanted.trim().toLowerCase();
      const found = masteries.find(
        (m) =>
          m.record.toLowerCase() === key ||
          m.classNumber === key.padStart(2, '0') ||
          (m.name ?? '').toLowerCase() === key,
      );
      if (found) {
        if (!targets.some((t) => t.classNumber === found.classNumber)) targets.push(found);
      } else {
        refusals.push({ kind: 'unknown-mastery', record: wanted });
      }
    }
  }

  const goingClasses = new Set(targets.map((m) => m.classNumber));
  const isGoing = (entry: CharacterSkill): boolean => {
    const cls = masteryClassNumber(entry.record);
    if (cls !== undefined && goingClasses.has(cls)) return true;
    return scope.devotions && isDevotionRecord(entry.record);
  };

  const removed = save.skillEntries.filter(isGoing);
  const removedDevotions = removed.filter((e) => isDevotionRecord(e.record));
  const removedSkills = removed.filter((e) => !isDevotionRecord(e.record));
  const describe = (e: CharacterSkill): RemovedEntry => {
    const name = nameOf(e.record);
    return name === undefined ? { record: e.record, level: e.level } : { record: e.record, name, level: e.level };
  };

  // Points come back from the entries themselves. A devotion node is rank 1, so
  // its refund is one point each — but summing `level` is still right, and is
  // what makes the ledger check below meaningful rather than circular.
  const skillRefund = removedSkills.reduce((n, e) => n + Math.max(0, e.level), 0);
  const devotionRefund = removedDevotions.reduce((n, e) => n + Math.max(0, e.level), 0);

  const remaining = masteries.filter((m) => !goingClasses.has(m.classNumber));
  const classRecordBefore = save.classRecord;
  // With no mastery left the character carries no class tag at all, which is
  // what a character who has not chosen one yet looks like.
  const classRecordAfter = targets.length ? classTagFor(remaining) : classRecordBefore;

  const going = new Set(removed.map((e) => e.record.toLowerCase()));
  const survivors = save.skillEntries.filter((e) => !isGoing(e));

  const clearedBindings: string[] = [];
  const rebound = survivors.map((entry) => {
    const stale = [entry.autoCastSkill, entry.autoCastController].some(
      (ref) => ref !== '' && going.has(ref.toLowerCase()),
    );
    if (!stale) return entry;
    // The two travel as a pair: the controller is the record that fires the
    // bound skill, so keeping one without the other is a binding to nothing.
    clearedBindings.push(`${entry.record} → ${entry.autoCastSkill || entry.autoCastController}`);
    return { ...entry, autoCastSkill: '', autoCastController: '' };
  });

  const { hotSlots, skillSets, clearedHotSlots, clearedSkillSets } = clearUiReferences(save, going);

  // --- what stands in the way -------------------------------------------
  refusals.push(...saveEditRefusals(save, transcript, source));

  const changes = removed.length > 0 || clearedBindings.length > 0;
  if (!changes && !refusals.some((r) => r.kind === 'unknown-mastery')) {
    refusals.push({ kind: 'nothing-to-respec' });
  }

  // Wiping every devotion must land the character on exactly the devotion
  // points they have earned. If it does not, this parser's idea of the ledger
  // is wrong and the number written back would be a guess.
  const devotionPointsAfter = save.attributes.devotionPoints + devotionRefund;
  const wipedAllDevotions = scope.devotions && save.devotions.length > 0;
  if (wipedAllDevotions && devotionPointsAfter !== save.attributes.totalDevotionPoints) {
    refusals.push({
      kind: 'devotion-ledger-mismatch',
      unspent: save.attributes.devotionPoints,
      refunded: devotionRefund,
      total: save.attributes.totalDevotionPoints,
    });
  }

  const plan: RespecPlan = {
    character,
    removedMasteries: targets,
    removedSkills: removedSkills.map(describe),
    removedDevotions: removedDevotions.map(describe),
    skillPointsBefore: save.attributes.skillPoints,
    skillPointsRefunded: skillRefund,
    skillPointsAfter: save.attributes.skillPoints + skillRefund,
    devotionPointsBefore: save.attributes.devotionPoints,
    devotionPointsRefunded: devotionRefund,
    devotionPointsAfter,
    classRecordBefore,
    classRecordAfter,
    classNameBefore: localize(classRecordBefore),
    classNameAfter: classRecordAfter === '' ? '(no mastery)' : localize(classRecordAfter),
    remaining,
    clearedBindings,
    clearedHotSlots,
    clearedSkillSets,
    refusals,
  };

  if (!refusals.length) {
    try {
      plan.output = buildEditedSave(save, transcript, {
        classRecord: classRecordAfter,
        skillPoints: plan.skillPointsAfter,
        devotionPoints: devotionPointsAfter,
        skillEntries: rebound,
        hotSlots,
        skillSets,
      });
    } catch (err) {
      refusals.push({ kind: 'encoder-prefix-mismatch', detail: (err as Error).message });
      delete plan.output;
    }
  }
  return plan;
}

/**
 * Take the removed skills off the hotbar and out of the skill sets.
 *
 * An emptied slot becomes kind `-1` with no payload, which is how the file
 * itself spells an empty position — every character has dozens of them. Slots
 * naming a skill that survives (an item-granted one, say) are left alone, and
 * so are the potion slots, which name no skill at all.
 */
function clearUiReferences(
  save: CharacterSave,
  going: ReadonlySet<string>,
): { hotSlots: HotSlot[]; skillSets: SkillSet[]; clearedHotSlots: number[]; clearedSkillSets: string[] } {
  const ui = save.uiSettings;
  const clearedHotSlots: number[] = [];
  const clearedSkillSets: string[] = [];
  if (!ui) return { hotSlots: [], skillSets: [], clearedHotSlots, clearedSkillSets };

  const hotSlots = ui.hotSlots.map((slot, index) => {
    if (slot.kind !== 0 || !slot.skill) return slot;
    if (!going.has(slot.skill.record.toLowerCase())) return slot;
    clearedHotSlots.push(index);
    return { kind: -1 };
  });

  const skillSets = ui.skillSets.map((set, index) => {
    const primaryGone = set.primary !== '' && going.has(set.primary.toLowerCase());
    const secondaryGone = set.secondary !== '' && going.has(set.secondary.toLowerCase());
    if (primaryGone) clearedSkillSets.push(`set ${index + 1}/primary`);
    if (secondaryGone) clearedSkillSets.push(`set ${index + 1}/secondary`);
    if (!primaryGone && !secondaryGone) return set;
    return {
      ...set,
      primary: primaryGone ? '' : set.primary,
      secondary: secondaryGone ? '' : set.secondary,
    };
  });

  return { hotSlots, skillSets, clearedHotSlots, clearedSkillSets };
}

// ---------------------------------------------------------------------------
// The edit
// ---------------------------------------------------------------------------

interface Edits {
  classRecord: string;
  skillPoints: number;
  devotionPoints: number;
  skillEntries: CharacterSkill[];
  hotSlots: HotSlot[];
  skillSets: SkillSet[];
}

/**
 * Apply the edits to the transcript and re-encipher.
 *
 * Each region is spliced by encoding the *unedited* save and requiring it to
 * match what was read, field for field, before the edited encoding replaces it.
 * That check is what makes this safe: an encoder that has drifted from its
 * decoder throws here instead of writing a plausible-looking wrong file.
 *
 * Block 14 is only touched when there is something in it to change. It is the
 * newest encoder in the file and the only one this operation needs that the
 * mastery removal never did, so a character whose hotbar names nothing being
 * removed does not depend on it at all.
 */
function buildEditedSave(save: CharacterSave, transcript: Transcript, edits: Edits): Buffer {
  const after: CharacterSave = {
    ...save,
    classRecord: edits.classRecord,
    attributes: {
      ...save.attributes,
      skillPoints: edits.skillPoints,
      devotionPoints: edits.devotionPoints,
    },
    skillEntries: edits.skillEntries,
  };
  const uiChanged =
    save.uiSettings !== undefined &&
    (JSON.stringify(save.uiSettings.hotSlots) !== JSON.stringify(edits.hotSlots) ||
      JSON.stringify(save.uiSettings.skillSets) !== JSON.stringify(edits.skillSets));
  if (save.uiSettings) {
    after.uiSettings = { ...save.uiSettings, hotSlots: edits.hotSlots, skillSets: edits.skillSets };
  }

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
  if (uiChanged) {
    editBlock(segments, 14, (body) => {
      const version = versionOf(body, 14);
      return spliceRegion(body, encodeBlock14(save, version), encodeBlock14(after, version), 'block 14');
    });
  }

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
