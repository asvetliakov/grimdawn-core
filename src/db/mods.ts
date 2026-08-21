/**
 * Installed mods, and which of them defines a given record.
 *
 * A mod is a directory under `<gameDir>/mods/` holding
 * `database/<name>.arz` — the same conventional path the speed-mod writer
 * builds and the game's own `/basemods` switch loads. `mods/` also holds loose
 * files (`database.arz`, `scripts.arc`) and the stock Crucible, so "a directory
 * in there" is not the test; having that archive is.
 *
 * The question this module exists to answer is the one a save cannot: a Custom
 * Game character records nothing about the mod it belongs to — every one of
 * them lands flat in `save/user/<name>` — so the only honest way to find the
 * database that defines a character's mastery is to look for a mod whose
 * archive contains that record. Which is cheap: `readArz`'s filter runs against
 * the record table before anything is decompressed, so a filter that always
 * answers `false` walks a 79 MB archive in about 40 ms and reads no records at
 * all.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { safeReaddir } from '../platform.js';
import { readArz } from './arz.js';
import type { GameArchive } from './gamefiles.js';

export interface InstalledMod {
  name: string;
  archivePath: string;
}

/** Where a mod's database lives, by the convention the game itself follows. */
export function modArchivePath(gameDir: string, name: string): string {
  return join(gameDir, 'mods', name, 'database', `${name}.arz`);
}

/** Every mod in this install that ships a database, in directory order. */
export function listMods(gameDir: string): InstalledMod[] {
  const out: InstalledMod[] = [];
  for (const name of safeReaddir(join(gameDir, 'mods'))) {
    const archivePath = modArchivePath(gameDir, name);
    try {
      statSync(archivePath);
    } catch {
      continue; // a loose file, or a mod shipping only resources
    }
    out.push({ name, archivePath });
  }
  return out;
}

/**
 * A mod's archive as one more entry in the load order.
 *
 * Throws when it is not there, unlike the expansion archives a user may simply
 * not own: a mod is only ever loaded because something named it, and silently
 * building a database without it would answer questions about a mod that was
 * never read.
 */
export function modArchive(gameDir: string, name: string): GameArchive {
  const path = modArchivePath(gameDir, name);
  let st;
  try {
    st = statSync(path);
  } catch {
    const installed = listMods(gameDir).map((m) => m.name);
    throw new Error(
      `no mod database at ${path}` +
        (installed.length ? ` — this install has: ${installed.join(', ')}` : ' — this install has no mods'),
    );
  }
  return { expansion: name, path, size: st.size, mtimeMs: st.mtimeMs };
}

/**
 * Which installed mods define all of `records`.
 *
 * Nothing is decompressed: the filter is consulted once per record path in the
 * archive's table and always answers `false`, so this reads names and stops.
 * An unreadable archive is skipped rather than thrown — a half-installed mod is
 * a fact about the machine, and the caller's question is "which mod has these",
 * not "is every mod here well-formed".
 */
export function modsDefiningRecords(
  gameDir: string,
  records: readonly string[],
): { mod: string; found: string[] }[] {
  const wanted = new Set(records.map((r) => r.toLowerCase()));
  const out: { mod: string; found: string[] }[] = [];

  for (const { name, archivePath } of listMods(gameDir)) {
    const found = new Set<string>();
    try {
      readArz(readFileSync(archivePath), {
        filter: (record) => {
          if (wanted.has(record.toLowerCase())) found.add(record.toLowerCase());
          return false;
        },
      });
    } catch {
      continue;
    }
    if (found.size === wanted.size && wanted.size > 0) out.push({ mod: name, found: [...found] });
  }
  return out;
}
