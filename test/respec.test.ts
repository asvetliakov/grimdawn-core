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

function plan(character: string, scope: RespecScope, path = characterSavePath(character)) {
  const source = readFileSync(path);
  const { save, transcript } = parseGdcRecording(source);
  return { save, source, result: planRespec({ character, save, transcript, source, scope }) };
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

  it('removes one mastery and refunds it, with the other left alone', () => {
    // The case the mastery planner refuses outright: a mastery with points in
    // it, taken back in one edit.
    const character = characterWith((s) => characterMasteries(s).length === 2);
    if (!character) return;

    const before = parseGdc(readFileSync(characterSavePath(character)));
    const [target, kept] = characterMasteries(before);
    const { save, result } = plan(character, { masteries: [target!.classNumber], devotions: false });

    expect(result.refusals).toEqual([]);
    expect(result.skillPointsRefunded).toBe(target!.pointsInvested);
    expect(result.skillPointsRefunded).toBeGreaterThan(1); // not the bar-only case

    const after = parseGdc(result.output!);
    expect(after.warnings).toEqual([]);
    expect(after.blocks.filter((b) => !b.checksumOk || b.status !== 'parsed')).toEqual([]);
    expect(after.classRecord).toBe(classTagFor([kept!]));
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
    expect(nothing.result.refusals).toContainEqual({ kind: 'nothing-to-respec' });
    expect(nothing.result.output).toBeUndefined();
  });
});

describe.skipIf(!haveCustomSaves())('respec on a Custom Game character', () => {
  if (!haveCustomSaves()) it.skip('no Custom Game characters on this machine', () => {});

  it('refunds devotions, and reports that a mod’s mastery is not one it can name', () => {
    for (const character of customCharacters()) {
      const path = customCharacterSavePath(character);
      const before = parseGdc(readFileSync(path));
      if (before.devotions.length === 0) continue;

      const { result } = plan(character, { masteries: [], devotions: true }, path);

      // A mod's mastery lives at `records/skills/playerclassmonk/` — no digits —
      // so `playerclassNN` does not match it and this character reports none.
      // The devotion half needs nothing from the mod's database and works.
      expect(characterMasteries(before), character).toEqual([]);
      expect(result.refusals, character).toEqual([]);

      const after = parseGdc(result.output!);
      expect(after.warnings, character).toEqual([]);
      expect(after.blocks.filter((b) => !b.checksumOk || b.status !== 'parsed'), character).toEqual([]);
      expect(after.devotions, character).toEqual([]);
    }
  });
});
