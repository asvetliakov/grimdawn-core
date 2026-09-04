/**
 * Installed mods, and finding the one that defines a character's mastery.
 *
 * Which mods are on this machine is a fact about this machine, so nothing here
 * asserts a name: the subject is "a mod that defines the classes some Custom
 * Game character is playing", found by looking. What *is* asserted is the
 * property the patcher leans on — that the search distinguishes the mod which
 * defines a record from the ones that merely exist.
 *
 * A save outlives the mod that made it: `_Bitch` and `_Suchka` in the custom
 * tree still name `playerclasstempest` and `playerclassmonk`, and Path of Grim
 * Dawn — which defined both — is no longer installed here. That is an ordinary
 * state of the machine, not a failure, so the subject is a character whose mod
 * is *still on disk*; without one, the three tests that need a pairing skip.
 * What must not skip with them is the mechanism, or a `modsDefiningRecords`
 * that had stopped finding anything would look like a machine without the mod
 * — so it is checked separately, against records read out of whichever mod is
 * installed.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { arzRecordNames } from '../src/db/arz.js';
import { loadGameDb, loadNormalizedDb } from '../src/db/index.js';
import { listMods, modArchive, modArchivePath, modsDefiningRecords, resolveModArchive } from '../src/db/mods.js';
import { findGameDir } from '../src/db/gamefiles.js';
import { parseGdc } from '../src/save/gdc.js';
import { characterMasteries } from '../src/save/mastery.js';
import { customCharacterSavePath, customCharacters, haveCustomSaves, haveGameInstall } from './paths.js';

const GAME_DIR = haveGameInstall() ? findGameDir()! : undefined;
const MODS = GAME_DIR ? listMods(GAME_DIR) : [];

/**
 * A Custom Game character whose mastery the base game cannot name *and* an
 * installed mod still defines. Both halves are required: the first is what
 * makes the character interesting, the second is what makes the pairing
 * assertable on this machine.
 */
function modCharacter(): { character: string; bars: string[]; mod: string } | undefined {
  if (!GAME_DIR || !haveCustomSaves()) return undefined;
  for (const character of customCharacters()) {
    const save = parseGdc(readFileSync(customCharacterSavePath(character)));
    const masteries = characterMasteries(save);
    if (!masteries.length || masteries.some((m) => m.classNumber !== undefined)) continue;
    const bars = masteries.map((m) => m.record);
    const [defining] = modsDefiningRecords(GAME_DIR, bars);
    if (defining) return { character, bars, mod: defining.mod };
  }
  return undefined;
}

const SUBJECT = modCharacter();

describe.skipIf(!GAME_DIR)('installed mods', () => {
  it('lists only the directories that actually ship a database', () => {
    for (const mod of MODS) {
      // The convention up to case: this install has
      // `mods/survivalmode/database/SurvivalMode.arz`, which composing the path
      // finds on macOS and Windows and would miss on a Linux prefix. What is
      // asserted is the file, not the spelling.
      expect(mod.archivePath.toLowerCase()).toBe(modArchivePath(GAME_DIR!, mod.name).toLowerCase());
      expect(() => readFileSync(mod.archivePath)).not.toThrow();
    }
  });

  it('finds a mod however the name is cased, and reports it as the disk spells it', () => {
    if (!MODS.length) return;
    const asked = MODS[0]!.name.toUpperCase();
    const found = resolveModArchive(GAME_DIR!, asked);
    expect(found?.name).toBe(MODS[0]!.name);
    expect(found?.archivePath).toBe(MODS[0]!.archivePath);
    expect(resolveModArchive(GAME_DIR!, 'not-a-mod-on-this-machine')).toBeUndefined();
  });

  it('says so, and what it does have, when asked for a mod that is not installed', () => {
    expect(() => modArchive(GAME_DIR!, 'not-a-mod-on-this-machine')).toThrow(/no mod database at/);
  });

  it('stats a mod that is there', () => {
    if (!MODS.length) return;
    const archive = modArchive(GAME_DIR!, MODS[0]!.name);
    expect(archive.expansion).toBe(MODS[0]!.name);
    expect(archive.size).toBeGreaterThan(0);
  });

  it('finds nothing for a record no mod defines', () => {
    expect(modsDefiningRecords(GAME_DIR!, ['records/skills/playerclassnosuchthing/_classtraining_x.dbr'])).toEqual([]);
  });

  it('names the mod that defines records taken out of that mod', () => {
    if (!MODS.length) return;
    // The positive half of the search, asked without a Custom Game character in
    // the picture: read record paths straight out of an installed mod's archive
    // and require the search to attribute them to it. This is what keeps a
    // broken `modsDefiningRecords` from reading as "the mod is not installed".
    const mod = MODS[0]!;
    const names = arzRecordNames(readFileSync(mod.archivePath));
    expect(names.length).toBeGreaterThan(0);
    const sample = [names[0]!, names[Math.floor(names.length / 2)]!, names.at(-1)!];

    const found = modsDefiningRecords(GAME_DIR!, sample);
    expect(found.map((f) => f.mod)).toContain(mod.name);
    expect(found.find((f) => f.mod === mod.name)!.found).toHaveLength(sample.length);

    // One record it has and one it cannot have is not a match: the search
    // answers "holds every record asked for", which is what makes it an answer.
    expect(modsDefiningRecords(GAME_DIR!, [sample[0]!, 'records/skills/playerclassnosuchthing/_x.dbr'])).toEqual([]);
  });

  it.runIf(SUBJECT)('finds the mod that defines a Custom Game character’s mastery', () => {
    const found = modsDefiningRecords(GAME_DIR!, SUBJECT!.bars);

    // Exactly the mods holding *every* record asked for. The others installed
    // here — the stock Crucible among them — define no player classes at all,
    // which is what makes this an answer rather than a list.
    expect(found.length, `${SUBJECT!.character}: ${found.map((f) => f.mod).join(', ')}`).toBeGreaterThan(0);
    expect(found.every((f) => f.found.length === SUBJECT!.bars.length)).toBe(true);
    expect(found.length).toBeLessThan(MODS.length + 1);
  });

  it.runIf(SUBJECT)('and that mod’s database can name the class the save’s tag spells', async () => {
    const db = await loadGameDb({ gameDir: GAME_DIR!, mod: SUBJECT!.mod });
    const save = parseGdc(readFileSync(customCharacterSavePath(SUBJECT!.character)));

    // The whole point: the numbers the mod declares, recomposed, are the class
    // tag the save has been carrying all along.
    const numbers = characterMasteries(save, db).map((m) => m.classNumber);
    expect(numbers.every((n) => n !== undefined)).toBe(true);
    expect(save.classRecord).toBe(`tagSkillClassName${[...numbers].sort().join('')}`);

    // …and the base game, on its own, still cannot.
    const base = await loadGameDb({ gameDir: GAME_DIR! });
    expect(characterMasteries(save, base).every((m) => m.classNumber === undefined)).toBe(true);
  }, 60_000);

  it.runIf(SUBJECT)('caches a mod-aware database beside the plain one, not over it', async () => {
    const withMod = await loadNormalizedDb({ gameDir: GAME_DIR!, mod: SUBJECT!.mod });
    const base = await loadNormalizedDb({ gameDir: GAME_DIR! });
    // The AI Companion shares this cache and asks only about the campaign; a
    // mod-aware build written under the plain fingerprint would answer it.
    expect(withMod.fingerprint).not.toBe(base.fingerprint);
    expect(withMod.archives).toContain(SUBJECT!.mod);
    expect(base.archives).not.toContain(SUBJECT!.mod);
  }, 60_000);
});
