/**
 * Writing an `.arc`, and taking entries out of one.
 *
 * The gate is the reader's own `open()`, which refuses an archive whose three
 * tables do not exactly fill the tail — so a writer that miscounts a single
 * byte cannot produce a file that opens at all. On top of that the tests demand
 * the round trip: what `writeArc` puts in must come back byte for byte, and
 * what `removeArcEntries` leaves alone must be identical to what was there.
 *
 * The interesting half is `removeArcEntries`, because it is the only way to
 * retire a mod's stale override: an entry is not deleted so much as *stopped
 * from shadowing* the game's own copy of that file. It carries the data region
 * and the chunk table over untouched, so the tests check that the bytes really
 * did not move rather than just that the archive still parses.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ArcArchive, removeArcEntries, writeArc, type ArcFile } from '../src/db/arc.js';
import { findGameDir } from '../src/db/gamefiles.js';
import { haveGameInstall, MISSING_GAME_MESSAGE } from './paths.js';

describe('the .arc writer', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gd-arcwrite-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write to a temp file and open it — the reader only takes a path. */
  function roundTrip(files: readonly ArcFile[], name = 'out.arc'): ArcArchive {
    const path = join(dir, name);
    writeFileSync(path, writeArc(files));
    return ArcArchive.open(path);
  }

  function body(size: number, seed: number): Buffer {
    const data = Buffer.allocUnsafe(size);
    for (let i = 0; i < size; i++) data[i] = (i * 31 + seed) & 0xff;
    return data;
  }

  it('writes an archive the reader opens, and hands every file back unchanged', () => {
    const files: ArcFile[] = [
      { name: 'tags_one.txt', data: Buffer.from('tagOne=Hello\r\ntagTwo=World\r\n', 'utf8') },
      { name: 'nested/tags_two.txt', data: body(9_000, 7) },
      { name: 'empty.txt', data: Buffer.alloc(0) },
    ];

    const arc = roundTrip(files);
    try {
      expect(arc.size).toBe(files.length);
      expect(arc.names().sort()).toEqual(files.map((f) => f.name).sort());
      for (const file of files) expect(arc.read(file.name), file.name).toEqual(file.data);
      // Lookups are case-insensitive, as they are on the game's own archives.
      expect(arc.read('TAGS_ONE.TXT')).toEqual(files[0]!.data);
      expect(arc.read('nope.txt')).toBeUndefined();
    } finally {
      arc.close();
    }
  });

  it('splits a file past the chunk size and puts it back together', () => {
    // 256 KB is the cap every shipped archive uses; this crosses it twice.
    const big = body(600_000, 3);
    const arc = roundTrip([{ name: 'big.bin', data: big }], 'big.arc');
    try {
      const entry = arc.find('big.bin')!;
      expect(entry.chunkCount).toBe(3);
      expect(entry.decompressedSize).toBe(big.length);
      expect(arc.read('big.bin')).toEqual(big);
    } finally {
      arc.close();
    }
  });

  it('carries a fileTime through, so an archive can be rebuilt as it was', () => {
    const stamp = 133221745240300000n;
    const arc = roundTrip([{ name: 'stamped.txt', data: Buffer.from('x'), fileTime: stamp }], 'stamp.arc');
    try {
      expect(arc.find('stamped.txt')!.fileTime).toBe(stamp);
    } finally {
      arc.close();
    }
  });

  it('refuses to name one file twice', () => {
    const data = Buffer.from('x');
    expect(() => writeArc([{ name: 'a.txt', data }, { name: 'A.TXT', data }])).toThrow(/named twice/);
  });

  it('refuses to edit something that is not an archive', () => {
    expect(() => removeArcEntries(Buffer.alloc(8), ['a'])).toThrow(/not an \.arc archive/);
    const wrong = Buffer.alloc(64);
    wrong.write('ARC\0', 0, 'latin1');
    wrong.writeUInt32LE(9, 4);
    expect(() => removeArcEntries(wrong, ['a'])).toThrow(/unsupported \.arc version 9/);
  });

  it('removes an entry and leaves every other file exactly as it was', () => {
    const files: ArcFile[] = [
      { name: 'keep_one.txt', data: body(5_000, 1) },
      { name: 'drop_me.txt', data: body(3_000, 2) },
      { name: 'keep_two.txt', data: body(400_000, 3) }, // multi-chunk, to prove indices survive
    ];
    const source = writeArc(files);

    const trimmed = removeArcEntries(source, ['DROP_ME.TXT']); // case-insensitive
    const path = join(dir, 'trimmed.arc');
    writeFileSync(path, trimmed);
    const arc = ArcArchive.open(path);
    try {
      expect(arc.size).toBe(2);
      expect(arc.names().sort()).toEqual(['keep_one.txt', 'keep_two.txt']);
      expect(arc.read('drop_me.txt')).toBeUndefined();
      // The survivors still read — including the one whose chunks are indexed
      // past the removed entry's.
      expect(arc.read('keep_one.txt')).toEqual(files[0]!.data);
      expect(arc.read('keep_two.txt')).toEqual(files[2]!.data);
    } finally {
      arc.close();
    }

    // The data region and the chunk table were carried over, not rebuilt.
    const tableOffset = source.readUInt32LE(24);
    const chunkTableSize = source.readUInt32LE(16);
    expect(trimmed.subarray(28, tableOffset + chunkTableSize).equals(source.subarray(28, tableOffset + chunkTableSize))).toBe(true);
    expect(trimmed.readUInt32LE(24)).toBe(tableOffset);
    expect(trimmed.readUInt32LE(12)).toBe(source.readUInt32LE(12));
  });

  it('refuses a name the archive does not have, rather than reporting it removed', () => {
    const source = writeArc([{ name: 'a.txt', data: Buffer.from('x') }]);
    expect(() => removeArcEntries(source, ['a.txt', 'ghost.txt'])).toThrow(/not in this archive: ghost\.txt/);
    // Nothing to remove is not an error, and does not disturb a byte.
    expect(removeArcEntries(source, []).equals(source)).toBe(true);
  });
});

describe.skipIf(!haveGameInstall())(
  `the .arc writer, against the game's own (${haveGameInstall() ? 'live install' : MISSING_GAME_MESSAGE})`,
  () => {
    if (!haveGameInstall()) it.skip(MISSING_GAME_MESSAGE, () => {});

    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'gd-arcreal-'));
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('rebuilds a real text archive, entry for entry', () => {
      const source = ArcArchive.open(join(findGameDir()!, 'resources/Text_EN.arc'));
      const files: ArcFile[] = [];
      try {
        for (const name of source.names()) {
          const entry = source.find(name)!;
          files.push({ name, data: source.read(name)!, fileTime: entry.fileTime });
        }
      } finally {
        source.close();
      }
      expect(files.length).toBeGreaterThan(0);

      const path = join(dir, 'text_en.arc');
      writeFileSync(path, writeArc(files));
      const rebuilt = ArcArchive.open(path);
      try {
        expect(rebuilt.size).toBe(files.length);
        for (const file of files) {
          expect(rebuilt.read(file.name), file.name).toEqual(file.data);
          expect(rebuilt.find(file.name)!.fileTime, file.name).toBe(file.fileTime);
        }
      } finally {
        rebuilt.close();
      }
    });

    it('drops one entry from a real archive and reads the rest back identically', () => {
      const path = join(findGameDir()!, 'resources/Text_EN.arc');
      const source = readFileSync(path);
      const before = ArcArchive.open(path);
      let victim: string;
      const kept = new Map<string, Buffer>();
      try {
        const names = before.names();
        victim = names[0]!;
        for (const name of names.slice(1)) kept.set(name, before.read(name)!);
      } finally {
        before.close();
      }

      const out = join(dir, 'trimmed_text.arc');
      writeFileSync(out, removeArcEntries(source, [victim]));
      const after = ArcArchive.open(out);
      try {
        expect(after.size).toBe(kept.size);
        expect(after.read(victim)).toBeUndefined();
        for (const [name, data] of kept) expect(after.read(name), name).toEqual(data);
      } finally {
        after.close();
      }
      // And the install is untouched.
      expect(readFileSync(path).equals(source)).toBe(true);
    });
  },
);

describe('tombstones', () => {
  it('refuses to write an entry with no name', () => {
    // A nameless entry cannot be looked up. Real archives carry them as dead
    // space with a declared size of zero; reading one back yields whatever
    // bytes it points at, and writing that out makes dead space live.
    expect(() => writeArc([{ name: '', data: Buffer.from('x') }])).toThrow(/must have a name/);
  });
});
