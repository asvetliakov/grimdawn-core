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
  /**
   * Keep only these fields on each record it does read. **`readArzRaw` only.**
   *
   * The stream is still walked in full — the field lengths are what say where
   * the next one starts — so this saves no reading. What it saves is *objects*:
   * a record carries a couple of hundred fields, and a caller sweeping the whole
   * database for four of them was building fifty times more than it kept. Left
   * out, every field is kept, which is what a writer needs.
   *
   * Never pass this when the records are going to be written back: a record read
   * this way is a partial one, and writing it would drop every field omitted.
   */
  fields?: ReadonlySet<string>;
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
    out.set(record, { record, type, fileTime, fields: readRawFields(data, strings, record, opts.fields) });
  }
  return out;
}

function readRawFields(
  data: Buffer,
  strings: string[],
  record: string,
  wanted?: ReadonlySet<string>,
): RawArzField[] {
  const fields: RawArzField[] = [];
  let q = 0;
  while (q + 8 <= data.length) {
    const type = data.readUInt16LE(q);
    const count = data.readUInt16LE(q + 2);
    const keyIndex = data.readUInt32LE(q + 4);
    q += 8;

    const key = strings[keyIndex];
    if (key === undefined) throw new Error(`${record}: field key index ${keyIndex} is outside the string table`);

    // Skipped by arithmetic rather than by reading: every value is four bytes,
    // whatever its type, so an unwanted field costs one add.
    if (wanted && !wanted.has(key)) {
      q += count * 4;
      continue;
    }

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

/** A record's field stream, as the file stores it. The inverse of `readRawFields`. */
function encodeRawFields(rec: RawArzRecord, intern: (s: string) => number): Buffer {
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
  return Buffer.concat(parts);
}

/**
 * One record-table entry.
 *
 * The type string is stored *inline* rather than as a string-table index, which
 * is why an entry is variable-length and why a writer that changes a record's
 * type cannot patch the table in place.
 */
function encodeRecordEntry(
  nameIndex: number,
  type: string,
  offset: number,
  compressed: number,
  raw: number,
  fileTime: bigint,
): Buffer {
  const typeBytes = Buffer.from(type, 'latin1');
  const out = Buffer.alloc(4 + 4 + typeBytes.length + 4 + 4 + 4 + 8);
  let o = 0;
  out.writeUInt32LE(nameIndex, o); o += 4;
  out.writeUInt32LE(typeBytes.length, o); o += 4;
  typeBytes.copy(out, o); o += typeBytes.length;
  out.writeUInt32LE(offset, o); o += 4;
  out.writeUInt32LE(compressed, o); o += 4;
  out.writeUInt32LE(raw, o); o += 4;
  out.writeBigUInt64LE(fileTime, o);
  return out;
}

/**
 * An interner over an archive's existing string table.
 *
 * A string already in the table keeps its index and anything new lands past the
 * end, which is what lets a writer append to the table without rewriting a
 * single record that points into it.
 */
function internerFor(strings: readonly string[]): { intern: (s: string) => number; added: string[] } {
  const index = new Map<string, number>();
  strings.forEach((s, i) => {
    if (!index.has(s)) index.set(s, i);
  });
  const added: string[] = [];
  const intern = (s: string): number => {
    const seen = index.get(s);
    if (seen !== undefined) return seen;
    const at = strings.length + added.length;
    index.set(s, at);
    added.push(s);
    return at;
  };
  return { intern, added };
}

/** The `u32 len` + bytes pairs for strings appended to an existing table. */
function encodeStringTail(added: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const s of added) {
    const bytes = Buffer.from(s, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    parts.push(len, bytes);
  }
  return Buffer.concat(parts);
}

/**
 * Every record name an archive defines, in table order.
 *
 * Reads the record table only — no block is decompressed — so this is the cheap
 * way to ask "what is in here" before deciding what to pay for. `readArzRaw`'s
 * filter sees the same names, which is what lets a caller select by path and
 * skip the rest.
 */
export function arzRecordNames(buf: Buffer): string[] {
  if (buf.length < 24) throw new Error(`not an .arz archive: ${buf.length} bytes is shorter than the header`);
  if (buf.readUInt16LE(0) !== ARZ_MAGIC) throw new Error(`not an .arz archive: magic ${buf.readUInt16LE(0)}`);
  const recordTableStart = buf.readUInt32LE(4);
  const recordTableSize = buf.readUInt32LE(8);
  const recordCount = buf.readUInt32LE(12);
  const strings = readStringTable(buf, buf.readUInt32LE(16));
  const table = buf.subarray(recordTableStart, recordTableStart + recordTableSize);
  const names: string[] = [];
  let p = 0;
  for (let i = 0; i < recordCount; i++) {
    const nameIndex = table.readUInt32LE(p);
    const typeLen = table.readUInt32LE(p + 4);
    p = p + 8 + typeLen + 12 + 8;
    const record = strings[nameIndex];
    if (record === undefined) throw new Error(`record ${i}: name index ${nameIndex} is outside the string table`);
    names.push(record);
  }
  return names;
}

/**
 * The names the record table actually defines, lowercased.
 *
 * Walks the entries for their name index alone — no block is decompressed — so
 * this costs a pass over a few hundred kilobytes of table on an archive whose
 * data section is tens of megabytes.
 */
function recordNamesIn(
  buf: Buffer,
  strings: readonly string[],
  recordTableStart: number,
  recordTableSize: number,
  recordCount: number,
): Set<string> {
  const table = buf.subarray(recordTableStart, recordTableStart + recordTableSize);
  const names = new Set<string>();
  let p = 0;
  for (let i = 0; i < recordCount; i++) {
    const nameIndex = table.readUInt32LE(p);
    const typeLen = table.readUInt32LE(p + 4);
    p = p + 8 + typeLen + 12 + 8;
    const record = strings[nameIndex];
    if (record === undefined) throw new Error(`record ${i}: name index ${nameIndex} is outside the string table`);
    names.add(record.toLowerCase());
  }
  return names;
}

/**
 * Add records an archive does not have, leaving what it does have untouched.
 *
 * The companion to `patchArzValues`, for the same job from the other side: a
 * mod's archive may simply not mention a record an edit needs — someone else's
 * base mod adds a few items and never touches `gameengine.dbr` — and the edit
 * has to go somewhere.
 *
 * Every existing index stays valid, which is what makes this safe: the string
 * table is only ever *appended* to, so no record anywhere needs rewriting to
 * follow a string that moved. Data blocks and record-table entries append the
 * same way, and the counts and offsets in the header are the only numbers that
 * change.
 *
 * Adding a record the archive already has would leave two entries with the same
 * name and the reader would keep the last; that is the caller's mistake to
 * avoid, so it throws. What counts as "already has" is the **record table**, not
 * the string table: a name is interned the moment any record so much as points
 * at it, and a base mod that references `playerlevels.dbr` without defining it
 * is the ordinary case rather than the odd one. Testing the strings refused
 * exactly the append this function exists for.
 */
export function appendArzRecords(buf: Buffer, records: readonly RawArzRecord[]): Buffer {
  if (buf.length < 24) throw new Error(`not an .arz archive: ${buf.length} bytes is shorter than the header`);
  if (buf.readUInt16LE(0) !== ARZ_MAGIC) throw new Error(`not an .arz archive: magic ${buf.readUInt16LE(0)}`);
  if (buf.readUInt16LE(2) !== ARZ_VERSION) throw new Error(`unsupported .arz version ${buf.readUInt16LE(2)}`);
  if (!records.length) return Buffer.from(buf);

  const recordTableStart = buf.readUInt32LE(4);
  const recordTableSize = buf.readUInt32LE(8);
  const recordCount = buf.readUInt32LE(12);
  const stringTableStart = buf.readUInt32LE(16);
  const stringTableSize = buf.readUInt32LE(20);

  const strings = readStringTable(buf, stringTableStart);
  const { intern, added } = internerFor(strings);
  const have = recordNamesIn(buf, strings, recordTableStart, recordTableSize, recordCount);

  const blocks: Buffer[] = [];
  const entries: Buffer[] = [];
  let appendedSize = 0;
  const dataSize = recordTableStart - 24;

  for (const rec of records) {
    if (have.has(rec.record.toLowerCase())) {
      throw new Error(`${rec.record} is already a record in this archive`);
    }
    const nameIndex = intern(rec.record);
    const raw = encodeRawFields(rec, intern);
    const block = compressLz4Literals(raw);

    blocks.push(block);
    entries.push(
      encodeRecordEntry(nameIndex, rec.type, dataSize + appendedSize, block.length, raw.length, rec.fileTime),
    );
    appendedSize += block.length;
  }

  const stringTail = encodeStringTail(added);
  const newEntries = Buffer.concat(entries);

  // The count leads the string table; the rest of it is carried over verbatim.
  const stringCount = Buffer.alloc(4);
  stringCount.writeUInt32LE(strings.length + added.length, 0);

  const header = Buffer.from(buf.subarray(0, 24));
  header.writeUInt32LE(recordTableStart + appendedSize, 4);
  header.writeUInt32LE(recordTableSize + newEntries.length, 8);
  header.writeUInt32LE(recordCount + records.length, 12);
  header.writeUInt32LE(stringTableStart + appendedSize + newEntries.length, 16);
  header.writeUInt32LE(stringTableSize + stringTail.length, 20);

  return Buffer.concat([
    header,
    buf.subarray(24, recordTableStart),
    ...blocks,
    buf.subarray(recordTableStart, recordTableStart + recordTableSize),
    newEntries,
    stringCount,
    buf.subarray(stringTableStart + 4, stringTableStart + stringTableSize),
    stringTail,
    buf.subarray(stringTableStart + stringTableSize), // the sixteen trailing bytes
  ]);
}

/**
 * Replace whole records in an archive that already has them, leaving every
 * other record's bytes where they are.
 *
 * `patchArzValues` can only overwrite numbers in place, and `appendArzRecords`
 * refuses a name the archive already knows — which leaves the case porting a
 * mod needs most: a record that is *there* and stale. A field pointing at a
 * record that moved, a field set that predates an expansion, a whole new field
 * the old copy never had. Rebuilding the archive is not an option at mod size,
 * for the reasons `patchArzValues` sets out.
 *
 * So: the same surgery, one level up. The replacement's field stream is encoded
 * fresh and its block **appended** after the existing data section, and only
 * that record's table entry is rewritten to point at it; the old block stays
 * behind as dead bytes. Two things differ from a value patch, and both fall out
 * of replacing a record wholesale rather than editing inside it:
 *
 *   - A replacement may name strings the archive has never held — a new field
 *     key, a new string value. Those are **appended** to the string table,
 *     which is safe for the same reason it is in `appendArzRecords`: indices
 *     are ordinal and the table is last but for the trailer, so every index
 *     already written stays valid.
 *   - A record's type is stored *inline* in its table entry, so a replacement
 *     that changes it changes that entry's length. The table therefore cannot
 *     be copied and poked the way `patchArzValues` copies it — it is re-emitted
 *     entry by entry, untouched entries as verbatim slices, and the header
 *     absorbs the difference.
 *
 * The record keeps its existing name index, so the archive's spelling of the
 * path wins over the argument's. Record count and record order do not change.
 * A record the archive does not have throws rather than being appended: the
 * caller asked to replace something, and quietly creating it instead would turn
 * a typo into a record nothing references.
 */
export function replaceArzRecords(buf: Buffer, records: readonly RawArzRecord[]): Buffer {
  if (buf.length < 24) throw new Error(`not an .arz archive: ${buf.length} bytes is shorter than the header`);
  const magic = buf.readUInt16LE(0);
  const version = buf.readUInt16LE(2);
  if (magic !== ARZ_MAGIC) throw new Error(`not an .arz archive: magic ${magic} != ${ARZ_MAGIC}`);
  if (version !== ARZ_VERSION) throw new Error(`unsupported .arz version ${version} (expected ${ARZ_VERSION})`);
  if (!records.length) return Buffer.from(buf);

  const recordTableStart = buf.readUInt32LE(4);
  const recordCount = buf.readUInt32LE(12);
  const stringTableStart = buf.readUInt32LE(16);
  const stringTableSize = buf.readUInt32LE(20);

  const strings = readStringTable(buf, stringTableStart);
  const { intern, added } = internerFor(strings);

  const wanted = new Map<string, RawArzRecord>();
  for (const rec of records) {
    const key = rec.record.toLowerCase();
    // Two replacements of one record would strand the first one's block and
    // leave the caller guessing which won.
    if (wanted.has(key)) throw new Error(`${rec.record} is replaced twice in one call`);
    wanted.set(key, rec);
  }

  const dataSize = recordTableStart - 24;
  const blocks: Buffer[] = [];
  const entries: Buffer[] = [];
  let appendedSize = 0;
  const done = new Set<string>();

  let p = recordTableStart;
  for (let i = 0; i < recordCount; i++) {
    const entryStart = p;
    const nameIndex = buf.readUInt32LE(p);
    const typeLen = buf.readUInt32LE(p + 4);
    const entryEnd = p + 8 + typeLen + 12 + 8;
    p = entryEnd;

    const record = strings[nameIndex];
    if (record === undefined) throw new Error(`record ${i}: name index ${nameIndex} is outside the string table`);
    const rec = wanted.get(record.toLowerCase());
    if (!rec) {
      entries.push(buf.subarray(entryStart, entryEnd));
      continue;
    }

    const raw = encodeRawFields(rec, intern);
    const block = compressLz4Literals(raw);
    entries.push(
      encodeRecordEntry(nameIndex, rec.type, dataSize + appendedSize, block.length, raw.length, rec.fileTime),
    );
    blocks.push(block);
    appendedSize += block.length;
    done.add(record.toLowerCase());
  }

  for (const [key, rec] of wanted) {
    if (!done.has(key)) throw new Error(`${rec.record} is not in this archive`);
  }

  const newTable = Buffer.concat(entries);
  const stringTail = encodeStringTail(added);
  const newRecordTableStart = recordTableStart + appendedSize;

  // The count leads the string table; the rest of it is carried over verbatim.
  const stringCount = Buffer.alloc(4);
  stringCount.writeUInt32LE(strings.length + added.length, 0);

  const header = Buffer.from(buf.subarray(0, 24));
  header.writeUInt32LE(newRecordTableStart, 4);
  header.writeUInt32LE(newTable.length, 8);
  header.writeUInt32LE(newRecordTableStart + newTable.length, 16);
  header.writeUInt32LE(stringTableSize + stringTail.length, 20);

  return Buffer.concat([
    header,
    buf.subarray(24, recordTableStart), // every existing block, byte for byte
    ...blocks,
    newTable,
    stringCount,
    buf.subarray(stringTableStart + 4, stringTableStart + stringTableSize),
    stringTail,
    buf.subarray(stringTableStart + stringTableSize), // the sixteen trailing bytes
  ]);
}

export interface ArzValueEdit {
  /** Record path, as the archive spells it (matched case-insensitively). */
  record: string;
  /** Field key. Must already exist on that record, hold one value, and not be a string. */
  field: string;
  value: number;
}

/**
 * Replace numeric field values in an archive that already exists, leaving every
 * other byte of it exactly where it was.
 *
 * This is how an edit reaches a mod somebody else built. Rebuilding the archive
 * from its own records is not an option at this size: `writeArz` compresses
 * literal-only, so a 79 MB mod would come back several times larger, and every
 * record would have gone through this library's encoder to change three fields.
 *
 * The layout makes a surgical patch cheap instead. Only a record's *data
 * offset* is relative, and it is the only thing about a record the rest of the
 * file knows: so the new blocks are **appended** after the existing data
 * section, the record table is copied and the twelve bytes naming offset and
 * sizes are rewritten for exactly the records that changed, and the string
 * table, the trailing sixteen bytes, and every other record's compressed block
 * are carried over untouched. The old blocks stay where they are, unreferenced
 * — a few hundred dead bytes, against rewriting tens of megabytes.
 *
 * The game loads the result — checked by playing it — so the dead blocks are
 * ignored and the loader trusts the header's offsets rather than deriving
 * anything from the file's length.
 *
 * Consequently no string is ever added: the field keys are already in the
 * table, and the values are numbers. A field this cannot write that way — a
 * string, a list, one that is not there — throws rather than being skipped,
 * because a patch that silently did nothing would be indistinguishable from one
 * that worked.
 */
export function patchArzValues(buf: Buffer, edits: readonly ArzValueEdit[]): Buffer {
  if (buf.length < 24) throw new Error(`not an .arz archive: ${buf.length} bytes is shorter than the header`);
  const magic = buf.readUInt16LE(0);
  const version = buf.readUInt16LE(2);
  if (magic !== ARZ_MAGIC) throw new Error(`not an .arz archive: magic ${magic} != ${ARZ_MAGIC}`);
  if (version !== ARZ_VERSION) throw new Error(`unsupported .arz version ${version} (expected ${ARZ_VERSION})`);

  const recordTableStart = buf.readUInt32LE(4);
  const recordTableSize = buf.readUInt32LE(8);
  const recordCount = buf.readUInt32LE(12);
  const stringTableStart = buf.readUInt32LE(16);
  const strings = readStringTable(buf, stringTableStart);

  const byRecord = new Map<string, ArzValueEdit[]>();
  for (const edit of edits) {
    const key = edit.record.toLowerCase();
    const list = byRecord.get(key);
    if (list) list.push(edit);
    else byRecord.set(key, [edit]);
  }

  // Copied, then patched in place: every entry this does not touch keeps its
  // bytes rather than being re-encoded from a parse of them.
  const table = Buffer.from(buf.subarray(recordTableStart, recordTableStart + recordTableSize));
  const dataSize = recordTableStart - 24;
  const appended: Buffer[] = [];
  let appendedSize = 0;
  const done = new Set<string>();

  let p = 0;
  for (let i = 0; i < recordCount; i++) {
    const nameIndex = table.readUInt32LE(p);
    const typeLen = table.readUInt32LE(p + 4);
    const at = p + 8 + typeLen;
    p = at + 12 + 8;

    const record = strings[nameIndex];
    if (record === undefined) throw new Error(`record ${i}: name index ${nameIndex} is outside the string table`);
    const wanted = byRecord.get(record.toLowerCase());
    if (!wanted) continue;

    const dataOffset = table.readUInt32LE(at);
    const compressedSize = table.readUInt32LE(at + 4);
    const decompressedSize = table.readUInt32LE(at + 8);
    const data = decompressLz4Block(
      buf.subarray(24 + dataOffset, 24 + dataOffset + compressedSize),
      decompressedSize,
    );
    writeRawValues(data, strings, wanted, record);

    const block = compressLz4Literals(data);
    table.writeUInt32LE(dataSize + appendedSize, at);
    table.writeUInt32LE(block.length, at + 4);
    table.writeUInt32LE(data.length, at + 8);
    appended.push(block);
    appendedSize += block.length;
    done.add(record.toLowerCase());
  }

  for (const record of byRecord.keys()) {
    if (!done.has(record)) throw new Error(`${record} is not in this archive`);
  }

  const header = Buffer.from(buf.subarray(0, 24));
  header.writeUInt32LE(recordTableStart + appendedSize, 4);
  header.writeUInt32LE(stringTableStart + appendedSize, 16);

  return Buffer.concat([
    header,
    buf.subarray(24, recordTableStart), // every existing block, byte for byte
    ...appended,
    table,
    buf.subarray(stringTableStart), // string table and the sixteen trailing bytes
  ]);
}

/** Overwrite named values in a decompressed field stream, in place. */
function writeRawValues(
  data: Buffer,
  strings: string[],
  edits: readonly ArzValueEdit[],
  record: string,
): void {
  const left = new Map(edits.map((e) => [e.field.toLowerCase(), e]));
  let q = 0;
  while (q + 8 <= data.length) {
    const type = data.readUInt16LE(q);
    const count = data.readUInt16LE(q + 2);
    const keyIndex = data.readUInt32LE(q + 4);
    q += 8;

    const key = strings[keyIndex];
    if (key === undefined) throw new Error(`${record}: field key index ${keyIndex} is outside the string table`);
    const edit = left.get(key.toLowerCase());
    if (edit) {
      if (type === FieldType.String) throw new Error(`${record}.${key} is a string field`);
      if (count !== 1) throw new Error(`${record}.${key} holds ${count} values, not one`);
      if (type === FieldType.Float) data.writeFloatLE(Math.fround(edit.value), q);
      else data.writeInt32LE(Math.round(edit.value), q);
      left.delete(key.toLowerCase());
    }
    q += count * 4;
  }
  if (left.size) throw new Error(`${record} has no ${[...left.keys()].join(' or ')} field`);
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
    const raw = encodeRawFields(rec, intern);
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
    entries.map((e) => encodeRecordEntry(e.nameIndex, e.type, e.offset, e.compressed, e.raw, e.fileTime)),
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
