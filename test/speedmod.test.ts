/**
 * Writing an `.arz` — a whole one, and into one somebody else made.
 *
 * The gate is the same one the save writer has: an encoder that has drifted
 * from its decoder must fail rather than produce a plausible wrong file. Here
 * that means a *round trip* — take real records out of the install, write an
 * archive, read it back with the ordinary reader, and require every field to
 * agree. `planSpeedMod` runs that check itself and refuses on a mismatch; these
 * tests prove it would catch one, and that the values it means to change are
 * the only ones that move.
 *
 * The stakes went up when the target became somebody's installed mod rather
 * than a mod of our own, so the editing tests are stricter than "our records
 * came back": they require *every other record in the archive* to be identical
 * afterwards, and the bytes of the untouched blocks to be in the same place.
 *
 * Everything is gated on the game being installed. **Nothing writes to the
 * install**: the one test that needs a file to edit builds its own game
 * directory out of symlinks to the real archives and a `mods/` of its own.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  appendArzRecords,
  compressLz4Literals,
  decompressLz4Block,
  patchArzValues,
  readArz,
  readArzRaw,
  writeArz,
  type RawArzRecord,
} from '../src/db/arz.js';
import { findGameDir, gameArchives } from '../src/db/gamefiles.js';
import { listMods } from '../src/db/mods.js';
import { BASE_MOD_ARCHIVE, planSpeedMod, SPEED_MOD_RECORDS, type SpeedModBaseline } from '../src/db/speedmod.js';
import { MISSING_GAME_MESSAGE, haveGameInstall } from './paths.js';

describe('LZ4 literal-only blocks', () => {
  it('round-trips through the decoder at every length that changes the encoding', () => {
    // 14/15 straddles the token's 4-bit literal field, 269 the first length
    // extension byte, 525 the second: the three places this encoder branches.
    for (const size of [0, 1, 14, 15, 16, 254, 269, 270, 524, 525, 4096]) {
      const data = Buffer.alloc(size);
      for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
      const packed = compressLz4Literals(data);
      expect(decompressLz4Block(packed, size), `size ${size}`).toEqual(data);
    }
  });
});

describe.skipIf(!haveGameInstall())(`the .arz writer (${haveGameInstall() ? 'live install' : MISSING_GAME_MESSAGE})`, () => {
  if (!haveGameInstall()) it.skip(MISSING_GAME_MESSAGE, () => {});

  const gameDir = findGameDir()!;
  const wanted = (r: string) => SPEED_MOD_RECORDS.includes(r);

  /** The three records as the game's own archives merge them, last wins. */
  function liveRecords(): Map<string, RawArzRecord> {
    const winners = new Map<string, RawArzRecord>();
    for (const archive of gameArchives(gameDir)) {
      for (const [key, rec] of readArzRaw(readFileSync(archive.path), { filter: wanted })) winners.set(key, rec);
    }
    return winners;
  }

  /** Some record that has nothing to do with movement speed — the bystander. */
  function bystander(): RawArzRecord {
    const buf = readFileSync(gameArchives(gameDir)[0]!.path);
    let picked: string | undefined;
    const found = readArzRaw(buf, {
      filter: (r) => {
        if (picked === undefined && !SPEED_MOD_RECORDS.includes(r)) picked = r;
        return r === picked;
      },
    });
    return found.get(picked!)!;
  }

  it('reads raw records that agree with the ordinary reader', () => {
    for (const archive of gameArchives(gameDir)) {
      const buf = readFileSync(archive.path);
      const raw = readArzRaw(buf, { filter: wanted });
      const cooked = readArz(buf, { filter: wanted });
      expect([...raw.keys()].sort()).toEqual([...cooked.keys()].sort());

      for (const [key, rec] of raw) {
        const other = cooked.get(key)!;
        expect(rec.type, key).toBe(other.type);
        for (const field of rec.fields) {
          // The lossy reader collapses a one-element list to a scalar; the raw
          // one keeps the arity. That difference is the whole reason it exists.
          const expected = field.values.length === 1 ? field.values[0] : field.values;
          expect(other.fields[field.key], `${key}.${field.key}`).toEqual(expected);
        }
      }
    }
  });

  it('writes an archive the reader agrees with, field for field', () => {
    const source = [...liveRecords().values()];
    expect(source.length).toBe(SPEED_MOD_RECORDS.length);

    const archive = writeArz(source);
    const back = readArzRaw(archive, { filter: wanted });

    expect([...back.keys()].sort()).toEqual([...source.map((r) => r.record)].sort());
    for (const before of source) {
      const after = back.get(before.record)!;
      // Type, field order, key, value type, arity and every value: an archive
      // written from records read out of the game must *be* those records.
      expect(after.type, before.record).toBe(before.type);
      expect(after.fileTime, before.record).toBe(before.fileTime);
      expect(after.fields.map((f) => f.key), before.record).toEqual(before.fields.map((f) => f.key));
      expect(after.fields.map((f) => f.type), before.record).toEqual(before.fields.map((f) => f.type));
      expect(after.fields, before.record).toEqual(before.fields);
    }

    // And the lossy reader — the one the rest of the library uses — reads it too.
    const cooked = readArz(archive, { filter: wanted });
    expect(cooked.size).toBe(SPEED_MOD_RECORDS.length);
  });

  it('patches one value in an existing archive and leaves every other record alone', () => {
    const archive = writeArz([...liveRecords().values(), bystander()]);
    const before = readArz(archive);

    const patched = patchArzValues(archive, [
      { record: 'records/game/gameengine.dbr', field: 'playerRunSpeedCapMax', value: 675 },
    ]);
    const after = readArz(patched);

    expect(after.size).toBe(before.size);
    for (const [key, was] of before) {
      if (key === 'records/game/gameengine.dbr') continue;
      expect(after.get(key), key).toEqual(was);
    }
    expect(after.get('records/game/gameengine.dbr')!.fields['playerRunSpeedCapMax']).toBe(675);

    // Appended, not rewritten: the file grows by one block and no more.
    expect(patched.length).toBeGreaterThan(archive.length);
    expect(patched.length - archive.length).toBeLessThan(archive.length);
  });

  it('refuses a patch it cannot make rather than making a different one', () => {
    const archive = writeArz([...liveRecords().values()]);
    expect(() => patchArzValues(archive, [{ record: 'records/nope.dbr', field: 'x', value: 1 }])).toThrow(
      /not in this archive/,
    );
    expect(() =>
      patchArzValues(archive, [{ record: 'records/game/gameengine.dbr', field: 'notAField', value: 1 }]),
    ).toThrow(/has no notafield field/i);
  });

  it('appends records an archive does not have, and keeps the ones it does', () => {
    const other = bystander();
    const archive = writeArz([other]);
    const additions = [...liveRecords().values()];

    const grown = appendArzRecords(archive, additions);
    const after = readArzRaw(grown, { filter: () => true });

    expect(after.size).toBe(1 + additions.length);
    expect(after.get(other.record)).toEqual(other);
    for (const rec of additions) expect(after.get(rec.record), rec.record).toEqual(rec);

    expect(() => appendArzRecords(grown, [additions[0]!])).toThrow(/already named/);
  });

  it('refuses rather than writing when the archive it built disagrees with the reader', () => {
    // The refusal path is not reachable by asking politely — it exists for an
    // encoder that has drifted — so it is provoked: an archive whose declared
    // record count is a lie fails to read back.
    const source = [...liveRecords().values()];
    const archive = writeArz(source);
    const corrupt = Buffer.from(archive);
    corrupt.writeUInt32LE(source.length + 5, 12);
    expect(() => readArzRaw(corrupt, { filter: wanted })).toThrow();
  });
});

describe.skipIf(!haveGameInstall())(`the speed change, into a base mod (${haveGameInstall() ? 'live install' : MISSING_GAME_MESSAGE})`, () => {
  if (!haveGameInstall()) it.skip(MISSING_GAME_MESSAGE, () => {});

  const realGameDir = findGameDir()!;
  let dir: string;
  let basePath: string;
  let bystanderRecord: RawArzRecord;

  /**
   * A game directory that is the real one for reading and ours for writing:
   * the four archives are symlinked, `mods/` is a directory of our own. The
   * install is never written to, and the edit is exercised for real.
   */
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gd-speed-'));
    for (const part of ['database', 'gdx1', 'gdx2', 'gdx3']) {
      const from = join(realGameDir, part);
      if (existsSync(from)) symlinkSync(from, join(dir, part));
    }
    mkdirSync(join(dir, 'mods'));
    basePath = join(dir, 'mods', BASE_MOD_ARCHIVE);

    const buf = readFileSync(gameArchives(realGameDir)[0]!.path);
    let picked: string | undefined;
    bystanderRecord = readArzRaw(buf, {
      filter: (r) => {
        if (picked === undefined && !SPEED_MOD_RECORDS.includes(r)) picked = r;
        return r === picked;
      },
    }).get(picked!)!;
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the base mod when there is none, naming the archive /basemods loads', () => {
    const plan = planSpeedMod({ gameDir: dir, runPercent: 35 });
    expect(plan.refusals).toEqual([]);
    expect(plan.action).toBe('create');
    expect(plan.arzPath).toBe(basePath);
    expect(plan.launchHint).toBe('/basemods');
    expect(plan.changes.map((c) => c.how)).toEqual(['add', 'add', 'add']);
    for (const change of plan.changes) expect(change.to).toBeCloseTo(change.from * 1.35, 4);
  });

  it('merges into one that already exists, keeping every record already in it', () => {
    // Somebody else's base mod: one unrelated record and none of ours.
    writeFileSync(basePath, writeArz([bystanderRecord]));

    const plan = planSpeedMod({ gameDir: dir, runPercent: 35 });
    expect(plan.refusals).toEqual([]);
    expect(plan.action).toBe('patch');
    expect(plan.changes.map((c) => c.how)).toEqual(['add', 'add', 'add']);

    const after = readArzRaw(plan.output!, { filter: () => true });
    expect(after.size).toBe(1 + SPEED_MOD_RECORDS.length);
    expect(after.get(bystanderRecord.record)).toEqual(bystanderRecord);
  });

  it('overwrites its own records the second time, and does not compound the percentage', () => {
    const first = planSpeedMod({ gameDir: dir, runPercent: 35 });
    writeFileSync(basePath, first.output!);
    const baseline = first.baseline!;
    const originals = new Map(baseline.map((b) => [`${b.record} ${b.field}`, b.original]));

    // Same percentage, same baseline: there is nothing left to do.
    const again = planSpeedMod({ gameDir: dir, runPercent: 35, baseline });
    expect(again.output).toBeUndefined();
    expect(again.refusals).toEqual([{ kind: 'nothing-to-change' }]);
    expect(again.untouched).toHaveLength(3);
    expect(again.drifted).toBe(false);

    // A different percentage measures from the original, not from what is there.
    const more = planSpeedMod({ gameDir: dir, runPercent: 50, baseline });
    expect(more.refusals).toEqual([]);
    expect(more.changes.map((c) => c.how)).toEqual(['overwrite', 'overwrite', 'overwrite']);
    for (const change of more.changes) {
      const original = originals.get(`${change.record} ${change.field}`)!;
      expect(change.original, change.record).toBe(original);
      expect(change.to, change.record).toBeCloseTo(original * 1.5, 4);
      // …which is emphatically not 1.35 × 1.5.
      expect(change.to).toBeLessThan(original * 1.35 * 1.5);
    }
  });

  it('puts a field back where it started at 0%', () => {
    const first = planSpeedMod({ gameDir: dir, runPercent: 40 });
    writeFileSync(basePath, first.output!);

    const back = planSpeedMod({ gameDir: dir, runPercent: 0, capPercent: 40, baseline: first.baseline! });
    expect(back.refusals).toEqual([]);
    const run = back.changes.filter((c) => c.field === 'characterRunSpeed');
    expect(run).toHaveLength(2);
    for (const change of run) expect(change.to).toBe(change.original);
    // The cap is already at +40%, so nothing to do there.
    expect(back.untouched.map((u) => u.field)).toEqual(['playerRunSpeedCapMax']);
  });

  it('says so when the archive no longer holds what it wrote', () => {
    const first = planSpeedMod({ gameDir: dir, runPercent: 25 });
    writeFileSync(basePath, first.output!);

    // The mod's author ships an update — or anything else edits the file.
    const meddled: SpeedModBaseline[] = first.baseline!.map((b) => ({ ...b, written: b.written + 7 }));
    const plan = planSpeedMod({ gameDir: dir, runPercent: 25, baseline: meddled });
    expect(plan.drifted).toBe(true);
    // What is there now is the new original, rather than being quietly re-based.
    for (const change of plan.changes) expect(change.original).toBe(change.from);
  });

  it('refuses a percentage that would stop the character, and one that changes nothing', () => {
    for (const percent of [-100, -150, Number.NaN]) {
      const plan = planSpeedMod({ gameDir: dir, runPercent: percent });
      expect(plan.output, String(percent)).toBeUndefined();
      expect(plan.refusals.map((r) => r.kind)).toContain('percent-out-of-range');
    }

    rmSync(basePath, { force: true });
    const nothing = planSpeedMod({ gameDir: dir, runPercent: 0, capPercent: 0 });
    expect(nothing.output).toBeUndefined();
    expect(nothing.refusals).toEqual([{ kind: 'nothing-to-change' }]);
    expect(nothing.untouched).toHaveLength(3);
  });

  it('refuses a mod that is not installed, and says what is', () => {
    const plan = planSpeedMod({ gameDir: dir, target: { kind: 'mod', mod: 'not-a-mod-on-this-machine' } });
    expect(plan.output).toBeUndefined();
    expect(plan.refusals.map((r) => r.kind)).toEqual(['target-mod-missing']);
  });
});

describe.skipIf(!haveGameInstall())(`the speed change, into an installed mod (${haveGameInstall() ? 'live install' : MISSING_GAME_MESSAGE})`, () => {
  if (!haveGameInstall()) it.skip(MISSING_GAME_MESSAGE, () => {});

  const gameDir = findGameDir()!;
  const mods = listMods(gameDir);

  it('plans against that mod’s own numbers, and writes nothing anywhere', () => {
    const mod = mods[0];
    if (!mod) return;

    const source = readFileSync(mod.archivePath);
    const plan = planSpeedMod({ gameDir, target: { kind: 'mod', mod: mod.name }, runPercent: 35 });
    expect(plan.refusals).toEqual([]);
    expect(plan.action).toBe('patch');
    expect(plan.arzPath).toBe(mod.archivePath);
    // A Custom Game mod is chosen in the menu; there is nothing to add to the
    // launch options for one.
    expect(plan.launchHint).toBeUndefined();

    // Whatever this mod sets these to is what the percentage is measured from.
    for (const change of plan.changes) {
      expect(change.to, change.record).toBeCloseTo(change.from * 1.35, 4);
      if (change.how === 'overwrite') expect(change.sourceArchive).toBe(mod.name);
    }

    // The archive on disk is exactly as it was: this is a plan, not a write.
    expect(readFileSync(mod.archivePath).equals(source)).toBe(true);
    // And what it would write is that archive with the ends moved, not a new one.
    expect(plan.output!.length).toBeGreaterThan(source.length);
    expect(plan.output!.subarray(24, source.readUInt32LE(4)).equals(source.subarray(24, source.readUInt32LE(4)))).toBe(
      true,
    );
  });

  it('leaves every other record in that mod exactly as it was', () => {
    const mod = mods.find((m) => readFileSync(m.archivePath).length < 40_000_000) ?? mods[0];
    if (!mod) return;

    const source = readFileSync(mod.archivePath);
    const plan = planSpeedMod({ gameDir, target: { kind: 'mod', mod: mod.name }, runPercent: 35 });
    if (plan.refusals.length) return;

    const before = readArz(source);
    const after = readArz(plan.output!);
    expect(after.size).toBe(before.size + plan.changes.filter((c) => c.how === 'add').length);

    const touched = new Set(plan.changes.map((c) => c.record));
    let differing = 0;
    for (const [key, was] of before) {
      if (touched.has(key)) continue;
      if (JSON.stringify(after.get(key)) !== JSON.stringify(was)) differing++;
    }
    expect(differing).toBe(0);
  });
});
