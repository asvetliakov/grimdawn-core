/**
 * Where the installs and the save trees are.
 *
 * A path search that quietly finds nothing looks exactly like a game that is not
 * installed, so these assertions are what stands between "detection broke" and a
 * shrug. Nothing here knows about a window or an app — it is the composed-roots
 * machinery, and it travels with the parsing library rather than with either
 * tool that uses it.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { candidateGameDirs, findGameDirs } from '../src/db/gamefiles.js';
import { findSaveDirs } from '../src/paths.js';
import { documentRoots, steamRoots, windowsRoots } from '../src/platform.js';
import { haveGameInstall, haveSaves, MISSING_GAME_MESSAGE, MISSING_SAVES_MESSAGE, SAVE_DIR } from './paths.js';

describe('finding the game and its saves', () => {
  it('looks for GOG as well as Steam, on every platform', () => {
    const candidates = candidateGameDirs();
    // The store is orthogonal to the wrapper: a GOG copy inside a CrossOver
    // bottle is a `drive_c/GOG Games/Grim Dawn`, and this machine's roots must
    // produce that candidate even though the copy here is a Steam one.
    if (windowsRoots().length > 0) {
      expect(candidates.some((c) => c.includes('GOG Games'))).toBe(true);
      expect(candidates.some((c) => c.includes('GOG Galaxy'))).toBe(true);
    }
    expect(candidates.some((c) => c.includes(join('steamapps', 'common', 'Grim Dawn')))).toBe(true);
    // Every candidate is a distinct absolute path — a duplicate would mean the
    // roots were composed twice and the search was doing double the work.
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it('reports Steam roots and document roots without throwing on this machine', () => {
    // The contract is "an unreadable path is an empty list, never a crash".
    expect(Array.isArray(steamRoots())).toBe(true);
    expect(Array.isArray(documentRoots())).toBe(true);
  });

  it.runIf(haveGameInstall())('finds the install that is actually here', () => {
    expect(findGameDirs().length).toBeGreaterThan(0);
  });
  it.runIf(!haveGameInstall())(MISSING_GAME_MESSAGE, () => {});

  it.runIf(haveSaves())('finds the save tree that is actually here', () => {
    // `GD_SAVE_DIR` overrides the search, so what is asserted is that the search
    // itself still reaches the real one.
    expect(findSaveDirs()).toContain(SAVE_DIR);
  });
  it.runIf(!haveSaves())(MISSING_SAVES_MESSAGE, () => {});
});
