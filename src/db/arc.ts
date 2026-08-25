/**
 * Reader for Grim Dawn's `.arc` asset archives.
 *
 * Where `.arz` holds the game's records, `.arc` holds its files — textures,
 * meshes, animations, localization tables. Two callers: `icons/` reads
 * `resources/Items.arc` to turn a record's `bitmap` field into an actual icon,
 * and `gametext.ts` reads `resources/Text_<LOCALE>.arc` for the names.
 *
 * Layout, all little-endian:
 *
 * ```
 *   0  char[4]  magic 'ARC\0'
 *   4  u32      version (3)
 *   8  u32      file-entry count
 *  12  u32      chunk count
 *  16  u32      chunk-table size, bytes
 *  20  u32      string-table size, bytes
 *  24  u32      table offset — chunk table, string table and file entries, in
 *               that order, all at the tail of the file
 * ```
 *
 * A file entry is 44 bytes: `u32 storage`, `u32 offset`, `u32 compressedSize`,
 * `u32 decompressedSize`, `u32 hash`, `u64 fileTime`, `u32 chunkCount`,
 * `u32 firstChunk`, `u32 nameLength`, `u32 nameOffset` (the last two index the
 * string table). A chunk-table entry is `u32 offset`, `u32 compressedSize`,
 * `u32 decompressedSize`; a chunk whose two sizes are equal is stored verbatim,
 * anything else is an LZ4 block — same encoding `.arz` uses.
 *
 * Bulk data stays on disk: an archive is opened by file descriptor and only its
 * tables are read up front (a few hundred KB against a 450 MB `Items.arc`), so
 * extracting one icon reads one icon's worth of bytes.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';

import { decompressLz4Block } from './arz.js';

const HEADER_SIZE = 28;
const ENTRY_SIZE = 44;
const CHUNK_SIZE = 12;
const ARC_MAGIC = 'ARC\0';
const ARC_VERSION = 3;

export interface ArcEntry {
  /** In-archive path, e.g. `enchants/enchantm_black.tex`. Always as stored. */
  name: string;
  offset: number;
  compressedSize: number;
  decompressedSize: number;
  chunkCount: number;
  firstChunk: number;
  /** Windows `FILETIME`, carried through so a rebuild can put it back. */
  fileTime: bigint;
}

export class ArcArchive {
  private readonly index = new Map<string, ArcEntry>();
  private fd: number | undefined;

  private constructor(
    readonly path: string,
    fd: number,
    private readonly chunkTable: Buffer,
  ) {
    this.fd = fd;
  }

  /**
   * Open an archive and read its tables. Throws if the file is not an `.arc`;
   * callers that treat a missing archive as ordinary should check first.
   */
  static open(path: string): ArcArchive {
    const fd = openSync(path, 'r');
    try {
      const header = readAt(fd, 0, HEADER_SIZE);
      const magic = header.toString('latin1', 0, 4);
      if (magic !== ARC_MAGIC) {
        throw new Error(`not an .arc archive: magic ${JSON.stringify(magic)} != "ARC\\0"`);
      }
      const version = header.readUInt32LE(4);
      if (version !== ARC_VERSION) throw new Error(`unsupported .arc version ${version} (expected ${ARC_VERSION})`);

      const entryCount = header.readUInt32LE(8);
      const chunkTableSize = header.readUInt32LE(16);
      const stringTableSize = header.readUInt32LE(20);
      const tableOffset = header.readUInt32LE(24);

      // The three tables occupy the whole tail; if they do not, the file is
      // truncated or the layout is not what we think it is. Say so now rather
      // than read nonsense offsets later.
      const expectedSize = tableOffset + chunkTableSize + stringTableSize + entryCount * ENTRY_SIZE;
      const actualSize = statSync(path).size;
      if (expectedSize !== actualSize) {
        throw new Error(`${path}: tables end at ${expectedSize} but the file is ${actualSize} bytes`);
      }

      const chunkTable = readAt(fd, tableOffset, chunkTableSize);
      const stringTable = readAt(fd, tableOffset + chunkTableSize, stringTableSize);
      const entries = readAt(fd, tableOffset + chunkTableSize + stringTableSize, entryCount * ENTRY_SIZE);

      const archive = new ArcArchive(path, fd, chunkTable);
      for (let i = 0; i < entryCount; i++) {
        const p = i * ENTRY_SIZE;
        const nameOffset = entries.readUInt32LE(p + 40);
        const name = stringTable.toString('latin1', nameOffset, nameOffset + entries.readUInt32LE(p + 36));
        archive.index.set(name.toLowerCase(), {
          name,
          offset: entries.readUInt32LE(p + 4),
          compressedSize: entries.readUInt32LE(p + 8),
          decompressedSize: entries.readUInt32LE(p + 12),
          chunkCount: entries.readUInt32LE(p + 28),
          firstChunk: entries.readUInt32LE(p + 32),
          fileTime: entries.readBigUInt64LE(p + 20),
        });
      }
      return archive;
    } catch (err) {
      closeSync(fd);
      throw err;
    }
  }

  /** Archives were authored on Windows, so lookups are case-insensitive. */
  find(name: string): ArcEntry | undefined {
    return this.index.get(name.toLowerCase());
  }

  get size(): number {
    return this.index.size;
  }

  names(): string[] {
    return [...this.index.values()].map((e) => e.name);
  }

  /** Extract one file, or undefined when the archive does not contain it. */
  read(name: string): Buffer | undefined {
    const entry = this.find(name);
    return entry ? this.readEntry(entry) : undefined;
  }

  readEntry(entry: ArcEntry): Buffer {
    const fd = this.fd;
    if (fd === undefined) throw new Error(`${this.path} is closed`);

    // No chunks means the file is small enough to be stored whole.
    if (entry.chunkCount === 0) return readAt(fd, entry.offset, entry.compressedSize);

    const out = Buffer.allocUnsafe(entry.decompressedSize);
    let written = 0;
    for (let i = 0; i < entry.chunkCount; i++) {
      const p = (entry.firstChunk + i) * CHUNK_SIZE;
      const offset = this.chunkTable.readUInt32LE(p);
      const compressed = this.chunkTable.readUInt32LE(p + 4);
      const decompressed = this.chunkTable.readUInt32LE(p + 8);
      const raw = readAt(fd, offset, compressed);
      // Incompressible chunks are stored verbatim, flagged by equal sizes.
      const data = compressed === decompressed ? raw : decompressLz4Block(raw, decompressed);
      if (written + data.length > out.length) {
        throw new Error(`${this.path}: ${entry.name} chunks overrun its declared ${entry.decompressedSize} bytes`);
      }
      data.copy(out, written);
      written += data.length;
    }
    if (written !== entry.decompressedSize) {
      throw new Error(`${this.path}: ${entry.name} produced ${written} of ${entry.decompressedSize} bytes`);
    }
    return out;
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The largest decompressed bytes any real chunk holds — 256 KB exactly, in
 * every archive this install ships. Files bigger than that are split.
 */
const MAX_CHUNK = 262144;

/**
 * Where the first file's bytes start. The header needs 28, and every shipped
 * archive begins its data at 2048; the gap is zeros. Nothing reads it — offsets
 * are explicit — but matching the game's own layout costs one page.
 */
const DATA_START = 2048;

/** The `storage` word every live entry in a shipped archive carries. */
const STORAGE_CHUNKED = 3;

export interface ArcFile {
  /** In-archive path, stored as given; lookups are case-insensitive. */
  name: string;
  data: Buffer;
  /** Windows `FILETIME`. Round-trip an `ArcEntry`'s to rebuild an archive exactly. */
  fileTime?: bigint;
}

/**
 * Adler-32, which is what an entry's `hash` word holds — checked against every
 * entry of the game's `Text_EN.arc` and a mod's, over the *decompressed* bytes.
 *
 * Blocked at 5552 bytes, the largest run that cannot overflow the accumulator,
 * so the modulo is not paid per byte on a multi-megabyte texture.
 */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let at = 0; at < data.length; at += 5552) {
    const end = Math.min(at + 5552, data.length);
    for (let i = at; i < end; i++) {
      a += data[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Build an `.arc` from files in memory.
 *
 * Every chunk is stored **verbatim** — its two sizes equal, which is the flag
 * the reader and the game both take to mean "these bytes are the file". That is
 * a real encoding rather than a loophole: the game's own archives are full of
 * chunks written that way, 94 of them in `Items.arc` alone, for data its
 * compressor could not shrink. Writing every chunk that way costs size and buys
 * not having a compressor to get wrong — the same trade `compressLz4Literals`
 * makes for `.arz`, and this library only ever writes text-sized archives.
 *
 * A duplicate name throws: the reader indexes case-insensitively and would keep
 * whichever came last, so two entries with one name is a caller's mistake that
 * would otherwise surface as a file mysteriously not being the one written.
 */
export function writeArc(files: readonly ArcFile[]): Buffer {
  const seen = new Set<string>();
  const blobs: Buffer[] = [];
  const chunkTable: Buffer[] = [];
  const stringTable: Buffer[] = [];
  const entries: Buffer[] = [];

  let cursor = DATA_START;
  let chunkIndex = 0;
  let nameOffset = 0;

  for (const file of files) {
    const key = file.name.toLowerCase();
    // An entry with no name cannot be looked up, so it is either a mistake or
    // a tombstone somebody read back out of another archive. Neither belongs
    // in a file this writes.
    if (key === '') throw new Error('an archive entry must have a name');
    if (seen.has(key)) throw new Error(`${file.name} is named twice in this archive`);
    seen.add(key);

    const firstChunk = chunkIndex;
    const start = cursor;
    let chunkCount = 0;
    for (let at = 0; at < file.data.length; at += MAX_CHUNK) {
      const part = file.data.subarray(at, Math.min(at + MAX_CHUNK, file.data.length));
      const chunk = Buffer.alloc(CHUNK_SIZE);
      chunk.writeUInt32LE(cursor, 0);
      chunk.writeUInt32LE(part.length, 4); // stored verbatim: the two sizes agree
      chunk.writeUInt32LE(part.length, 8);
      chunkTable.push(chunk);
      blobs.push(part);
      cursor += part.length;
      chunkIndex++;
      chunkCount++;
    }

    const nameBytes = Buffer.from(file.name, 'latin1');
    const entry = Buffer.alloc(ENTRY_SIZE);
    entry.writeUInt32LE(STORAGE_CHUNKED, 0);
    entry.writeUInt32LE(start, 4);
    entry.writeUInt32LE(file.data.length, 8);
    entry.writeUInt32LE(file.data.length, 12);
    entry.writeUInt32LE(adler32(file.data), 16);
    entry.writeBigUInt64LE(file.fileTime ?? 0n, 20);
    entry.writeUInt32LE(chunkCount, 28);
    entry.writeUInt32LE(firstChunk, 32);
    entry.writeUInt32LE(nameBytes.length, 36);
    entry.writeUInt32LE(nameOffset, 40);
    entries.push(entry);

    // Names sit NUL-separated; the length word excludes the terminator.
    stringTable.push(nameBytes, Buffer.of(0));
    nameOffset += nameBytes.length + 1;
  }

  const chunks = Buffer.concat(chunkTable);
  const strings = Buffer.concat(stringTable);
  const table = Buffer.concat(entries);
  const tableOffset = cursor;

  const header = Buffer.alloc(HEADER_SIZE);
  header.write(ARC_MAGIC, 0, 'latin1');
  header.writeUInt32LE(ARC_VERSION, 4);
  header.writeUInt32LE(files.length, 8);
  header.writeUInt32LE(chunkIndex, 12);
  header.writeUInt32LE(chunks.length, 16);
  header.writeUInt32LE(strings.length, 20);
  header.writeUInt32LE(tableOffset, 24);

  return Buffer.concat([
    header,
    Buffer.alloc(DATA_START - HEADER_SIZE),
    ...blobs,
    chunks,
    strings,
    table,
  ]);
}

/**
 * Drop entries from an archive, leaving every file it keeps exactly where it is.
 *
 * This is how a stale override is undone. A mod's `resources/*.arc` shadows the
 * game's archive entry by entry, so removing an entry does not delete anything
 * — it lets the game's own copy through again, which is the only way to retire
 * a texture or a text file a mod forked years ago.
 *
 * The file's whole data region and its chunk table are carried over untouched,
 * dead chunks and all. That is what keeps it cheap on a 270 MB `ui.arc`, and it
 * is also what keeps it *correct*: an entry names its chunks by index, so
 * compacting the chunk table would mean rewriting every surviving entry to
 * follow it. Only the string table and the entry table are rebuilt.
 *
 * A name the archive does not have throws, rather than being counted as
 * removed — a revert list that has drifted from the archive should say so.
 */
export function removeArcEntries(buf: Buffer, names: readonly string[]): Buffer {
  if (buf.length < HEADER_SIZE) throw new Error(`not an .arc archive: ${buf.length} bytes is shorter than the header`);
  const magic = buf.toString('latin1', 0, 4);
  if (magic !== ARC_MAGIC) throw new Error(`not an .arc archive: magic ${JSON.stringify(magic)} != "ARC\\0"`);
  const version = buf.readUInt32LE(4);
  if (version !== ARC_VERSION) throw new Error(`unsupported .arc version ${version} (expected ${ARC_VERSION})`);

  const entryCount = buf.readUInt32LE(8);
  const chunkTableSize = buf.readUInt32LE(16);
  const stringTableSize = buf.readUInt32LE(20);
  const tableOffset = buf.readUInt32LE(24);

  const expected = tableOffset + chunkTableSize + stringTableSize + entryCount * ENTRY_SIZE;
  if (expected !== buf.length) {
    throw new Error(`tables end at ${expected} but the archive is ${buf.length} bytes`);
  }
  if (!names.length) return Buffer.from(buf);

  const stringBase = tableOffset + chunkTableSize;
  const entryBase = stringBase + stringTableSize;
  const drop = new Set(names.map((n) => n.toLowerCase()));
  const removed = new Set<string>();

  const kept: Buffer[] = [];
  const stringTable: Buffer[] = [];
  let nameOffset = 0;

  for (let i = 0; i < entryCount; i++) {
    const p = entryBase + i * ENTRY_SIZE;
    const nameLength = buf.readUInt32LE(p + 36);
    const nameAt = buf.readUInt32LE(p + 40);
    const name = buf.toString('latin1', stringBase + nameAt, stringBase + nameAt + nameLength);

    if (drop.has(name.toLowerCase())) {
      removed.add(name.toLowerCase());
      continue;
    }

    // The entry is carried over whole — offset, sizes, hash, chunk range — and
    // only repointed at where its name landed in the rebuilt string table.
    const entry = Buffer.from(buf.subarray(p, p + ENTRY_SIZE));
    const nameBytes = Buffer.from(name, 'latin1');
    entry.writeUInt32LE(nameBytes.length, 36);
    entry.writeUInt32LE(nameOffset, 40);
    kept.push(entry);
    stringTable.push(nameBytes, Buffer.of(0));
    nameOffset += nameBytes.length + 1;
  }

  const missing = [...drop].filter((n) => !removed.has(n));
  if (missing.length) throw new Error(`not in this archive: ${missing.join(', ')}`);

  const strings = Buffer.concat(stringTable);
  const table = Buffer.concat(kept);

  const header = Buffer.from(buf.subarray(0, HEADER_SIZE));
  header.writeUInt32LE(kept.length, 8);
  header.writeUInt32LE(strings.length, 20);
  // Chunk count, chunk-table size and the table offset all stay: the data
  // region and the chunk table are the parts this does not touch.

  return Buffer.concat([
    header,
    buf.subarray(HEADER_SIZE, tableOffset), // padding, then every file's bytes
    buf.subarray(tableOffset, tableOffset + chunkTableSize),
    strings,
    table,
  ]);
}

/** `readSync` may return a short read; loop until the range is filled. */
function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, position + read);
    if (n === 0) throw new Error(`unexpected end of file reading ${length} bytes at ${position}`);
    read += n;
  }
  return buf;
}
