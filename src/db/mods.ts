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

/**
 * Where a mod's database lives, by the convention the game itself follows.
 *
 * This composes the path; it does not claim the file is there, and on a
 * case-sensitive filesystem it may not even be spelled that way — see
 * `resolveModArchive`. Use it to write one, or to say in an error message where
 * one was looked for.
 */
export function modArchivePath(gameDir: string, name: string): string {
  return join(gameDir, 'mods', name, 'database', `${name}.arz`);
}

/**
 * The archive a mod actually ships, found by matching rather than by composing.
 *
 * The convention is `mods/<name>/database/<name>.arz`, and it is a convention
 * about the *game's* lookup, not about what an author typed: this install has
 * `mods/survivalmode/database/SurvivalMode.arz`. On macOS and Windows that
 * composes and opens anyway, which is exactly why it has to be matched here —
 * the same mod on a Linux install (Proton, a case-sensitive prefix) would
 * simply not be found, and "no mod database" is the wrong answer to give
 * someone whose mod is right there. The directory is matched the same way, and
 * the name is reported back as the disk spells it.
 */
export function resolveModArchive(gameDir: string, name: string): InstalledMod | undefined {
  const modsDir = join(gameDir, 'mods');
  const wantedDir = name.toLowerCase();
  const dir = safeReaddir(modsDir).find((d) => d.toLowerCase() === wantedDir);
  if (dir === undefined) return undefined;

  const databaseDir = join(modsDir, dir, 'database');
  const wantedFile = `${dir.toLowerCase()}.arz`;
  const file = safeReaddir(databaseDir).find((f) => f.toLowerCase() === wantedFile);
  if (file === undefined) return undefined;

  return { name: dir, archivePath: join(databaseDir, file) };
}

/** Every mod in this install that ships a database, in directory order. */
export function listMods(gameDir: string): InstalledMod[] {
  const out: InstalledMod[] = [];
  for (const name of safeReaddir(join(gameDir, 'mods'))) {
    // A loose file in `mods/` (`database.arz`, `scripts.arc`) resolves to
    // nothing, which is the test — a mod is a directory with a database.
    const found = resolveModArchive(gameDir, name);
    if (found) out.push(found);
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
  const found = resolveModArchive(gameDir, name);
  if (!found) {
    const installed = listMods(gameDir).map((m) => m.name);
    throw new Error(
      `no mod database at ${modArchivePath(gameDir, name)}` +
        (installed.length ? ` — this install has: ${installed.join(', ')}` : ' — this install has no mods'),
    );
  }
  const st = statSync(found.archivePath);
  return { expansion: found.name, path: found.archivePath, size: st.size, mtimeMs: st.mtimeMs };
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
