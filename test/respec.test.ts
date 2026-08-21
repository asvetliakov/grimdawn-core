/**
 * Respec.
 *
 * The edit is bigger than the mastery removal next door — it takes points back
 * rather than requiring them already refunded, and it reaches into two regions
 * that operation never had to touch — so the assertions are correspondingly
 * about *containment*: the file still parses, every block still checksums, the
 * points arrive, and nothing outside the four edited regions moved.
 *
 * Subjects come from the fixtures, so which character has which build is fixed
 * once per machine; what is asserted is derived from the save being edited
 * rather than written down.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { isDevotionRecord, parseGdc, parseGdcRecording } from '../src/save/gdc.js';
import type { GameDb } from '../src/db/types.js';
import { characterMasteries, classTagFor } from '../src/save/mastery.js';
import { planRespec, type RespecScope } from '../src/save/respec.js';
import { replay } from '../src/save/transcript.js';
import type { CharacterSave } from '../src/save/types.js';
import {
  CHARACTERS,
  MISSING_SAVES_MESSAGE,
  characterSavePath,
  characterWith,
  customCharacterSavePath,
  customCharacters,
  haveCustomSaves,
  haveSaves,
  primaryCharacter,
} from './paths.js';

function plan(character: string, scope: RespecScope, path = characterSavePath(character), db?: GameDb) {
  const source = readFileSync(path);
  const { save, transcript } = parseGdcRecording(source);
  return { save, source, result: planRespec({ character, save, transcript, source, scope, ...(db ? { db } : {}) }) };
}

/** Everything a respec must not touch, compared field for field. */
function untouched(save: CharacterSave) {
  return {
    ...save,
    classRecord: '',
    attributes: { ...save.attributes, skillPoints: 0, devotionPoints: 0 },
    skillEntries: [],
    skills: [],
    devotions: [],
    uiSettings: undefined,
    blocks: [],
  };
}

describe.skipIf(!haveSaves())('respec (fixtures)', () => {
  if (!haveSaves()) it.skip(MISSING_SAVES_MESSAGE, () => {});

  it('takes back everything: masteries, skills and devotions', () => {
    const character = primaryCharacter();
    const { save, result } = plan(character, { masteries: 'all', devotions: true });

    expect(result.refusals).toEqual([]);
    expect(result.output).toBeDefined();

    const after = parseGdc(result.output!);

    // Structurally sound: the check the game itself would make first.
    expect(after.warnings).toEqual([]);
    expect(after.blocks.filter((b) => !b.checksumOk || b.status !== 'parsed')).toEqual([]);
    expect(after.blocks.map((b) => b.id)).toEqual(save.blocks.map((b) => b.id));

    // A character with no mastery carries no class tag — the state the game
    // puts a level-1 character in before one is chosen.
    expect(after.classRecord).toBe('');
    expect(characterMasteries(after)).toEqual([]);
    expect(after.devotions).toEqual([]);
    expect(after.skillEntries.filter((e) => /playerclass\d+\//i.test(e.record))).toEqual([]);

    // The points come back, and the devotion ledger closes exactly.
    expect(after.attributes.skillPoints).toBe(save.attributes.skillPoints + result.skillPointsRefunded);
    expect(after.attributes.devotionPoints).toBe(after.attributes.totalDevotionPoints);
    expect(result.skillPointsRefunded).toBeGreaterThan(0);
    expect(result.devotionPointsRefunded).toBe(save.devotions.reduce((n, d) => n + Math.max(0, d.level), 0));

    // What survives is what the character did not spend a point on: the default
    // attacks, and the skills their gear grants.
    for (const entry of after.skillEntries) {
      expect(/playerclass\d+\//i.test(entry.record) || isDevotionRecord(entry.record)).toBe(false);
    }

    // No survivor is left pointing at something that has gone.
    const present = new Set(after.skillEntries.map((e) => e.record.toLowerCase()));
    for (const entry of after.skillEntries) {
      for (const ref of [entry.autoCastSkill, entry.autoCastController]) {
        if (ref !== '') expect(present.has(ref.toLowerCase()), `${entry.record} → ${ref}`).toBe(true);
      }
    }

    // Nor is the hotbar, or a skill set. Note the test is "names nothing that
    // was removed" rather than "names a surviving entry": a relic's granted
    // skill sits on the bar without ever being a block-8 entry, because it
    // comes from the item rather than from a spent point.
    const gone = new Set(
      [...result.removedSkills, ...result.removedDevotions].map((e) => e.record.toLowerCase()),
    );
    for (const slot of after.uiSettings!.hotSlots) {
      if (slot.kind === 0 && slot.skill) expect(gone.has(slot.skill.record.toLowerCase())).toBe(false);
    }
    for (const set of after.uiSettings!.skillSets) {
      for (const ref of [set.primary, set.secondary]) expect(gone.has(ref.toLowerCase())).toBe(false);
    }

    // And nothing else in the file moved — items, factions, quests, stats.
    expect(untouched(after)).toEqual(untouched(save));
  });

  // The state this tool leaves a character in, re-planned. It is what the
  // window shows the moment after a respec succeeds, and reporting it as
  // "nothing selected" read as though the user had done something wrong.
  it('says there is nothing left rather than nothing chosen, once it has worked', () => {
    const character = primaryCharacter();
    const { result } = plan(character, { masteries: 'all', devotions: true });
    if (!result.output) return;

    const source = result.output;
    const { save, transcript } = parseGdcRecording(source);
    const again = planRespec({
      character,
      save,
      transcript,
      source,
      scope: { masteries: 'all', devotions: true },
    });

    expect(again.refusals).toEqual([{ kind: 'nothing-to-respec', masteries: true, devotions: true }]);
    expect(again.output).toBeUndefined();
  });

  it('removes one mastery and refunds it, with the other left alone', () => {
    // The case the mastery planner refuses outright: a mastery with points in
    // it, taken back in one edit.
    const character = characterWith((s) => characterMasteries(s).length === 2);
    if (!character) return;

    const before = parseGdc(readFileSync(characterSavePath(character)));
    const [target, kept] = characterMasteries(before);
    const { save, result } = plan(character, { masteries: [target!.classKey], devotions: false });

    expect(result.refusals).toEqual([]);
    expect(result.skillPointsRefunded).toBe(target!.pointsInvested);
    expect(result.skillPointsRefunded).toBeGreaterThan(1); // not the bar-only case

    const after = parseGdc(result.output!);
    expect(after.warnings).toEqual([]);
    expect(after.blocks.filter((b) => !b.checksumOk || b.status !== 'parsed')).toEqual([]);
    expect(after.classRecord).toBe(classTagFor([kept!.classNumber!]));
    expect(characterMasteries(after).map((m) => m.classNumber)).toEqual([kept!.classNumber]);
    expect(after.attributes.skillPoints).toBe(save.attributes.skillPoints + target!.pointsInvested);

    // Devotions were not in scope and must be untouched, entry for entry.
    expect(after.devotions).toEqual(save.devotions);
    expect(after.attributes.devotionPoints).toBe(save.attributes.devotionPoints);
  });

  it('refunds devotions alone, leaving the masteries standing', () => {
    const character = characterWith((s) => s.devotions.length > 0);
    if (!character) return;

    const { save, result } = plan(character, { masteries: [], devotions: true });

    expect(result.refusals).toEqual([]);
    expect(result.removedMasteries).toEqual([]);
    expect(result.classRecordAfter).toBe(save.classRecord);

    const after = parseGdc(result.output!);
    expect(after.warnings).toEqual([]);
    expect(after.blocks.filter((b) => !b.checksumOk || b.status !== 'parsed')).toEqual([]);
    expect(after.devotions).toEqual([]);
    expect(after.classRecord).toBe(save.classRecord);
    expect(characterMasteries(after)).toEqual(characterMasteries(save));
    // Every skill the character spent a point on is still there, at its rank.
    expect(after.skills).toEqual(save.skills.map((s) => ({ ...s, autoCastSkill: '', autoCastController: '' })));
    expect(after.attributes.skillPoints).toBe(save.attributes.skillPoints);
    expect(after.attributes.devotionPoints).toBe(after.attributes.totalDevotionPoints);
  });

  it('unbinds every celestial power a surviving skill was firing', () => {
    // The direction removing a mastery never hits: a binding lives on the host
    // *skill* and names a devotion, so wiping devotions leaves the hosts behind
    // pointing at nothing.
    const character = characterWith((s) =>
      s.skillEntries.some((e) => e.autoCastSkill !== '' && isDevotionRecord(e.autoCastSkill)),
    );
    if (!character) return;

    const { save, result } = plan(character, { masteries: [], devotions: true });
    const hosts = save.skillEntries.filter((e) => e.autoCastSkill !== '' || e.autoCastController !== '');

    expect(result.refusals).toEqual([]);
    expect(result.clearedBindings.length).toBe(hosts.length);

    const after = parseGdc(result.output!);
    expect(after.skillEntries.filter((e) => e.autoCastSkill !== '' || e.autoCastController !== '')).toEqual([]);
  });

  it('takes the removed skills off the hotbar', () => {
    const character = characterWith((s) =>
      (s.uiSettings?.hotSlots ?? []).some((slot) => /playerclass\d+\//i.test(slot.skill?.record ?? '')),
    );
    if (!character) return;

    const { save, result } = plan(character, { masteries: 'all', devotions: true });
    const removed = new Set(
      [...result.removedSkills, ...result.removedDevotions].map((e) => e.record.toLowerCase()),
    );
    // Counted against the *removed entries*, not against every slot that looks
    // like a mastery skill: a bar can hold a skill the character never spent a
    // point on, which is not a block-8 entry and so is not something this edit
    // removes.
    const expected = (save.uiSettings?.hotSlots ?? [])
      .map((slot, index) => ({ slot, index }))
      .filter(({ slot }) => slot.kind === 0 && removed.has((slot.skill?.record ?? '').toLowerCase()))
      .map(({ index }) => index);

    expect(result.refusals).toEqual([]);
    expect(result.clearedHotSlots).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);

    const after = parseGdc(result.output!);
    // An emptied position is spelled the way the file spells one: kind -1, no
    // payload. Every other slot — the potions, the item skills — is as it was.
    for (const index of result.clearedHotSlots) {
      expect(after.uiSettings!.hotSlots[index]).toEqual({ kind: -1 });
    }
    expect(after.uiSettings!.hotSlots.length).toBe(save.uiSettings!.hotSlots.length);
  });

  it('replays byte for byte, and re-reads as what it claims to be', () => {
    for (const character of CHARACTERS) {
      const { result } = plan(character, { masteries: 'all', devotions: true });
      if (result.refusals.length) continue;

      // The edited bytes are themselves a save the transcript machinery accepts:
      // parsed, recorded, and replayed back to the same file.
      const { transcript } = parseGdcRecording(result.output!);
      expect(replay(transcript).equals(result.output!), character).toBe(true);
    }
  });

  it('refuses a save it cannot reproduce byte for byte', () => {
    const character = primaryCharacter();
    const source = readFileSync(characterSavePath(character));
    const { save, transcript } = parseGdcRecording(source);
    const tampered = Buffer.from(source);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff;

    const result = planRespec({
      character,
      save,
      transcript,
      source: tampered,
      scope: { masteries: 'all', devotions: true },
    });

    expect(result.refusals.map((r) => r.kind)).toContain('roundtrip-mismatch');
    expect(result.output).toBeUndefined();
  });

  it('refuses a mastery the character does not have, and an empty scope', () => {
    const character = primaryCharacter();

    const unknown = plan(character, { masteries: ['Necromancer'], devotions: false });
    expect(unknown.result.refusals).toContainEqual({ kind: 'unknown-mastery', record: 'Necromancer' });
    expect(unknown.result.output).toBeUndefined();

    const nothing = plan(character, { masteries: [], devotions: false });
    expect(nothing.result.refusals).toContainEqual({ kind: 'nothing-selected' });
    expect(nothing.result.output).toBeUndefined();
  });
});

/**
 * A database that answers exactly one question: what number a mastery takes in
 * the class tag. That is all `planRespec` asks a mod's database for, so a stub
 * of it is a faithful stand-in for one — and unlike the real thing it is here
 * on every machine, mod installed or not.
 */
function numbersDb(numbers: Record<string, string>): GameDb {
  return {
    masteryNumber: (record: string) => numbers[record],
    getSkill: () => undefined,
    localize: (tag: string) => tag,
  } as unknown as GameDb;
}

/** The numbers a save's own class tag spells, two digits at a time. */
function tagNumbers(classRecord: string): string[] {
  return classRecord.replace(/^tagSkillClassName/, '').match(/\d{2}/g) ?? [];
}

/**
 * Custom Game characters holding a mastery whose number the path cannot give —
 * a mod's. Found by shape: which mod is installed, and what it calls its
 * classes, is a fact about the machine and not something to write down here.
 */
function modMasterySubjects(): { character: string; path: string; save: CharacterSave; numbers: Record<string, string> }[] {
  const out = [];
  for (const character of customCharacters()) {
    const path = customCharacterSavePath(character);
    const save = parseGdc(readFileSync(path));
    const masteries = characterMasteries(save);
    if (!masteries.length || masteries.some((m) => m.classNumber !== undefined)) continue;
    // One mastery, one number in the tag: the save states which number this
    // record takes, which is precisely what the mod's database would say.
    const numbers = tagNumbers(save.classRecord);
    if (masteries.length !== 1 || numbers.length !== 1) continue;
    out.push({ character, path, save, numbers: { [masteries[0]!.record]: numbers[0]! } });
  }
  return out;
}

const MOD_SUBJECTS = haveCustomSaves() ? modMasterySubjects() : [];

describe.skipIf(!haveCustomSaves())('respec on a Custom Game character', () => {
  if (!haveCustomSaves()) it.skip('no Custom Game characters on this machine', () => {});

  it('refunds devotions with no database at all, leaving the class tag alone', () => {
    for (const character of customCharacters()) {
      const path = customCharacterSavePath(character);
      const before = parseGdc(readFileSync(path));
      if (before.devotions.length === 0) continue;

      const { result } = plan(character, { masteries: [], devotions: true }, path);

      // The devotion half needs nothing from the mod's database: it takes no
      // mastery away, so it rewrites no class tag and has no number to resolve.
      expect(result.refusals, character).toEqual([]);
      expect(result.classRecordAfter, character).toBe(before.classRecord);

      const after = parseGdc(result.output!);
      expect(after.warnings, character).toEqual([]);
      expect(after.blocks.filter((b) => !b.checksumOk || b.status !== 'parsed'), character).toEqual([]);
      expect(after.devotions, character).toEqual([]);
    }
  });

  it.runIf(MOD_SUBJECTS.length)('reads a mod’s mastery off the skill list, number unknown', () => {
    for (const { character, save } of MOD_SUBJECTS) {
      const [mastery] = characterMasteries(save);
      // The directory is the class key and the save carries it; the number it
      // takes in the tag is a fact about the mod's database, and absent here.
      expect(mastery!.classKey, character).not.toMatch(/^\d+$/);
      expect(mastery!.classNumber, character).toBeUndefined();
      expect(mastery!.barLevel, character).toBeGreaterThan(0);
    }
  });

  it.runIf(MOD_SUBJECTS.length)('refuses to respec it when the mod’s database was not loaded', () => {
    for (const { character, path, save } of MOD_SUBJECTS) {
      const { result } = plan(character, { masteries: 'all', devotions: false }, path);
      expect(result.refusals, character).toContainEqual({
        kind: 'unknown-class-number',
        record: characterMasteries(save)[0]!.record,
      });
      expect(result.output, character).toBeUndefined();
    }
  });

  it.runIf(MOD_SUBJECTS.length)('respecs it once the mod’s database names the number', () => {
    for (const { character, path, save, numbers } of MOD_SUBJECTS) {
      const db = numbersDb(numbers);
      const { result } = plan(character, { masteries: 'all', devotions: true }, path, db);

      expect(result.refusals, character).toEqual([]);
      expect(result.removedMasteries.map((m) => m.record), character).toEqual(Object.keys(numbers));
      expect(result.skillPointsRefunded, character).toBeGreaterThan(0);

      const after = parseGdc(result.output!);
      expect(after.warnings, character).toEqual([]);
      expect(after.blocks.filter((b) => !b.checksumOk || b.status !== 'parsed'), character).toEqual([]);
      expect(after.blocks.map((b) => b.id), character).toEqual(save.blocks.map((b) => b.id));

      // The one mastery it had is gone, so the character carries no class tag —
      // the state the game puts a character in before one is chosen.
      expect(after.classRecord, character).toBe('');
      expect(characterMasteries(after), character).toEqual([]);
      expect(after.skillEntries.filter((e) => /playerclass/i.test(e.record)), character).toEqual([]);
      expect(after.attributes.skillPoints, character).toBe(save.attributes.skillPoints + result.skillPointsRefunded);
      expect(untouched(after), character).toEqual(untouched(save));
    }
  });

  it.runIf(MOD_SUBJECTS.length)('refuses a number that does not add up to the tag on the save', () => {
    for (const { character, path, save, numbers } of MOD_SUBJECTS) {
      const record = Object.keys(numbers)[0]!;
      const wrong = numbers[record] === '02' ? '03' : '02';
      const { result } = plan(character, { masteries: 'all', devotions: false }, path, numbersDb({ [record]: wrong }));

      expect(result.refusals, character).toContainEqual({
        kind: 'class-tag-mismatch',
        expected: classTagFor([wrong]),
        actual: save.classRecord,
      });
      expect(result.output, character).toBeUndefined();
    }
  });
});
