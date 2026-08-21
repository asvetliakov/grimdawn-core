/**
 * Reader for Grim Dawn's `.arz` database archives.
 *
 * An `.arz` is the game's compiled record store: every DBR file the game ships
 * lives in here, keyed by its record path (`records/items/gearhead/c020_head.dbr`).
 * That key is the whole reason this parser exists — saves reference items *only*
 * by record path, and no third-party dump publishes that mapping (see the Stage 3
 * plan's Outcome section).
 *
 * Layout, all little-endian:
 *
 * ```
 *   0  u16  magic (2)
 *   2  u16  version (3)
 *   4  u32  record-table offset (absolute)
 *   8  u32  record-table size
 *  12  u32  record count
 *  16  u32  string-table offset (absolute)
 *  20  u32  string-table size
 * ```
 *
 * The record-table offset is **absolute**, not relative to byte 24 as the
 * community documentation says. Measured on all five archives this install
 * ships plus two mods: `recordTableOffset + recordTableSize == stringTableOffset`
 * exactly, every time. Only the per-record *data* offset is relative to 24.
 *
 * Regions run header, data blobs, record table, string table, and then **16
 * trailing bytes** that every real archive carries — Crate's and a
 * community-built mod's alike — and that are not the MD5 of any region of the
 * file (checked). Nothing here reads them.
 *
 * The string table is `u32 count` followed by `count` × (`u32 len`, `len` bytes).
 * Every name, key and string value elsewhere is an index into it.
 *
 * A record-table entry is: `u32 nameIndex`, `u32 typeLen` + type bytes, `u32 dataOffset`,
 * `u32 compressedSize`, `u32 decompressedSize`, `u64 fileTime`. The
 * data at `24 + dataOffset` is an LZ4 *block* (no frame header) that decompresses
 * to a flat field stream: `u16 type`, `u16 count`, `u32 keyIndex`, then `count`
 * 4-byte values — int, float, string index, or bool by type.
 */

import { createHash } from 'node:crypto';

/** Field value types as encoded in a record's field stream. */
const enum FieldType {
  Int = 0,
  Float = 1,
  String = 2,
  Bool = 3,
}

export type ArzValue = number | string | number[] | string[];

export interface ArzRecord {
  /** DBR record path — the key saves use. */
  record: string;
  /** Template class, e.g. `ArmorProtective_Head`. */
  type: string;
  fields: Record<string, ArzValue>;
}

/**
 * Decompress one LZ4 block.
 *
 * Written out rather than pulled from npm: the block format is a dozen lines,
 * and `.arz` uses raw blocks (no frame, no checksums) with the decompressed size
 * already known from the record table, which is the one case where the format is
 * trivial. Sequences are `token` (4 bits literal length, 4 bits match length),
 * optional length extension bytes, literals, then a 2-byte little-endian back
 * offset. The final sequence has literals only.
 */
export function decompressLz4Block(src: Buffer, decompressedSize: number): Buffer {
  const dst = Buffer.allocUnsafe(decompressedSize);
  let s = 0;
  let d = 0;

  const extend = (n: number): number => {
    let more: number;
    do {
      if (s >= src.length) throw new Error('LZ4: truncated length extension');
      more = src[s++]!;
      n += more;
    } while (more === 255);
    return n;
  };

  while (s < src.length) {
    const token = src[s++]!;

    let literals = token >> 4;
    if (literals === 15) literals = extend(literals);
    if (s + literals > src.length || d + literals > dst.length) {
      throw new Error(`LZ4: literal run overruns buffer (src ${s}+${literals}/${src.length}, dst ${d}+${literals}/${dst.length})`);
    }
    src.copy(dst, d, s, s + literals);
    s += literals;
    d += literals;

    // The last sequence stops after its literals — no match follows.
    if (s >= src.length) break;

    const offset = src[s]! | (src[s + 1]! << 8);
    s += 2;
    if (offset === 0 || offset > d) throw new Error(`LZ4: bad match offset ${offset} at dst ${d}`);

    let matchLen = token & 15;
    if (matchLen === 15) matchLen = extend(matchLen);
    matchLen += 4; // minimum match length is 4

    if (d + matchLen > dst.length) throw new Error(`LZ4: match overruns output (${d}+${matchLen}/${dst.length})`);
    // Byte-by-byte on purpose: overlapping matches (offset < matchLen) are legal
    // and are how LZ4 encodes runs, so a bulk copy would be wrong.
    let ref = d - offset;
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[ref++]!;
  }

  if (d !== decompressedSize) {
    throw new Error(`LZ4: produced ${d} bytes, record table declared ${decompressedSize}`);
  }
  return dst;
}

export interface ReadArzOptions {
  /** Keep only records whose path passes this test. Everything else is skipped
   *  without being decompressed, which is most of the file. */
  filter?: (record: string) => boolean;
}

/** Header magic; version 3 is what 1.3.x ships. */
const ARZ_MAGIC = 2;
const ARZ_VERSION = 3;

export function readArz(buf: Buffer, opts: ReadArzOptions = {}): Map<string, ArzRecord> {
  if (buf.length < 24) throw new Error(`not an .arz archive: ${buf.length} bytes is shorter than the header`);
  const magic = buf.readUInt16LE(0);
  const version = buf.readUInt16LE(2);
  if (magic !== ARZ_MAGIC) throw new Error(`not an .arz archive: magic ${magic} != ${ARZ_MAGIC}`);
  if (version !== ARZ_VERSION) throw new Error(`unsupported .arz version ${version} (expected ${ARZ_VERSION})`);

  const recordTableStart = buf.readUInt32LE(4);
  const recordCount = buf.readUInt32LE(12);
  const stringTableStart = buf.readUInt32LE(16);

  const strings = readStringTable(buf, stringTableStart);
  const out = new Map<string, ArzRecord>();

  let p = recordTableStart;
  for (let i = 0; i < recordCount; i++) {
    const nameIndex = buf.readUInt32LE(p);
    p += 4;
    const typeLen = buf.readUInt32LE(p);
    p += 4;
    const type = buf.toString('latin1', p, p + typeLen);
    p += typeLen;
    const dataOffset = buf.readUInt32LE(p);
    p += 4;
    const compressedSize = buf.readUInt32LE(p);
    p += 4;
    const decompressedSize = buf.readUInt32LE(p);
    p += 4;
    p += 8; // u64 file time

    const record = strings[nameIndex];
    if (record === undefined) throw new Error(`record ${i}: name index ${nameIndex} is outside the string table`);
    if (opts.filter && !opts.filter(record)) continue;

    const data = decompressLz4Block(
      buf.subarray(24 + dataOffset, 24 + dataOffset + compressedSize),
      decompressedSize,
    );
    out.set(record, { record, type, fields: readFields(data, strings, record) });
  }

  return out;
}

function readStringTable(buf: Buffer, start: number): string[] {
  let p = start;
  const count = buf.readUInt32LE(p);
  p += 4;
  const strings = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    const len = buf.readUInt32LE(p);
    p += 4;
    // latin1: DBR text is ASCII, and the localized strings we care about come
    // from the l10n tables, not from here.
    strings[i] = buf.toString('latin1', p, p + len);
    p += len;
  }
  return strings;
}

function readFields(data: Buffer, strings: string[], record: string): Record<string, ArzValue> {
  const fields: Record<string, ArzValue> = {};
  let q = 0;
  while (q + 8 <= data.length) {
    const type = data.readUInt16LE(q);
    const count = data.readUInt16LE(q + 2);
    const keyIndex = data.readUInt32LE(q + 4);
    q += 8;

    const key = strings[keyIndex];
    if (key === undefined) throw new Error(`${record}: field key index ${keyIndex} is outside the string table`);

    const values: (number | string)[] = [];
    for (let j = 0; j < count; j++) {
      switch (type) {
        case FieldType.Float:
          values.push(data.readFloatLE(q));
          break;
        case FieldType.String: {
          const idx = data.readUInt32LE(q);
          const s = strings[idx];
          if (s === undefined) throw new Error(`${record}.${key}: string index ${idx} is outside the string table`);
          values.push(s);
          break;
        }
        case FieldType.Bool:
        case FieldType.Int:
        default:
          values.push(data.readInt32LE(q));
          break;
      }
      q += 4;
    }
    fields[key] = count === 1 ? values[0]! : (values as number[] | string[]);
  }
  return fields;
}

/** Convenience accessors — DBR fields are loosely typed and often absent. */
export function str(rec: ArzRecord | undefined, key: string): string | undefined {
  const v = rec?.fields[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function num(rec: ArzRecord | undefined, key: string): number | undefined {
  const v = rec?.fields[key];
  return typeof v === 'number' ? v : undefined;
}

export function strList(rec: ArzRecord | undefined, key: string): string[] {
  const v = rec?.fields[key];
  if (typeof v === 'string') return v === '' ? [] : [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x !== '');
  return [];
}

/** Short, stable id for a set of archive files — the cache key for a game build. */
export function fingerprint(parts: string[]): string {
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Writing — the lossless half
// ---------------------------------------------------------------------------

/**
 * A field exactly as it sits in the record, before anything is thrown away.
 *
 * `readArz` is deliberately lossy: it collapses `Int`, `Bool` and `Float` into
 * JS numbers, and a one-element array into a scalar. Both are fine for reading
 * the database and fatal for writing one back — the type word decides how four
 * bytes are interpreted, and the count word is what says whether a field is a
 * list. This keeps them.
 */
export interface RawArzField {
  key: string;
  /** The stored `u16` type word: 0 int, 1 float, 2 string, 3 bool. */
  type: number;
  /** Numbers for int/bool/float, strings for string fields. Length is the arity. */
  values: (number | string)[];
}

export interface RawArzRecord {
  record: string;
  type: string;
  /** The record's `u64` timestamp, carried through untouched. */
  fileTime: bigint;
  /** Field order is the file's, and is preserved on write. */
  fields: RawArzField[];
}

/**
 * Read records without losing anything a writer needs.
 *
 * Same walk as `readArz`, and it takes the same `filter` — which matters more
 * here, because the caller is usually after two or three records out of forty
 * thousand.
 */
export function readArzRaw(buf: Buffer, opts: ReadArzOptions = {}): Map<string, RawArzRecord> {
  if (buf.length < 24) throw new Error(`not an .arz archive: ${buf.length} bytes is shorter than the header`);
  const magic = buf.readUInt16LE(0);
  const version = buf.readUInt16LE(2);
  if (magic !== ARZ_MAGIC) throw new Error(`not an .arz archive: magic ${magic} != ${ARZ_MAGIC}`);
  if (version !== ARZ_VERSION) throw new Error(`unsupported .arz version ${version} (expected ${ARZ_VERSION})`);

  const recordTableStart = buf.readUInt32LE(4);
  const recordCount = buf.readUInt32LE(12);
  const stringTableStart = buf.readUInt32LE(16);
  const strings = readStringTable(buf, stringTableStart);
  const out = new Map<string, RawArzRecord>();

  let p = recordTableStart;
  for (let i = 0; i < recordCount; i++) {
    const nameIndex = buf.readUInt32LE(p);
    p += 4;
    const typeLen = buf.readUInt32LE(p);
    p += 4;
    const type = buf.toString('latin1', p, p + typeLen);
    p += typeLen;
    const dataOffset = buf.readUInt32LE(p);
    p += 4;
    const compressedSize = buf.readUInt32LE(p);
    p += 4;
    const decompressedSize = buf.readUInt32LE(p);
    p += 4;
    const fileTime = buf.readBigUInt64LE(p);
    p += 8;

    const record = strings[nameIndex];
    if (record === undefined) throw new Error(`record ${i}: name index ${nameIndex} is outside the string table`);
    if (opts.filter && !opts.filter(record)) continue;

    const data = decompressLz4Block(
      buf.subarray(24 + dataOffset, 24 + dataOffset + compressedSize),
      decompressedSize,
    );
    out.set(record, { record, type, fileTime, fields: readRawFields(data, strings, record) });
  }
  return out;
}

function readRawFields(data: Buffer, strings: string[], record: string): RawArzField[] {
  const fields: RawArzField[] = [];
  let q = 0;
  while (q + 8 <= data.length) {
    const type = data.readUInt16LE(q);
    const count = data.readUInt16LE(q + 2);
    const keyIndex = data.readUInt32LE(q + 4);
    q += 8;

    const key = strings[keyIndex];
    if (key === undefined) throw new Error(`${record}: field key index ${keyIndex} is outside the string table`);

    const values: (number | string)[] = [];
    for (let j = 0; j < count; j++) {
      if (type === FieldType.Float) {
        values.push(data.readFloatLE(q));
      } else if (type === FieldType.String) {
        const idx = data.readUInt32LE(q);
        const s = strings[idx];
        if (s === undefined) throw new Error(`${record}.${key}: string index ${idx} is outside the string table`);
        values.push(s);
      } else {
        values.push(data.readInt32LE(q));
      }
      q += 4;
    }
    fields.push({ key, type, values });
  }
  return fields;
}

/**
 * Compress a block as one run of literals.
 *
 * Legal LZ4, and deliberately the dumbest possible encoder: a record is a few
 * hundred bytes, the archives this writes hold a handful of records, and the
 * game decompresses by the size the record table declares either way. Matching
 * would save kilobytes and cost a compressor to get wrong.
 *
 * The format: a token whose high nibble is the literal length (15 meaning "read
 * extension bytes"), then any extension bytes, then the literals. A block that
 * ends after its literals has no match, which is exactly what this emits — and
 * is the same shape `decompressLz4Block` handles as its final sequence.
 */
export function compressLz4Literals(data: Buffer): Buffer {
  const head: number[] = [];
  if (data.length < 15) {
    head.push(data.length << 4);
  } else {
    head.push(0xf0);
    let left = data.length - 15;
    while (left >= 255) {
      head.push(255);
      left -= 255;
    }
    head.push(left);
  }
  return Buffer.concat([Buffer.from(head), data]);
}

/**
 * Build an `.arz` from records read by `readArzRaw`.
 *
 * The string table is rebuilt from scratch — record paths, field keys and every
 * string value — because indices are per-archive and a record lifted out of
 * `database.arz` carries indices that mean nothing here.
 *
 * The 16 trailing bytes every shipped archive has are written as zeros. They are
 * not a checksum of anything in the file (tested against the obvious hashes over
 * every region), nothing in this repo reads them, and the game's own opinion of
 * them is the one thing about this format that cannot be settled without
 * launching it — see the note in the patcher's speed-mod command.
 */
export function writeArz(records: readonly RawArzRecord[]): Buffer {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const intern = (s: string): number => {
    const seen = index.get(s);
    if (seen !== undefined) return seen;
    const at = strings.length;
    strings.push(s);
    index.set(s, at);
    return at;
  };

  // Record names first, so a reader dumping the table sees something sensible.
  for (const rec of records) intern(rec.record);

  const blobs: Buffer[] = [];
  const entries: { nameIndex: number; type: string; offset: number; compressed: number; raw: number; fileTime: bigint }[] = [];
  let dataCursor = 0;

  for (const rec of records) {
    const parts: Buffer[] = [];
    for (const field of rec.fields) {
      const head = Buffer.alloc(8);
      head.writeUInt16LE(field.type, 0);
      head.writeUInt16LE(field.values.length, 2);
      head.writeUInt32LE(intern(field.key), 4);
      parts.push(head);

      const body = Buffer.alloc(field.values.length * 4);
      field.values.forEach((value, i) => {
        if (field.type === FieldType.Float) {
          body.writeFloatLE(value as number, i * 4);
        } else if (field.type === FieldType.String) {
          body.writeUInt32LE(intern(value as string), i * 4);
        } else {
          body.writeInt32LE(value as number, i * 4);
        }
      });
      parts.push(body);
    }

    const raw = Buffer.concat(parts);
    const compressed = compressLz4Literals(raw);
    blobs.push(compressed);
    entries.push({
      nameIndex: intern(rec.record),
      type: rec.type,
      offset: dataCursor,
      compressed: compressed.length,
      raw: raw.length,
      fileTime: rec.fileTime,
    });
    dataCursor += compressed.length;
  }

  const recordTable = Buffer.concat(
    entries.map((e) => {
      const typeBytes = Buffer.from(e.type, 'latin1');
      const out = Buffer.alloc(4 + 4 + typeBytes.length + 4 + 4 + 4 + 8);
      let o = 0;
      out.writeUInt32LE(e.nameIndex, o); o += 4;
      out.writeUInt32LE(typeBytes.length, o); o += 4;
      typeBytes.copy(out, o); o += typeBytes.length;
      out.writeUInt32LE(e.offset, o); o += 4;
      out.writeUInt32LE(e.compressed, o); o += 4;
      out.writeUInt32LE(e.raw, o); o += 4;
      out.writeBigUInt64LE(e.fileTime, o);
      return out;
    }),
  );

  const stringParts: Buffer[] = [];
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32LE(strings.length, 0);
  stringParts.push(countBuf);
  for (const s of strings) {
    const bytes = Buffer.from(s, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    stringParts.push(len, bytes);
  }
  const stringTable = Buffer.concat(stringParts);

  const dataSize = blobs.reduce((n, b) => n + b.length, 0);
  const recordTableStart = 24 + dataSize;
  const stringTableStart = recordTableStart + recordTable.length;

  const header = Buffer.alloc(24);
  header.writeUInt16LE(ARZ_MAGIC, 0);
  header.writeUInt16LE(ARZ_VERSION, 2);
  header.writeUInt32LE(recordTableStart, 4);
  header.writeUInt32LE(recordTable.length, 8);
  header.writeUInt32LE(records.length, 12);
  header.writeUInt32LE(stringTableStart, 16);
  header.writeUInt32LE(stringTable.length, 20);

  return Buffer.concat([header, ...blobs, recordTable, stringTable, Buffer.alloc(16)]);
}
