/**
 * The things a consumer reaches for first: where the game and its saves are, and
 * what a parsed character is.
 *
 * Everything else is a subpath — `@grimdawn/core/save/gdc`,
 * `@grimdawn/core/db`, `@grimdawn/core/icons`, and so on. This barrel is
 * deliberately thin: re-exporting the whole library from one specifier would
 * drag the `.arz` reader and the DDS decoder into a consumer that only wanted to
 * know a save's path.
 */

export {
  characterSavePath,
  findSaveDir,
  findSaveDirs,
  formulasPath,
  listCharacters,
  potionsPath,
  reagentsPath,
  saveDir,
  SAVE_TREES,
  transferStashPath,
  type SaveTree,
} from './paths.js';

export { safeReaddir, steamRoots, windowsRoots, documentRoots, STEAM_APP_ID } from './platform.js';

export { parseGdc, parseGdcRecording } from './save/gdc.js';
export type { CharacterSave, CharacterSkill, Attributes, Difficulty, FactionRep } from './save/types.js';
export { DIFFICULTIES, parseDifficulty, EQUIP_SLOT_NAMES } from './save/types.js';
