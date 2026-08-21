/**
 * Installed mods, and finding the one that defines a character's mastery.
 *
 * Which mods are on this machine is a fact about this machine, so nothing here
 * asserts a name: the subject is "a mod that defines the classes some Custom
 * Game character is playing", found by looking. What *is* asserted is the
 * property the patcher leans on — that the search distinguishes the mod which
 * defines a record from the ones that merely exist.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { loadGameDb, loadNormalizedDb } from '../src/db/index.js';
import { listMods, modArchive, modArchivePath, modsDefiningRecords } from '../src/db/mods.js';
import { findGameDir } from '../src/db/gamefiles.js';
import { parseGdc } from '../src/save/gdc.js';
import { characterMasteries } from '../src/save/mastery.js';
import { customCharacterSavePath, customCharacters, haveCustomSaves, haveGameInstall } from './paths.js';

const GAME_DIR = haveGameInstall() ? findGameDir()! : undefined;
const MODS = GAME_DIR ? listMods(GAME_DIR) : [];

/** A Custom Game character whose mastery the base game cannot name. */
function modCharacter(): { character: string; bars: string[] } | undefined {
  if (!GAME_DIR || !haveCustomSaves()) return undefined;
  for (const character of customCharacters()) {
    const save = parseGdc(readFileSync(customCharacterSavePath(character)));
    const masteries = characterMasteries(save);
    if (masteries.length && masteries.every((m) => m.classNumber === undefined)) {
      return { character, bars: masteries.map((m) => m.record) };
    }
  }
  return undefined;
}

const SUBJECT = modCharacter();

describe.skipIf(!GAME_DIR)('installed mods', () => {
  it('lists only the directories that actually ship a database', () => {
    for (const mod of MODS) {
      expect(mod.archivePath).toBe(modArchivePath(GAME_DIR!, mod.name));
      expect(() => readFileSync(mod.archivePath)).not.toThrow();
    }
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
    const [defining] = modsDefiningRecords(GAME_DIR!, SUBJECT!.bars);
    if (!defining) return;

    const db = await loadGameDb({ gameDir: GAME_DIR!, mod: defining.mod });
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
    const [defining] = modsDefiningRecords(GAME_DIR!, SUBJECT!.bars);
    if (!defining) return;

    const withMod = await loadNormalizedDb({ gameDir: GAME_DIR!, mod: defining.mod });
    const base = await loadNormalizedDb({ gameDir: GAME_DIR! });
    // The AI Companion shares this cache and asks only about the campaign; a
    // mod-aware build written under the plain fingerprint would answer it.
    expect(withMod.fingerprint).not.toBe(base.fingerprint);
    expect(withMod.archives).toContain(defining.mod);
    expect(base.archives).not.toContain(defining.mod);
  }, 60_000);
});
