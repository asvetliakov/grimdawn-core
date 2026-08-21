/**
 * A generated mod that makes the character walk faster.
 *
 * Movement speed is two numbers in the game's own records: the player's base
 * rate (`characterRunSpeed`, 0.93 on the two player creature records) and the
 * ceiling that `+% movement speed` gear counts up to (`playerRunSpeedCapMax`,
 * 135 on the engine record). Raising them is a data change, not a save edit —
 * it is true of every character, including ones made later — so it ships as a
 * Grim Dawn mod: `<gameDir>/mods/<name>/database/<name>.arz`.
 *
 * **Generated on the user's machine from the user's install, never shipped.**
 * The records are read out of the archives that are actually there and written
 * back with two fields changed. That is the same rule the rest of this library
 * follows for game data, and here it also happens to be the only correct one: a
 * mod built against another install's records would quietly revert whatever
 * that build changed.
 *
 * Which archive a record comes from matters. The four archives merge last-wins,
 * and the winners are not all in the same file — on this install both player
 * creature records win from GDX3 while the engine record exists *only* in the
 * base archive. Sourcing all three from one archive would silently take a
 * pre-expansion version of something.
 */

import { readFileSync } from 'node:fs';

import { readArzRaw, writeArz, type RawArzRecord } from './arz.js';
import { gameArchives } from './gamefiles.js';

/** The player creature records — one per gender, identical in every field that matters here. */
const PLAYER_RECORDS = ['records/creatures/pc/malepc01.dbr', 'records/creatures/pc/femalepc01.dbr'];
const ENGINE_RECORD = 'records/game/gameengine.dbr';

const RUN_SPEED_FIELD = 'characterRunSpeed';
const RUN_CAP_FIELD = 'playerRunSpeedCapMax';

export const SPEED_MOD_RECORDS = [...PLAYER_RECORDS, ENGINE_RECORD];

export interface SpeedModChange {
  record: string;
  field: string;
  from: number;
  to: number;
  /** Which archive this record won the merge from. */
  sourceArchive: string;
}

export type SpeedModRefusal =
  | { kind: 'record-missing'; record: string }
  | { kind: 'field-missing'; record: string; field: string }
  | { kind: 'verify-mismatch'; detail: string };

export interface SpeedModPlan {
  name: string;
  /** Where the mod goes: `<gameDir>/mods/<name>`. */
  modDir: string;
  arzPath: string;
  changes: SpeedModChange[];
  refusals: SpeedModRefusal[];
  /** The archive bytes. Present only when `refusals` is empty. */
  output?: Buffer;
  /** What to put in Steam's launch options to play the campaign with this on. */
  launchHint: string;
}

export interface SpeedModPlanInput {
  gameDir: string;
  /** Directory name under `mods/`, and the name of the `.arz` inside it. */
  name?: string;
  /** Percentage added to the base run speed. */
  runPercent?: number;
  /** Percentage added to the movement-speed cap. Defaults to `runPercent`. */
  capPercent?: number;
  /**
   * Also read the records from this installed mod's own archive, last.
   *
   * A custom-game mod usually overrides these records itself — Path of Grim
   * Dawn sets the cap to 500 — and building an override from the base game's
   * values would hand that player a *slower* cap than the mod they are playing.
   */
  overMod?: string;
}

/** `1.35 × 0.93` in float32, the way the file will store it. */
function scaled(value: number, percent: number): number {
  return Math.fround(value * (1 + percent / 100));
}

/**
 * Work out the mod, and build it. `output` is present only when nothing refused.
 */
export function planSpeedMod(input: SpeedModPlanInput): SpeedModPlan {
  const { gameDir, name = 'gdspeed', runPercent = 35 } = input;
  const capPercent = input.capPercent ?? runPercent;
  const refusals: SpeedModRefusal[] = [];
  const changes: SpeedModChange[] = [];

  const wanted = new Set(SPEED_MOD_RECORDS);
  // Only the name and the path matter here; `gameArchives` carries size and
  // mtime for the cache fingerprint, which this does not need.
  const archives: { expansion: string; path: string }[] = gameArchives(gameDir).map((a) => ({
    expansion: a.expansion,
    path: a.path,
  }));
  if (input.overMod) {
    archives.push({
      expansion: input.overMod,
      path: `${gameDir}/mods/${input.overMod}/database/${input.overMod}.arz`,
    });
  }

  // Last wins, per record — the same merge the database build does, and the
  // reason each winner remembers which archive it came from.
  const winners = new Map<string, { record: RawArzRecord; archive: string }>();
  for (const archive of archives) {
    let raw: Map<string, RawArzRecord>;
    try {
      raw = readArzRaw(readFileSync(archive.path), { filter: (r) => wanted.has(r) });
    } catch {
      continue; // an archive this install does not have, or a mod without one
    }
    for (const [key, record] of raw) winners.set(key, { record, archive: archive.expansion || 'base' });
  }

  const edited: RawArzRecord[] = [];
  for (const path of SPEED_MOD_RECORDS) {
    const found = winners.get(path);
    if (!found) {
      refusals.push({ kind: 'record-missing', record: path });
      continue;
    }
    const field = path === ENGINE_RECORD ? RUN_CAP_FIELD : RUN_SPEED_FIELD;
    const percent = path === ENGINE_RECORD ? capPercent : runPercent;

    const target = found.record.fields.find((f) => f.key === field);
    const before = target?.values[0];
    if (target === undefined || typeof before !== 'number') {
      refusals.push({ kind: 'field-missing', record: path, field });
      continue;
    }

    // Written back in the field's own type. Both are floats today; if a patch
    // ever makes one an int, the raw type says so and this rounds rather than
    // writing a float into an int field.
    const after = target.type === 1 ? scaled(before, percent) : Math.round(before * (1 + percent / 100));
    changes.push({ record: path, field, from: before, to: after, sourceArchive: found.archive });
    edited.push({
      ...found.record,
      fields: found.record.fields.map((f) => (f === target ? { ...f, values: [after] } : f)),
    });
  }

  const modDir = `${gameDir}/mods/${name}`;
  const plan: SpeedModPlan = {
    name,
    modDir,
    arzPath: `${modDir}/database/${name}.arz`,
    changes,
    refusals,
    launchHint: `/basemods:${name}`,
  };
  if (refusals.length) return plan;

  const output = writeArz(edited);

  // The same gate the save writer uses, in the only form this format allows:
  // read the archive back with the ordinary reader and require it to agree with
  // what was read out of the game, field for field, except exactly the values
  // that were meant to change. An encoder that has drifted from the decoder
  // fails here rather than producing a file the game will not load.
  const detail = verify(output, winners, changes);
  if (detail) {
    refusals.push({ kind: 'verify-mismatch', detail });
    return plan;
  }
  plan.output = output;
  return plan;
}

function verify(
  output: Buffer,
  winners: ReadonlyMap<string, { record: RawArzRecord; archive: string }>,
  changes: readonly SpeedModChange[],
): string | undefined {
  let readBack: Map<string, RawArzRecord>;
  try {
    // An explicit filter, because `WANTED_PREFIXES` does not cover
    // `femalepc01.dbr` — the database build never needed it.
    readBack = readArzRaw(output, { filter: (r) => SPEED_MOD_RECORDS.includes(r) });
  } catch (err) {
    return `the archive just written does not read back: ${(err as Error).message}`;
  }

  for (const path of SPEED_MOD_RECORDS) {
    const before = winners.get(path)?.record;
    const after = readBack.get(path);
    if (!before || !after) return `${path}: missing from the archive just written`;
    if (after.type !== before.type) return `${path}: template class changed (${before.type} → ${after.type})`;
    if (after.fields.length !== before.fields.length) {
      return `${path}: ${before.fields.length} fields in, ${after.fields.length} out`;
    }

    for (const [i, was] of before.fields.entries()) {
      const now = after.fields[i]!;
      if (now.key !== was.key) return `${path}: field ${i} is ${now.key}, expected ${was.key}`;
      if (now.type !== was.type) return `${path}.${was.key}: type ${was.type} → ${now.type}`;
      if (now.values.length !== was.values.length) {
        return `${path}.${was.key}: ${was.values.length} values in, ${now.values.length} out`;
      }

      const change = changes.find((c) => c.record === path && c.field === was.key);
      const expected = change ? [change.to] : was.values;
      for (const [j, value] of expected.entries()) {
        if (now.values[j] !== value) {
          return `${path}.${was.key}[${j}]: wrote ${String(now.values[j])}, meant ${String(value)}`;
        }
      }
    }
  }
  return undefined;
}
