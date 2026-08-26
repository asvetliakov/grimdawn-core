/**
 * Which records a sweep touches, worked out once and remembered.
 *
 * The four named knobs in `gamedata.ts` each edit a field on a handful of
 * records this code knows by name. A **sweep** is the other shape: one value
 * set on every record that matches a rule — the pickup radius on all ten
 * thousand item records, the marker range on everything that has one. The rules
 * are what the QoL base mods do, reimplemented so the change goes through this
 * app's plan-and-refuse path instead of arriving as somebody's 34 MB archive.
 *
 * **The rules cannot be answered cheaply, and that is the whole reason this
 * module exists.** `readArzRaw`'s filter is consulted per record-table entry and
 * sees only the *name*, so selecting by path costs nothing. Every rule here
 * selects on a **field or a template**, which is inside the compressed block —
 * so answering "which records have `markerRange`" means decompressing the
 * database. Measured on a 1.3.0.8 install:
 *
 * - decompressing all 81,017 records at once **exhausts the heap**;
 * - batched, keeping only `record → value`, it is about seven seconds;
 * - reading back just the ~11,850 that matched is under a second.
 *
 * So the scan is batched so that nothing holds the whole database at once, and
 * its *answer* — paths and their current values, a few hundred kilobytes — is
 * cached against the archive fingerprint. A game patch rotates that fingerprint
 * and the scan runs again, which is the same signal that makes an applied change
 * report itself `stale`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readArzRaw, arzRecordNames, type RawArzRecord } from './arz.js';
import { buildCacheDir, ensureDir } from './cache.js';
import { archivesFingerprint, gameArchives } from './gamefiles.js';

/** The rules a sweep can select by. Each is a predicate over one merged record. */
export type SweepRule = 'items-with-actorRadius' | 'has-markerRange' | 'has-goldSplit' | 'containers';

export const SWEEP_RULES: SweepRule[] = ['items-with-actorRadius', 'has-markerRange', 'has-goldSplit', 'containers'];

/**
 * What one rule selected: every matching record, and what the merged game data
 * holds for the field in question.
 *
 * `null` means the record matched but has no such field yet — the container
 * highlight is exactly that case, and it is the difference between an edit that
 * overwrites a value and one that adds a field.
 */
export type SweepSelection = Record<string, number | string | null>;

export interface SweepIndex {
  fingerprint: string;
  rules: Record<SweepRule, SweepSelection>;
}

const CONTAINER_TEMPLATE = /fixeditemcontainer\.tpl$/i;

/** Everything any rule looks at, and nothing else. */
const SCANNED_FIELDS: ReadonlySet<string> = new Set([
  'actorRadius',
  'markerRange',
  'goldSplitMax',
  'IdleEffect',
  'templateName',
]);

function field(rec: RawArzRecord, key: string): (number | string)[] | undefined {
  return rec.fields.find((f) => f.key === key)?.values;
}

/** The field each rule reads, so the index can record what is there now. */
const RULE_FIELD: Record<SweepRule, string> = {
  'items-with-actorRadius': 'actorRadius',
  'has-markerRange': 'markerRange',
  'has-goldSplit': 'goldSplitMax',
  containers: 'IdleEffect',
};

function matches(rule: SweepRule, path: string, rec: RawArzRecord): boolean {
  switch (rule) {
    case 'items-with-actorRadius':
      return path.startsWith('records/items/') && field(rec, 'actorRadius') !== undefined;
    case 'has-markerRange':
      return field(rec, 'markerRange') !== undefined;
    case 'has-goldSplit':
      return field(rec, 'goldSplitMax') !== undefined;
    case 'containers':
      return CONTAINER_TEMPLATE.test(String(field(rec, 'templateName')?.[0] ?? ''));
  }
}

/**
 * How many second-level directories to decompress at a time.
 *
 * The trade is real and was measured: six batches is three seconds and several
 * gigabytes of peak allocation, seventeen hundred is thirty-five seconds and
 * under two. Sixty sits where the whole scan is about seven seconds without any
 * single batch being large.
 */
const BATCHES = 60;

export interface ScanProgress {
  done: number;
  total: number;
}

/** Run the scan. Nothing is cached and nothing is read from cache. */
export function scanSweeps(gameDir: string, onProgress?: (p: ScanProgress) => void): SweepIndex {
  const archives = gameArchives(gameDir);
  const buffers = archives.map((a) => readFileSync(a.path));

  // Group by the second level of the path — `records/items`, `records/skills` —
  // so a batch is a coherent slice rather than an arbitrary cut.
  const dirs = new Set<string>();
  for (const buf of buffers) for (const name of arzRecordNames(buf)) dirs.add(name.split('/').slice(0, 3).join('/'));
  const all = [...dirs];
  const size = Math.max(1, Math.ceil(all.length / BATCHES));
  const batches: string[][] = [];
  for (let i = 0; i < all.length; i += size) batches.push(all.slice(i, i + size));

  const rules = Object.fromEntries(SWEEP_RULES.map((r) => [r, {} as SweepSelection])) as Record<SweepRule, SweepSelection>;

  for (const [i, batch] of batches.entries()) {
    const prefixes = batch.map((d) => `${d}/`);
    // The game's own merge, per batch: base first, each expansion over it.
    const merged = new Map<string, RawArzRecord>();
    for (const buf of buffers) {
      for (const [path, rec] of readArzRaw(buf, {
        filter: (r) => prefixes.some((p) => r.startsWith(p)),
        // Only the five fields the rules ask about. The stream is still walked
        // in full, but a record arrives as five field objects rather than two
        // hundred — which is the difference between this scan peaking near the
        // heap limit and it barely registering. These records are read to be
        // *asked about*, never written back, so a partial record is right here.
        fields: SCANNED_FIELDS,
      })) {
        merged.set(path, rec);
      }
    }
    for (const [path, rec] of merged) {
      for (const rule of SWEEP_RULES) {
        if (!matches(rule, path, rec)) continue;
        const value = field(rec, RULE_FIELD[rule])?.[0];
        rules[rule][path] = value === undefined ? null : value;
      }
    }
    // Dropped before the next batch is read: holding two of these at once is
    // what ran the heap out in the first place.
    merged.clear();
    onProgress?.({ done: i + 1, total: batches.length });
  }

  return { fingerprint: archivesFingerprint(archives), rules };
}

function indexPath(fingerprint: string): string {
  return join(ensureDir(buildCacheDir(fingerprint)), 'sweeps.json');
}

/** The cached answer for this install, if one was built against these archives. */
export function readCachedSweeps(gameDir: string): SweepIndex | undefined {
  const fingerprint = archivesFingerprint(gameArchives(gameDir));
  try {
    const parsed = JSON.parse(readFileSync(indexPath(fingerprint), 'utf8')) as SweepIndex;
    // A patched game rotates the fingerprint, so an index built against the
    // previous build is not reused — the records it names may not be the
    // records that are there.
    if (parsed.fingerprint !== fingerprint) return undefined;
    if (SWEEP_RULES.some((r) => parsed.rules?.[r] === undefined)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * The index for this install: cached if it is there and still current, scanned
 * and written if not.
 */
export function sweepIndex(gameDir: string, onProgress?: (p: ScanProgress) => void): SweepIndex {
  const cached = readCachedSweeps(gameDir);
  if (cached) return cached;
  const built = scanSweeps(gameDir, onProgress);
  try {
    writeFileSync(indexPath(built.fingerprint), JSON.stringify(built));
  } catch {
    // A cache that cannot be written is slow, not wrong.
  }
  return built;
}
