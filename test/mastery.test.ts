import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseGdc, parseGdcRecording } from '../src/save/gdc.js';
import type { GameDb } from '../src/db/types.js';
import {
  characterMasteries,
  classTagFor,
  planMasteryRemoval,
  reconcileClassNumbers,
  type MasteryRef,
} from '../src/save/mastery.js';
import { CHARACTERS, MISSING_SAVES_MESSAGE, characterSavePath, characterWith, haveSaves } from './paths.js';

describe('classTagFor', () => {
  it('concatenates the class numbers in ascending order', () => {
    expect(classTagFor(['10', '04'])).toBe('tagSkillClassName0410');
    expect(classTagFor(['10'])).toBe('tagSkillClassName10');
    expect(classTagFor([])).toBe('');
  });

  // A mod's masteries take numbers the same way: Path of Grim Dawn's Monk is
  // 12 and its Tempest 38, and holding both is tagSkillClassName1238.
  it('does not care that a number came from a mod', () => {
    expect(classTagFor(['38', '12'])).toBe('tagSkillClassName1238');
  });
});

describe('reconcileClassNumbers', () => {
  const monk: MasteryRef = {
    record: 'records/skills/playerclassmonk/_classtraining_classmonk.dbr',
    classKey: 'monk',
    barLevel: 1,
    entryCount: 1,
    pointsInvested: 1,
  };
  const soldier: MasteryRef = { ...monk, record: 'records/skills/playerclass01/_classtraining_class01.dbr', classKey: '01', classNumber: '01' };
  const db = (numbers: Record<string, string>) =>
    ({ masteryNumber: (record: string) => numbers[record] }) as unknown as GameDb;

  it('takes a numbered class from its own path, with no database at all', () => {
    const { numbers, refusals } = reconcileClassNumbers([soldier], 'tagSkillClassName01');
    expect(refusals).toEqual([]);
    expect(numbers?.get('01')).toBe('01');
  });

  it('refuses a mod’s mastery when the database that names it was not loaded', () => {
    const { numbers, refusals } = reconcileClassNumbers([monk], 'tagSkillClassName12');
    expect(refusals).toEqual([{ kind: 'unknown-class-number', record: monk.record }]);
    expect(numbers).toBeUndefined();
  });

  it('resolves it from the mod’s database when that is loaded', () => {
    const { numbers, refusals } = reconcileClassNumbers(
      [monk],
      'tagSkillClassName12',
      db({ [monk.record]: '12' }),
    );
    expect(refusals).toEqual([]);
    expect(numbers?.get('monk')).toBe('12');
  });

  // The point of the check: numbers that do not recompose the tag the save
  // already carries mean a mastery is being looked straight past, and rewriting
  // the tag from that view would delete it.
  it('refuses when the numbers do not add up to the tag on the save', () => {
    const { refusals } = reconcileClassNumbers([monk], 'tagSkillClassName1238', db({ [monk.record]: '12' }));
    expect(refusals).toEqual([
      { kind: 'class-tag-mismatch', expected: 'tagSkillClassName12', actual: 'tagSkillClassName1238' },
    ]);
  });

  it('refuses when the path and the database disagree', () => {
    const { refusals } = reconcileClassNumbers([soldier], 'tagSkillClassName01', db({ [soldier.record]: '07' }));
    expect(refusals).toEqual([
      { kind: 'class-number-conflict', record: soldier.record, fromPath: '01', fromDb: '07' },
    ]);
  });
});

function plan(character: string, mastery: string) {
  const source = readFileSync(characterSavePath(character));
  const { save, transcript } = parseGdcRecording(source);
  return { save, source, result: planMasteryRemoval({ character, save, transcript, source, mastery }) };
}

/**
 * A live character holding a mastery in the state this operation demands: the
 * bar alone, at rank 1, everything else refunded in game.
 *
 * Searched for rather than named, and legitimately absent. These saves are
 * played between test runs — the character that used to supply this had its
 * spare mastery removed long ago and is now dual-class and fully invested — so
 * a hardcoded name here does not fail, it goes stale and takes the assertion
 * with it. When nothing on the machine is in this state the happy path cannot
 * be exercised at all, and the suite says so instead of quietly passing.
 */
function findResetMastery(): { character: string; record: string } | undefined {
  for (const character of CHARACTERS) {
    const save = parseGdc(readFileSync(characterSavePath(character)));
    const masteries = characterMasteries(save);
    if (masteries.length < 2) continue; // removing the last one is refused
    const bare = masteries.find((m) => m.entryCount === 1 && m.barLevel === 1);
    if (bare) return { character, record: bare.record };
  }
  return undefined;
}

/** Any mastery with points in it — the subject of the refusal. */
function findInvestedMastery(): { character: string; mastery: ReturnType<typeof characterMasteries>[number] } | undefined {
  for (const character of CHARACTERS) {
    const save = parseGdc(readFileSync(characterSavePath(character)));
    const invested = characterMasteries(save).find((m) => m.entryCount > 1 || m.barLevel > 1);
    if (invested) return { character, mastery: invested };
  }
  return undefined;
}

const RESET = haveSaves() ? findResetMastery() : undefined;
const INVESTED = haveSaves() ? findInvestedMastery() : undefined;

const NO_RESET_MASTERY =
  'no live character has a mastery reduced to its bar — ' +
  'reset one in game (any Spirit Guide) to cover removing it';

describe.skipIf(!haveSaves())('removing a mastery (live saves)', () => {
  if (!haveSaves()) {
    it.skip(MISSING_SAVES_MESSAGE, () => {});
  }

  it('reads a character’s masteries off the skill list', () => {
    for (const character of CHARACTERS) {
      const save = parseGdc(readFileSync(characterSavePath(character)));
      const masteries = characterMasteries(save);

      // Membership is decided by record path, and the header tag is derived from
      // exactly the set that walk finds — if the two ever disagree, an edit
      // would write a class tag for a character it is not describing.
      expect(save.classRecord, character).toBe(classTagFor(masteries.map((m) => m.classNumber!)));
      for (const m of masteries) {
        // A campaign character's masteries are the numbered ones, and the number
        // in the path is the number in the tag. A mod's are neither, which is
        // what the Custom Game cases in respec.test.ts cover.
        expect(m.record, character).toMatch(/^records\/skills\/playerclass[^/]+\//i);
        expect(m.classNumber, character).toBe(m.classKey.padStart(2, '0'));
      }
    }
  });

  it.runIf(RESET)('removes a mastery that has been reset to its bar', () => {
    const { character, record } = RESET!;
    const { save, result } = plan(character, record);
    const before = characterMasteries(save);
    const remaining = before.filter((m) => m.record !== record);

    expect(result.refusals).toEqual([]);
    expect(result.removed.map((r) => r.record)).toEqual([record]);
    // The bar's last rank is the only thing left to give back; everything else
    // was refunded in game before this operation would agree to run.
    expect(result.skillPointsRefunded).toBe(1);
    expect(result.skillPointsAfter).toBe(save.attributes.skillPoints + 1);
    expect(result.classRecordBefore).toBe(classTagFor(before.map((m) => m.classNumber!)));
    expect(result.classRecordAfter).toBe(classTagFor(remaining.map((m) => m.classNumber!)));
    // A binding lives on the host skill and names a devotion, so removing a
    // mastery takes its bindings with it. Anything else means the model is off.
    expect(result.danglingReferences).toEqual([]);
    expect(result.output).toBeDefined();
  });
  it.runIf(!RESET)(NO_RESET_MASTERY, () => {});

  it.runIf(RESET)('produces a save whose only changes are the intended ones', () => {
    const { character, record } = RESET!;
    const classNumber = /playerclass(\d+)\//i.exec(record)![1]!;
    const owns = new RegExp(`playerclass${classNumber}/`, 'i');

    const { save, result } = plan(character, classNumber); // selected by class number
    expect(result.refusals).toEqual([]);
    const after = parseGdc(result.output!);

    // Structurally sound: this is the check the game itself would make first.
    expect(after.warnings).toEqual([]);
    expect(after.blocks.filter((b) => !b.checksumOk || b.status !== 'parsed')).toEqual([]);
    expect(after.blocks.map((b) => b.id)).toEqual(save.blocks.map((b) => b.id));

    expect(after.classRecord).toBe(
      classTagFor(characterMasteries(save).filter((m) => m.record !== record).map((m) => m.classNumber!)),
    );
    expect(after.attributes.skillPoints).toBe(save.attributes.skillPoints + 1);
    expect(after.skillEntries).toHaveLength(save.skillEntries.length - 1);
    expect(after.skillEntries.filter((e) => owns.test(e.record))).toEqual([]);

    // Everything else is untouched, field for field. `blocks` carries the two
    // edited blocks' new lengths, so it is compared by id above instead.
    const strip = (s: typeof save) => ({
      ...s,
      classRecord: '',
      attributes: { ...s.attributes, skillPoints: 0 },
      skillEntries: s.skillEntries.filter((e) => !owns.test(e.record)),
      skills: s.skills.filter((e) => !owns.test(e.record)),
      blocks: [],
    });
    expect(strip(after)).toEqual(strip(save));

    // Devotions ride in the same array as skills and must all survive.
    expect(after.devotions).toEqual(save.devotions);
  });

  it.runIf(INVESTED)('refuses a mastery that still holds skills', () => {
    const { character, mastery } = INVESTED!;
    const { result } = plan(character, mastery.record);

    // The counts are read off the character rather than written down: what is
    // being asserted is that the refusal reports the mastery it is refusing.
    expect(result.refusals).toEqual([
      { kind: 'mastery-not-reset', entryCount: mastery.entryCount, pointsInvested: mastery.pointsInvested },
    ]);
    expect(result.output).toBeUndefined();
  });

  it('refuses to leave a character with no mastery at all', () => {
    // Found by shape rather than by name: which character has exactly one
    // mastery is a fact about this machine, and the last one to hold that role
    // was deleted in game.
    const single = characterWith((save) => characterMasteries(save).length === 1);
    if (!single) return; // every character here is dual-class; nothing to prove

    const only = characterMasteries(parseGdc(readFileSync(characterSavePath(single))))[0]!;
    const { result } = plan(single, only.classKey);

    expect(result.refusals).toEqual([{ kind: 'last-mastery' }]);
    expect(result.output).toBeUndefined();
  });

  it('refuses a mastery the character does not have', () => {
    const { result } = plan('_Suchka', 'Necromancer');

    expect(result.refusals).toEqual([{ kind: 'unknown-mastery', record: 'Necromancer' }]);
    expect(result.output).toBeUndefined();
  });

  it('refuses a save it cannot reproduce byte for byte', () => {
    const source = readFileSync(characterSavePath('_Suchka'));
    const { save, transcript } = parseGdcRecording(source);
    const tampered = Buffer.from(source);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff;

    const result = planMasteryRemoval({
      character: '_Suchka',
      save,
      transcript,
      source: tampered,
      mastery: '04',
    });

    expect(result.refusals.map((r) => r.kind)).toContain('roundtrip-mismatch');
    expect(result.output).toBeUndefined();
  });
});
