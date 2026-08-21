/**
 * The extracted game database, cached on disk.
 *
 * ```
 *   <cacheRoot>/<fingerprint>/     one directory per game build
 *     db-<locale>.json             normalized database — the fast startup path
 *     icons/<flattened>.png        one PNG per texture, extracted on demand
 * ```
 *
 * The directory is keyed by a fingerprint of the game's `.arz` archives rather
 * than by version string, because a game patch rewrites the archives and so
 * rotates the key on its own — which is what makes "rebuild exactly once per game
 * version" fall out without anything having to know the version first.
 * `db.json` records the human-readable `gameVersion` inside itself.
 *
 * Nothing here is ever committed — it is all game-derived data, and all of it is
 * re-derivable from the install, so deleting the directory costs a few seconds.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { DB_SCHEMA_VERSION, type NormalizedDb } from './build.js';

/**
 * Where extracted databases live, in three tiers.
 *
 * The cache belongs to the *install*, not to whoever is reading it: it is keyed
 * by an archive fingerprint, holds nothing app-specific, and takes half a minute
 * to build. So the default root is shared — a second tool against the same game
 * starts warm instead of extracting 41,000 records again — while each app keeps
 * its own settings and its own writes elsewhere (`appDataDir` in the app).
 *
 * `GD_CACHE_DIR` points the cache alone somewhere else. `GD_DATA_DIR` is the
 * blunter instrument tests reach for: it moves an app's data dir *and* nests the
 * cache inside it, so one variable gives a run complete isolation.
 */
export function defaultCacheRoot(): string {
  if (process.env.GD_CACHE_DIR) return process.env.GD_CACHE_DIR;
  if (process.env.GD_DATA_DIR) return join(process.env.GD_DATA_DIR, 'cache');
  return join(homedir(), 'Library/Application Support/grimdawn-core/cache');
}

export function cacheRoot(): string {
  return defaultCacheRoot();
}

export function buildCacheDir(fingerprint: string): string {
  return join(cacheRoot(), fingerprint);
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * One database per language, sharing the build's icon directory — icons are the
 * same picture whatever the item is called, and re-extracting 3,844 of them to
 * read an item name in German would be silly.
 */
export function dbPath(fingerprint: string, locale: string): string {
  return join(buildCacheDir(fingerprint), `db-${locale.toLowerCase()}.json`);
}

/**
 * Load the normalized database for a game build and language, or undefined if it
 * is absent or stale. A cache written by an older schema is treated as absent
 * rather than migrated — it costs a couple of seconds to rebuild and cannot be
 * misread.
 */
export function readCachedDb(fingerprint: string, locale: string): NormalizedDb | undefined {
  const path = dbPath(fingerprint, locale);
  if (!existsSync(path)) return undefined;
  try {
    const db = JSON.parse(readFileSync(path, 'utf8')) as NormalizedDb;
    if (db.schemaVersion !== DB_SCHEMA_VERSION) return undefined;
    // The filename already says the language; this catches a file that was
    // copied or renamed by hand into claiming one it does not hold.
    if (db.locale.toLowerCase() !== locale.toLowerCase()) return undefined;
    return db;
  } catch {
    // A half-written cache (interrupted build) reads as no cache.
    return undefined;
  }
}

/**
 * Written via a temporary file and renamed into place. Two processes can
 * plausibly build at once — the CLI while the UI starts, or two vitest workers —
 * and `rename` is atomic, so a reader sees either the old database or the new
 * one and never a half-written file.
 */
export function writeCachedDb(db: NormalizedDb): void {
  const dir = ensureDir(buildCacheDir(db.fingerprint));
  const path = dbPath(db.fingerprint, db.locale);
  const temp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(db));
  renameSync(temp, path);
}

/** Drop a build's cache directory — what `db --refresh` does before rebuilding. */
export function clearCachedBuild(fingerprint: string): void {
  rmSync(buildCacheDir(fingerprint), { recursive: true, force: true });
}
