/**
 * Writing an `.arz` — a whole one, and into one somebody else made.
 *
 * The gate is the same one the save writer has: an encoder that has drifted
 * from its decoder must fail rather than produce a plausible wrong file. Here
 * that means a *round trip* — take real records out of the install, write an
 * archive, read it back with the ordinary reader, and require every field to
 * agree. `planGameData` runs that check itself and refuses on a mismatch; these
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
  replaceArzRecords,
  writeArz,
  type RawArzRecord,
} from '../src/db/arz.js';
import { findGameDir, gameArchives } from '../src/db/gamefiles.js';
import { listMods } from '../src/db/mods.js';
import {
  BASE_MOD_ARCHIVE,
  CONTAINER_HIGHLIGHT_FX,
  planGameData,
  recordsForKnobs,
  type GameDataBaseline,
} from '../src/db/gamedata.js';
import { sweepIndex } from '../src/db/sweepindex.js';

/** The three records the two movement-speed knobs live on. */
const SPEED_RECORDS = recordsForKnobs({ run: 0, cap: 0 });
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
  const wanted = (r: string) => SPEED_RECORDS.includes(r);

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
        if (picked === undefined && !SPEED_RECORDS.includes(r)) picked = r;
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
    expect(source.length).toBe(SPEED_RECORDS.length);

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
    expect(cooked.size).toBe(SPEED_RECORDS.length);
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

    expect(() => appendArzRecords(grown, [additions[0]!])).toThrow(/already a record/);
  });

  it('appends a record whose name the archive already interns but does not define', () => {
    // The case the campaign's own base mod is: something in it *points* at
    // `playerlevels.dbr`, so the path is in the string table, while no record
    // defines it. Guarding on the strings refused exactly the append the speed
    // and cap changes need.
    const additions = [...liveRecords().values()];
    const namer = bystander();
    const referenced = additions[0]!.record;
    namer.fields.push({ key: 'someRecordPointer', type: 2, values: [referenced] });

    const archive = writeArz([namer]);
    expect(readArzRaw(archive, { filter: (r) => r === referenced }).size).toBe(0);

    const grown = appendArzRecords(archive, additions);
    const after = readArzRaw(grown, { filter: () => true });
    expect(after.size).toBe(1 + additions.length);
    for (const rec of additions) expect(after.get(rec.record), rec.record).toEqual(rec);
    // The name was already interned, so it is reused rather than added twice.
    expect(after.get(namer.record)!.fields.find((f) => f.key === 'someRecordPointer')!.values).toEqual([referenced]);
  });

  const ENGINE = 'records/game/gameengine.dbr';

  /** One record out of an archive, losslessly. */
  function raw(archive: Buffer, record: string): RawArzRecord {
    return readArzRaw(archive, { filter: (r) => r === record }).get(record)!;
  }

  /** A copy of a record with one field's values replaced. */
  function withValues(rec: RawArzRecord, key: string, values: (number | string)[]): RawArzRecord {
    return {
      ...rec,
      fields: rec.fields.map((f) => (f.key.toLowerCase() === key.toLowerCase() ? { ...f, values } : f)),
    };
  }

  it('replaces a record whole, and leaves every other record where it was', () => {
    const archive = writeArz([...liveRecords().values(), bystander()]);
    const before = readArz(archive);

    const replaced = replaceArzRecords(archive, [withValues(raw(archive, ENGINE), 'playerRunSpeedCapMax', [675])]);
    const after = readArz(replaced);

    expect(after.size).toBe(before.size);
    for (const [key, was] of before) {
      if (key === ENGINE) continue;
      expect(after.get(key), key).toEqual(was);
    }
    expect(after.get(ENGINE)!.fields['playerRunSpeedCapMax']).toBe(675);

    // Appended, not rewritten: the data section is byte for byte where it was,
    // the record count did not move, and the file grew by about one block.
    const dataEnd = archive.readUInt32LE(4);
    expect(replaced.subarray(24, dataEnd).equals(archive.subarray(24, dataEnd))).toBe(true);
    expect(replaced.readUInt32LE(12)).toBe(archive.readUInt32LE(12));
    expect(replaced.length - archive.length).toBeLessThan(archive.length);
  });

  it('takes strings the archive has never held, and keeps every index already written', () => {
    const archive = writeArz([...liveRecords().values(), bystander()]);
    const before = readArz(archive);
    const path = 'records/creatures/pc/malepc01.dbr';
    const source = raw(archive, path);

    // A string value nothing in this archive mentions, on a field that already
    // holds one — the case `patchArzValues` cannot write at all.
    const stringField = source.fields.find((f) => f.type === 2 && f.values.length === 1)!;
    const novel = 'records/creatures/pc/anm_malepc_ported_by_this_test.dbr';
    const replaced = replaceArzRecords(archive, [withValues(source, stringField.key, [novel])]);
    const after = readArz(replaced);

    expect(after.get(path)!.fields[stringField.key]).toBe(novel);
    expect(replaced.readUInt32LE(20)).toBeGreaterThan(archive.readUInt32LE(20));
    // Appending to the string table left every index already written valid.
    for (const [key, was] of before) {
      if (key === path) continue;
      expect(after.get(key), key).toEqual(was);
    }
  });

  it('adds fields the record never had, with keys the archive never held', () => {
    const archive = writeArz([...liveRecords().values()]);
    const source = raw(archive, ENGINE);
    const grown: RawArzRecord = {
      ...source,
      fields: [
        ...source.fields,
        { key: 'aFieldThisArchiveHasNeverHeardOf', type: 0, values: [7] },
        { key: 'andAStringOne', type: 2, values: ['records/some/new/target.dbr'] },
      ],
    };

    const back = raw(replaceArzRecords(archive, [grown]), ENGINE);
    expect(back.fields.map((f) => f.key)).toEqual(grown.fields.map((f) => f.key));
    expect(back.fields).toEqual(grown.fields);
  });

  it('changes a record’s template type, entry length and all', () => {
    const archive = writeArz([...liveRecords().values(), bystander()]);
    const source = raw(archive, ENGINE);
    const count = readArz(archive).size;

    // Shorter and longer than the original: a type lives inline in the record
    // table, so either direction moves the string table.
    for (const type of ['X', `${source.type}_MuchLongerThanItWas`]) {
      const out = replaceArzRecords(archive, [{ ...source, type }]);
      const back = readArzRaw(out, { filter: () => true });
      expect(back.get(ENGINE)!.type, type).toBe(type);
      expect(back.size, type).toBe(count);
      expect(out.readUInt32LE(4) + out.readUInt32LE(8), type).toBe(out.readUInt32LE(16));
      expect(out.readUInt32LE(16) + out.readUInt32LE(20), type).toBe(out.length - 16);
    }
  });

  it('writes the fileTime it is given, and keeps the one it is not asked to change', () => {
    const archive = writeArz([...liveRecords().values()]);
    const source = raw(archive, ENGINE);

    expect(raw(replaceArzRecords(archive, [source]), ENGINE).fileTime).toBe(source.fileTime);
    expect(raw(replaceArzRecords(archive, [{ ...source, fileTime: 123456789n }]), ENGINE).fileTime).toBe(123456789n);
  });

  it('refuses a record it cannot replace rather than adding one', () => {
    const archive = writeArz([...liveRecords().values()]);
    const source = raw(archive, ENGINE);

    expect(() => replaceArzRecords(archive, [{ ...source, record: 'records/nope.dbr' }])).toThrow(
      /not in this archive/,
    );
    expect(() => replaceArzRecords(archive, [source, source])).toThrow(/twice/);
    // Nothing to do is not an error, and does not disturb a byte.
    expect(replaceArzRecords(archive, []).equals(archive)).toBe(true);
  });

  it('replaces a record inside a real installed mod, leaving the rest of it alone', () => {
    const installed = listMods(gameDir);
    const mod = installed.find((m) => readFileSync(m.archivePath).length < 40_000_000) ?? installed[0];
    if (!mod) return;

    const source = readFileSync(mod.archivePath);
    const before = readArz(source);
    const path = [...before.keys()][0];
    if (!path) return;

    // Replacing a record with itself: every record in the archive, the replaced
    // one included, must read back exactly as it did.
    const out = replaceArzRecords(source, [raw(source, path)]);
    const after = readArz(out);

    expect(after.size).toBe(before.size);
    let differing = 0;
    for (const [key, was] of before) {
      if (JSON.stringify(after.get(key)) !== JSON.stringify(was)) differing++;
    }
    expect(differing).toBe(0);

    const dataEnd = source.readUInt32LE(4);
    expect(out.subarray(24, dataEnd).equals(source.subarray(24, dataEnd))).toBe(true);
    // And nothing was written to the install.
    expect(readFileSync(mod.archivePath).equals(source)).toBe(true);
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
        if (picked === undefined && !SPEED_RECORDS.includes(r)) picked = r;
        return r === picked;
      },
    }).get(picked!)!;
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the base mod when there is none, naming the archive /basemods loads', () => {
    const plan = planGameData({ gameDir: dir, knobs: { run: 35, cap: 35 } });
    expect(plan.refusals).toEqual([]);
    expect(plan.action).toBe('create');
    expect(plan.arzPath).toBe(basePath);
    expect(plan.launchHint).toBe('/basemods');
    expect(plan.changes.map((c) => c.how)).toEqual(['add', 'add', 'add']);
    for (const change of plan.changes) expect(change.to).toBeCloseTo(change.from * 1.35, 4);
  });

  const LEVELS = 'records/creatures/pc/playerlevels.dbr';

  it('sets the level and devotion caps to the number asked for, not a percentage of it', () => {
    const plan = planGameData({ gameDir: dir, knobs: { maxLevel: 150, maxDevotionPoints: 80 } });
    expect(plan.refusals).toEqual([]);
    expect(plan.changes.map((c) => [c.knob, c.to])).toEqual([
      ['maxLevel', 150],
      ['maxDevotionPoints', 80],
    ]);
    // Both knobs live on the one record, and it is added exactly once carrying
    // both — the case that used to append it twice and lose the first change.
    expect(plan.changes.map((c) => c.record)).toEqual([LEVELS, LEVELS]);

    const back = readArzRaw(plan.output!, { filter: (r) => r === LEVELS });
    expect(back.size).toBe(1);
    const fields = back.get(LEVELS)!.fields;
    expect(fields.find((f) => f.key === 'maxPlayerLevel')!.values).toEqual([150]);
    expect(fields.find((f) => f.key === 'maxDevotionPoints')!.values).toEqual([80]);
    // The rest of the record came along untouched, list fields included.
    expect(fields.find((f) => f.key === 'skillModifierPoints')!.values.length).toBeGreaterThan(100);
  });

  it('reads only the records the knobs it was given live on', () => {
    const speed = planGameData({ gameDir: dir, knobs: { run: 35, cap: 35 } });
    expect(speed.refusals).toEqual([]);
    expect(speed.changes.some((c) => c.record === LEVELS)).toBe(false);

    const caps = planGameData({ gameDir: dir, knobs: { maxLevel: 150 } });
    expect(caps.refusals).toEqual([]);
    expect(caps.changes.every((c) => c.record === LEVELS)).toBe(true);
    expect(caps.changes.length).toBe(1);
  });

  it('refuses a level cap past the last level the skill table has an entry for', () => {
    const plan = planGameData({ gameDir: dir, knobs: { maxLevel: 4000 } });
    const refusal = plan.refusals.find((r) => r.kind === 'level-above-skill-table');
    expect(refusal).toBeDefined();
    // The length is read out of the merged record rather than assumed here.
    expect(refusal).toMatchObject({ value: 4000 });
    expect((refusal as { entries: number }).entries).toBeGreaterThan(100);
    expect(plan.output).toBeUndefined();
  });

  it('refuses when no knob was named at all, and says so differently', () => {
    const plan = planGameData({ gameDir: dir, knobs: {} });
    expect(plan.refusals).toEqual([{ kind: 'nothing-asked-for' }]);
    expect(plan.output).toBeUndefined();
  });

  it('carries forward the marks it did not look at, so one knob cannot forget another', () => {
    // The hazard this guards: applying a level cap on its own used to hand back
    // a baseline holding only the level entries. Writing that would drop what
    // the speed started at, and the next +35% would compound on this tool's own
    // output.
    const speed = planGameData({ gameDir: dir, knobs: { run: 35, cap: 35 } });
    const afterSpeed = speed.baseline!;
    expect(afterSpeed.length).toBe(3);

    const level = planGameData({ gameDir: dir, knobs: { maxLevel: 150 }, baseline: afterSpeed });
    expect(level.refusals).toEqual([]);
    const kept = level.baseline!.filter((b) => b.field === 'characterRunSpeed' || b.field === 'playerRunSpeedCapMax');
    expect(kept).toEqual(afterSpeed);
    expect(level.baseline!.some((b) => b.field === 'maxPlayerLevel')).toBe(true);
  });

  it('has nothing to change when an absolute knob already holds the number asked for', () => {
    const plan = planGameData({ gameDir: dir, knobs: { maxLevel: 150 } });
    const first = readArzRaw(plan.output!, { filter: (r) => r === LEVELS }).get(LEVELS)!;
    const held = first.fields.find((f) => f.key === 'maxPlayerLevel')!.values[0];
    expect(held).toBe(150);

    // Asking for the number the merged records already carry is idle, not a write.
    const same = planGameData({ gameDir: dir, knobs: { maxLevel: 100 } });
    expect(same.refusals).toEqual([{ kind: 'nothing-to-change' }]);
    expect(same.untouched.map((u) => u.knob)).toEqual(['maxLevel']);
  });

  it('refuses a cap of zero rather than reading it as "leave it alone"', () => {
    const plan = planGameData({ gameDir: dir, knobs: { maxDevotionPoints: 0 } });
    expect(plan.refusals).toEqual([
      { kind: 'value-out-of-range', knob: 'maxDevotionPoints', value: 0, min: 1, max: 9999 },
    ]);
  });

  describe('sweeps — one value across every record a rule selects', () => {
    // Built once: the scan is seconds, and every case here asks the same
    // questions of it.
    const index = () => sweepIndex(realGameDir);

    it('describes what it would do without building the archive', () => {
      const plan = planGameData({
        gameDir: dir,
        knobs: {},
        sweeps: { pickupRadius: 2.7, ironPiles: 1 },
        index: index(),
        build: false,
      });
      expect(plan.refusals).toEqual([]);
      // The window re-plans on every keystroke; making 54 MB of archive each
      // time is what `build: false` exists to avoid.
      expect(plan.output).toBeUndefined();
      expect(plan.sweeps.map((s) => s.sweep).sort()).toEqual(['ironPiles', 'pickupRadius']);
      const iron = plan.sweeps.find((s) => s.sweep === 'ironPiles')!;
      expect(iron.changing + iron.already).toBe(18);
    });

    it('refuses a sweep it was given no index for, rather than scanning behind the caller', () => {
      const plan = planGameData({ gameDir: dir, knobs: {}, sweeps: { ironPiles: 1 } });
      expect(plan.refusals).toEqual([{ kind: 'sweep-index-missing' }]);
    });

    it('sets both gold fields from the one knob, on exactly the records that have them', () => {
      const plan = planGameData({ gameDir: dir, knobs: {}, sweeps: { ironPiles: 1 }, index: index() });
      expect(plan.refusals).toEqual([]);
      const back = readArzRaw(plan.output!, { filter: () => true });
      expect(back.size).toBe(18);
      for (const [path, rec] of back) {
        expect(rec.fields.find((f) => f.key === 'goldSplitMin')!.values, path).toEqual([1]);
        expect(rec.fields.find((f) => f.key === 'goldSplitMax')!.values, path).toEqual([1]);
      }
    });

    it('adds a field the record has never had, carrying every field it did have', () => {
      // `patchArzValues` cannot do this — it overwrites in place — so this is
      // the whole-record replace path, and the thing to check is that nothing
      // else fell off the record on the way through.
      const plan = planGameData({ gameDir: dir, knobs: {}, sweeps: { highlightContainers: true }, index: index() });
      expect(plan.refusals).toEqual([]);
      const back = readArzRaw(plan.output!, { filter: () => true });
      expect(back.size).toBeGreaterThan(100);
      for (const [path, rec] of back) {
        expect(rec.fields.find((f) => f.key === 'IdleEffect')!.values, path).toEqual([CONTAINER_HIGHLIGHT_FX]);
        // A container carries far more than the one field it gained.
        expect(rec.fields.length, path).toBeGreaterThan(5);
        expect(rec.fields.find((f) => f.key === 'templateName'), path).toBeDefined();
      }
    });

    it('leaves alone a record already at or above what a raising sweep asks for', () => {
      // `markerRange` runs to 500 in the stock data, so setting everything to
      // 250 would pull in a marker that is already visible from farther — the
      // opposite of what asking for it means.
      const plan = planGameData({ gameDir: dir, knobs: {}, sweeps: { markerRange: 250 }, index: index(), build: false });
      const marker = plan.sweeps.find((s) => s.sweep === 'markerRange')!;
      expect(marker.already).toBeGreaterThan(0);
      // At 1 almost everything is already above it; only the handful sitting at
      // 0 rise to meet it, and nothing is pulled down to it.
      const low = planGameData({ gameDir: dir, knobs: {}, sweeps: { markerRange: 1 }, index: index(), build: false });
      const atOne = low.sweeps.find((s) => s.sweep === 'markerRange')!;
      expect(atOne.already).toBeGreaterThan(marker.already);
      expect(atOne.changing).toBeLessThan(marker.changing);
    });

    it('writes a sweep and a named knob into one archive, and keeps no baseline for the sweep', () => {
      const plan = planGameData({
        gameDir: dir,
        knobs: { maxLevel: 120 },
        sweeps: { ironPiles: 1 },
        index: index(),
      });
      expect(plan.refusals).toEqual([]);
      const back = readArzRaw(plan.output!, { filter: () => true });
      expect(back.has('records/creatures/pc/playerlevels.dbr')).toBe(true);
      expect(back.size).toBe(19);
      // The knob is remembered so a percentage cannot compound; the sweep is
      // absolute and idempotent, and ten thousand originals do not belong in a
      // settings file. Putting a sweep back means restoring the archive.
      expect(plan.baseline!.map((b) => b.field)).toEqual(['maxPlayerLevel']);
    });

    it('has nothing to change when the sweep is already applied', () => {
      const first = planGameData({ gameDir: dir, knobs: {}, sweeps: { ironPiles: 1 }, index: index() });
      const path = join(dir, 'mods', BASE_MOD_ARCHIVE);
      writeFileSync(path, first.output!);
      try {
        const again = planGameData({ gameDir: dir, knobs: {}, sweeps: { ironPiles: 1 }, index: index(), build: false });
        expect(again.refusals).toEqual([{ kind: 'nothing-to-change' }]);
      } finally {
        rmSync(path, { force: true });
      }
    });

    it('refuses a value outside the range rather than writing it', () => {
      const plan = planGameData({ gameDir: dir, knobs: {}, sweeps: { pickupRadius: 500 }, index: index(), build: false });
      expect(plan.refusals).toEqual([{ kind: 'sweep-out-of-range', sweep: 'pickupRadius', value: 500, min: 0.1, max: 20 }]);
    });
  });

  it('merges into one that already exists, keeping every record already in it', () => {
    // Somebody else's base mod: one unrelated record and none of ours.
    writeFileSync(basePath, writeArz([bystanderRecord]));

    const plan = planGameData({ gameDir: dir, knobs: { run: 35, cap: 35 } });
    expect(plan.refusals).toEqual([]);
    expect(plan.action).toBe('patch');
    expect(plan.changes.map((c) => c.how)).toEqual(['add', 'add', 'add']);

    const after = readArzRaw(plan.output!, { filter: () => true });
    expect(after.size).toBe(1 + SPEED_RECORDS.length);
    expect(after.get(bystanderRecord.record)).toEqual(bystanderRecord);
  });

  it('overwrites its own records the second time, and does not compound the percentage', () => {
    const first = planGameData({ gameDir: dir, knobs: { run: 35, cap: 35 } });
    writeFileSync(basePath, first.output!);
    const baseline = first.baseline!;
    const originals = new Map(baseline.map((b) => [`${b.record} ${b.field}`, b.original]));

    // Same percentage, same baseline: there is nothing left to do.
    const again = planGameData({ gameDir: dir, knobs: { run: 35, cap: 35 }, baseline });
    expect(again.output).toBeUndefined();
    expect(again.refusals).toEqual([{ kind: 'nothing-to-change' }]);
    expect(again.untouched).toHaveLength(3);
    expect(again.drifted).toBe(false);

    // A different percentage measures from the original, not from what is there.
    const more = planGameData({ gameDir: dir, knobs: { run: 50, cap: 50 }, baseline });
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
    const first = planGameData({ gameDir: dir, knobs: { run: 40, cap: 40 } });
    writeFileSync(basePath, first.output!);

    const back = planGameData({ gameDir: dir, knobs: { run: 0, cap: 40 }, baseline: first.baseline! });
    expect(back.refusals).toEqual([]);
    const run = back.changes.filter((c) => c.field === 'characterRunSpeed');
    expect(run).toHaveLength(2);
    for (const change of run) expect(change.to).toBe(change.original);
    // The cap is already at +40%, so nothing to do there.
    expect(back.untouched.map((u) => u.field)).toEqual(['playerRunSpeedCapMax']);
  });

  it('says so when the archive no longer holds what it wrote', () => {
    const first = planGameData({ gameDir: dir, knobs: { run: 25, cap: 25 } });
    writeFileSync(basePath, first.output!);

    // The mod's author ships an update — or anything else edits the file.
    const meddled: GameDataBaseline[] = first.baseline!.map((b) => ({ ...b, written: b.written + 7 }));
    const plan = planGameData({ gameDir: dir, knobs: { run: 25, cap: 25 }, baseline: meddled });
    expect(plan.drifted).toBe(true);
    // What is there now is the new original, rather than being quietly re-based.
    for (const change of plan.changes) expect(change.original).toBe(change.from);
  });

  it('refuses a percentage that would stop the character, and one that changes nothing', () => {
    for (const percent of [-100, -150, Number.NaN]) {
      const plan = planGameData({ gameDir: dir, knobs: { run: percent, cap: percent } });
      expect(plan.output, String(percent)).toBeUndefined();
      expect(plan.refusals.map((r) => r.kind)).toContain('value-out-of-range');
    }

    rmSync(basePath, { force: true });
    const nothing = planGameData({ gameDir: dir, knobs: { run: 0, cap: 0 } });
    expect(nothing.output).toBeUndefined();
    expect(nothing.refusals).toEqual([{ kind: 'nothing-to-change' }]);
    expect(nothing.untouched).toHaveLength(3);
  });

  it('refuses a mod that is not installed, and says what is', () => {
    const plan = planGameData({ gameDir: dir, knobs: { run: 35 }, target: { kind: 'mod', mod: 'not-a-mod-on-this-machine' } });
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
    const plan = planGameData({ gameDir, target: { kind: 'mod', mod: mod.name }, knobs: { run: 35, cap: 35 } });
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
    const plan = planGameData({ gameDir, target: { kind: 'mod', mod: mod.name }, knobs: { run: 35, cap: 35 } });
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
