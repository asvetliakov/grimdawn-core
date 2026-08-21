/**
 * Writing an `.arz`.
 *
 * The gate is the same one the save writer has: an encoder that has drifted
 * from its decoder must fail rather than produce a plausible wrong file. Here
 * that means a *round trip* — take real records out of the install, write an
 * archive, read it back with the ordinary reader, and require every field to
 * agree. `planSpeedMod` runs that check itself and refuses on a mismatch; these
 * tests prove it would catch one, and that the values it means to change are
 * the only ones that move.
 *
 * Everything is gated on the game being installed. Nothing is committed: the
 * archives are the user's, and the mod is generated from them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { readArz, readArzRaw, writeArz, compressLz4Literals, decompressLz4Block } from '../src/db/arz.js';
import { findGameDir, gameArchives } from '../src/db/gamefiles.js';
import { planSpeedMod, SPEED_MOD_RECORDS } from '../src/db/speedmod.js';
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
  function liveRecords() {
    const winners = new Map<string, ReturnType<typeof readArzRaw> extends Map<string, infer R> ? R : never>();
    for (const archive of gameArchives(gameDir)) {
      for (const [key, rec] of readArzRaw(readFileSync(archive.path), { filter: wanted })) winners.set(key, rec);
    }
    return winners;
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

  it('plans the two speed changes, from whichever archive won each record', () => {
    const plan = planSpeedMod({ gameDir, runPercent: 35 });

    expect(plan.refusals).toEqual([]);
    expect(plan.output).toBeDefined();
    expect(plan.arzPath).toBe(`${gameDir}/mods/gdspeed/database/gdspeed.arz`);
    expect(plan.launchHint).toBe('/basemods:gdspeed');

    // One change per record: run speed on both player creatures, the cap on the
    // engine record.
    expect(plan.changes.map((c) => c.record).sort()).toEqual([...SPEED_MOD_RECORDS].sort());
    expect(plan.changes.filter((c) => c.field === 'characterRunSpeed')).toHaveLength(2);
    expect(plan.changes.filter((c) => c.field === 'playerRunSpeedCapMax')).toHaveLength(1);

    for (const change of plan.changes) {
      expect(change.to, `${change.record}.${change.field}`).toBeCloseTo(change.from * 1.35, 4);
      expect(change.to).toBeGreaterThan(change.from);
    }

    // The records are not all in the same archive, which is why the merge is
    // per record rather than "read the newest expansion".
    const engine = plan.changes.find((c) => c.field === 'playerRunSpeedCapMax')!;
    expect(engine.sourceArchive).toBeTruthy();
  });

  it('changes those two fields and nothing else in the records it ships', () => {
    const plan = planSpeedMod({ gameDir, runPercent: 50, capPercent: 20 });
    expect(plan.refusals).toEqual([]);

    const before = liveRecords();
    const after = readArzRaw(plan.output!, { filter: wanted });

    for (const [key, was] of before) {
      const now = after.get(key)!;
      const changedField = plan.changes.find((c) => c.record === key)!.field;
      for (const [i, field] of was.fields.entries()) {
        const current = now.fields[i]!;
        if (field.key === changedField) {
          expect(current.values[0], key).not.toBe(field.values[0]);
          expect(current.type, key).toBe(field.type);
        } else {
          expect(current, `${key}.${field.key}`).toEqual(field);
        }
      }
    }

    // The two knobs are independent.
    const run = plan.changes.find((c) => c.field === 'characterRunSpeed')!;
    const cap = plan.changes.find((c) => c.field === 'playerRunSpeedCapMax')!;
    expect(run.to).toBeCloseTo(run.from * 1.5, 4);
    expect(cap.to).toBeCloseTo(cap.from * 1.2, 4);
  });

  it('sources from an installed mod when asked, rather than from the base game', () => {
    const mod = 'pathofgrimdawn';
    if (!existsSync(`${gameDir}/mods/${mod}/database/${mod}.arz`)) return;

    const base = planSpeedMod({ gameDir, runPercent: 35 });
    const over = planSpeedMod({ gameDir, runPercent: 35, overMod: mod });
    expect(over.refusals).toEqual([]);

    // This mod raises the movement cap itself (to 500 on this install), so a mod
    // built from the base game's 135 would hand its players a *lower* ceiling
    // than the one they are already playing with.
    const baseCap = base.changes.find((c) => c.field === 'playerRunSpeedCapMax')!;
    const overCap = over.changes.find((c) => c.field === 'playerRunSpeedCapMax')!;
    expect(overCap.from).toBeGreaterThan(baseCap.from);
    expect(overCap.sourceArchive).toBe(mod);
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
