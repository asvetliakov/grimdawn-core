/**
 * Locating the live save files.
 *
 * Tests read the user's real saves in place — they are the only fixtures that
 * prove the parsers against the actual game version. Nothing here is committed:
 * saves are game-derived data and stay out of the repo.
 *
 * Path resolution itself lives in `src/paths.ts` (and honours `GD_SAVE_DIR`),
 * so the tests exercise the same lookup the CLI uses rather than a parallel copy.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { findGameDir } from '../src/db/gamefiles.js';
import { listCharacters } from '../src/paths.js';
import { loadGameDb } from '../src/db/index.js';
import type { GameDb } from '../src/db/types.js';
import { parseGdc } from '../src/save/gdc.js';
import type { CharacterSave } from '../src/save/types.js';
import {
  characterSavePath as coreCharacterSavePath,
  formulasPath as coreFormulasPath,
  reagentsPath as coreReagentsPath,
  saveDir,
  transferStashPath as coreTransferStashPath,
} from '../src/paths.js';

/** Steam Cloud userdata save directory — override with `GD_SAVE_DIR`. */
export const SAVE_DIR = saveDir();

/**
 * The campaign characters this machine actually has, sorted.
 *
 * Discovered rather than listed. A hardcoded roster is a fixture that expires:
 * this was `['_Suchka', '_abcdef']` until `_abcdef` was deleted in game, at which
 * point `haveSaves()` went false and *every* live test in the suite skipped —
 * quietly, because a skip is what a machine without the game is supposed to
 * report. Forty-one tests stopped running and nothing said so.
 *
 * Tests that need a character with particular properties (one mastery, an
 * invested one) look for it instead of naming it — see `characterWith`.
 */
export const CHARACTERS: readonly string[] = listCharacters(SAVE_DIR, 'main');

export function characterSavePath(name: string): string {
  return coreCharacterSavePath(name, SAVE_DIR);
}

/**
 * Custom Game characters (`save/user`). Machine-dependent and optional: a
 * campaign-only install has none, so every test over them is skipped rather
 * than failed. The name deliberately collides with a campaign character here —
 * that is the case the tree parameter exists for.
 */
export function customCharacters(): string[] {
  return listCharacters(SAVE_DIR, 'user');
}

export function customCharacterSavePath(name: string): string {
  return coreCharacterSavePath(name, SAVE_DIR, 'user');
}

export function haveCustomSaves(): boolean {
  return customCharacters().length > 0;
}

export const MISSING_CUSTOM_SAVES_MESSAGE =
  `no Custom Game characters under ${SAVE_DIR}/user — ` +
  'these cover the save tree a mod or custom map writes to';

export const TRANSFER_STASH_PATH = coreTransferStashPath(SAVE_DIR);
export const FORMULAS_PATH = coreFormulasPath(SAVE_DIR);
export const REAGENTS_PATH = coreReagentsPath(SAVE_DIR);

export function haveSaves(): boolean {
  return CHARACTERS.length > 0;
}

/**
 * The first campaign character satisfying a predicate, or undefined.
 *
 * For the tests that need a *shape* rather than a name — "a character with only
 * one mastery" is what proves the last-mastery refusal, and which character that
 * is on a given machine is nobody's business but this function's.
 */
export function characterWith(matches: (save: CharacterSave) => boolean): string | undefined {
  for (const name of CHARACTERS) {
    try {
      if (matches(parseGdc(readFileSync(characterSavePath(name))))) return name;
    } catch {
      // A save being written as the suite starts is not this helper's problem.
    }
  }
  return undefined;
}

export function haveTransferStash(): boolean {
  return existsSync(TRANSFER_STASH_PATH);
}

export function haveFormulas(): boolean {
  return existsSync(FORMULAS_PATH);
}

export function haveReagents(): boolean {
  return existsSync(REAGENTS_PATH);
}

export const MISSING_SAVES_MESSAGE =
  `live Grim Dawn saves not found under ${SAVE_DIR} — ` +
  'set GD_SAVE_DIR to a save directory containing main/<character>/player.gdc to run these tests';

export const MISSING_GST_MESSAGE =
  `live transfer.gst / formulas.gst / reagents.gst not found under ${SAVE_DIR} — ` +
  'set GD_SAVE_DIR to a save directory containing them to run these tests';

/** Git-ignored snapshot copies, so a test can pin a byte-exact fixture. */
const FIXTURE_DIR = join(import.meta.dirname, 'fixtures');

function snapshot(source: string, name: string): string {
  const target = join(FIXTURE_DIR, name);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  return target;
}

/**
 * Copy a live save into `test/fixtures/` on first use and return that path.
 * The game rewrites saves as you play; snapshotting keeps a test that asserts
 * on specific values from breaking the next time the character is played.
 */
export function snapshotCharacterSave(name: string): string {
  return snapshot(characterSavePath(name), `${name}.gdc`);
}

/** Same idea for the account-wide files — the game rewrites those too. */
export function snapshotSharedSave(path: string): string {
  return snapshot(path, basename(path));
}

// ---------------------------------------------------------------------------
// The game install (Stage 3)
// ---------------------------------------------------------------------------

/**
 * The database tests need Grim Dawn itself, because item identity lives in the
 * game's `.arz` archives and nowhere else. They build the database once into the
 * *real* cache directory rather than a temp one — the build is keyed on the game
 * archives, so reusing the real cache is what keeps a full run at a second
 * instead of re-parsing 26k records for every test file.
 */
export function haveGameInstall(): boolean {
  return findGameDir() !== undefined;
}

export const MISSING_GAME_MESSAGE =
  `Grim Dawn install not found — ` +
  'set GD_GAME_DIR to a directory containing database/database.arz to run these tests';

let dbPromise: Promise<GameDb> | undefined;

/** The shared database, built at most once per test run. */
export function gameDb(): Promise<GameDb> {
  dbPromise ??= loadGameDb();
  return dbPromise;
}
