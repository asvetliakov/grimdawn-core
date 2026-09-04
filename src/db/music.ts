/**
 * The game's music, and how to put other music in its place.
 *
 * Three layers decide what plays. The **audio** is Ogg Vorbis under `music/`
 * in `resources/Sound.arc` (44.1 kHz, stereo, ~350–500 kbps), referenced as
 * `sound/music/<file>.ogg` — `sound/` names the archive, the rest is the entry.
 * A **music pak** — `records/sounds/soundpak_musicambient/musicpak_*.dbr`,
 * template `musicpak.tpl` — is nothing but a `tracks` string list and a
 * `randomize` flag, so a longer soundtrack is a longer list. And **which pak
 * plays where** is a zone table painted into `world001.map`, which nothing
 * here can edit: a place gets its own music only if the map already gave it
 * its own zone. `MUSIC_PAKS` is that table, read out of the map once (2.5 GB
 * decompressed, a two-minute scan; not worth caching for a list that changes
 * with a game patch and nothing else).
 *
 * New audio never replaces a stock file by name. A pak is pointed at
 * `sound/music/custom/<track>.ogg`, and the file is put where the game looks
 * for loose overrides — `<gamedir>/settings/sound/music/custom/` — so the
 * stock files are untouched, no 1.5 GB archive is rewritten, and the undo is
 * the record. Whether the game honours a loose *music* file there is the one
 * thing only launching it can settle; texture and sound-effect overrides in
 * that folder are how existing mods ship.
 *
 * The records go into the archive the game loads for that target — the
 * campaign's `mods/database.arz` or a Custom Game mod's own database — the
 * same way `gamedata.ts` writes its numbers: a pak the target already holds is
 * replaced, one it lacks is appended, and `undoMusic` reverses exactly that.
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  appendArzRecords,
  arzRecordNames,
  readArzRaw,
  removeArzRecords,
  replaceArzRecords,
  writeArz,
  type RawArzRecord,
} from './arz.js';
import { gameArchives } from './gamefiles.js';
import { targetArchivePath, type GameDataTarget } from './gamedata.js';
import { listMods, resolveModArchive } from './mods.js';

export const MUSIC_PAK_DIR = 'records/sounds/soundpak_musicambient/';
/** Where a pak's track path starts; `sound/` is the archive, `music/…` the entry. */
export const MUSIC_TRACK_PREFIX = 'sound/music/';
/** Where this library's tracks go, as the game names them. */
export const CUSTOM_TRACK_PREFIX = 'sound/music/custom/';
/** The loose-override folder, relative to the game directory. */
export const SETTINGS_OVERRIDE_DIR = 'settings';

export type MusicPakKind = 'hub' | 'exploration' | 'area' | 'boss' | 'menu';

export interface MusicPakInfo {
  kind: MusicPakKind;
  /** What to call it in a sentence. */
  label: string;
  /** The map zones that play it, as the map names them. */
  zones: readonly string[];
  /** Which expansion defines it: '' for the base game. */
  expansion: string;
}

/**
 * Every music pak the game defines, and where the world map plays it. Names
 * are the record's basename without `.dbr`; `musicpak_mainmenu` is defined by
 * all three expansions and the last wins.
 */
export const MUSIC_PAKS: Readonly<Record<string, MusicPakInfo>> = {
  // --- base game ---
  musicpaka00: { kind: 'hub', label: 'Devil’s Crossing', zones: ['DevilsCrossingTown'], expansion: '' },
  musicpaka01: {
    kind: 'exploration',
    label: 'base-game wilderness',
    zones: ['Wightmire', 'Cemetery', 'Forest', 'TownAbandoned', 'and every other base-game zone without its own'],
    expansion: '',
  },
  musicpaka02: { kind: 'hub', label: 'Homestead', zones: ['HomesteadTown'], expansion: '' },
  musicpaka03: { kind: 'exploration', label: 'Infested Fields', zones: ['Infested Fields'], expansion: '' },
  musicpaka04: { kind: 'exploration', label: 'outer Homestead / Port Valbury', zones: ['HomesteadTown (outer)', 'Port Valbury'], expansion: '' },
  musicpak_cronleymine: { kind: 'area', label: 'Cronley’s mine', zones: ['Cronley Mine'], expansion: '' },
  musicpak_cronleygang: { kind: 'area', label: 'Cronley’s hideout', zones: ['Cronley Gang'], expansion: '' },
  musicpak_bossroomambient: { kind: 'boss', label: 'boss-room ambience', zones: ['Boss Room Ambient'], expansion: '' },
  musicpak_lonelymoon: { kind: 'hub', label: 'Malmouth Resistance hideout (sewers)', zones: ['GDX1 - Sewer Hideout'], expansion: '' },
  // --- Ashes of Malmouth ---
  musicpak_ugdenbog: { kind: 'exploration', label: 'Ugdenbog, Dark Wood, Barrowholm, Coven’s Refuge', zones: ['GDX1 - Dark Wood', 'Ugdenbog'], expansion: 'gdx1' },
  musicpak_malmouth_ruins: { kind: 'exploration', label: 'Malmouth outskirts', zones: ['Malmouth ruins'], expansion: 'gdx1' },
  musicpak_malmouth_city: { kind: 'exploration', label: 'Malmouth city', zones: ['GDX1 - Malmouth City'], expansion: 'gdx1' },
  musicpak_malmouth_aetherialfactory: { kind: 'area', label: 'Aetherial factory', zones: ['GDX1 - Aetherial Factory'], expansion: 'gdx1' },
  musicpak_bossambient: { kind: 'boss', label: 'boss ambience (gdx1)', zones: [], expansion: 'gdx1' },
  musicpak_miniboss: { kind: 'boss', label: 'miniboss (gdx1)', zones: [], expansion: 'gdx1' },
  musicpak_mainmenu: { kind: 'menu', label: 'main menu', zones: [], expansion: 'gdx3' },
  // --- Forgotten Gods ---
  musicpak_witchgodcamp: { kind: 'hub', label: 'Conclave of the Three', zones: ['witch-god camp'], expansion: 'gdx2' },
  musicpak_korvandesert: { kind: 'exploration', label: 'Korvan desert and canyon', zones: ['GDX2 - Desert', 'GDX2 - Canyon'], expansion: 'gdx2' },
  musicpak_korvanruins: { kind: 'exploration', label: 'Korvan ruins', zones: ['GDX2 - Korvan Ruins'], expansion: 'gdx2' },
  musicpak_oasis: { kind: 'exploration', label: 'oasis', zones: ['oasis'], expansion: 'gdx2' },
  musicpak_korvaaktemple: { kind: 'area', label: 'Korvaak’s tomb', zones: ['GDX2 - Korvaak Tomb'], expansion: 'gdx2' },
  musicpak_eldritch: { kind: 'exploration', label: 'Eldritch realm', zones: ['eldritch', 'GDX2 - Eldritch Korvaak'], expansion: 'gdx2' },
  musicpak_volcanic: { kind: 'exploration', label: 'lava fields, Korvaak city', zones: ['GDX2 - Lava', 'GDX2 - Korvaak City'], expansion: 'gdx2' },
  musicpak_basaltovergrowth: { kind: 'exploration', label: 'basalt overgrowth', zones: ['basalt overgrowth'], expansion: 'gdx2' },
  musicpak_bonebleach: { kind: 'exploration', label: 'Bonebleach basin', zones: ['bonebleach'], expansion: 'gdx2' },
  // --- Fangs of Asterkarn ---
  musicpak_kurncamp: { kind: 'hub', label: 'Kurnhold', zones: ['GDX3 - Kurnhold'], expansion: 'gdx3' },
  musicpak_verdantvalley: { kind: 'exploration', label: 'Freyoll Valley', zones: ['GDX3 - Freyoll Valley'], expansion: 'gdx3' },
  musicpak_hotsprings: { kind: 'exploration', label: 'Ulo Springs, Kurn ruins', zones: ['GDX3 - Ulo Springs', 'Kurn ruins'], expansion: 'gdx3' },
  musicpak_dreadwastes: { kind: 'exploration', label: 'Dread Wastes, World Tear', zones: ['GDX3 - Dread Wastes', 'GDX3 - World Tear'], expansion: 'gdx3' },
  musicpak_aurorapeaks: { kind: 'exploration', label: 'Aurora Peaks', zones: ['aurora peaks', 'GDX3 - Final Boss'], expansion: 'gdx3' },
  musicpak_icecave: { kind: 'exploration', label: 'ice caves', zones: ['ice cave'], expansion: 'gdx3' },
  musicpak_frozenwastes: { kind: 'exploration', label: 'frozen wastes', zones: ['frozen wastes'], expansion: 'gdx3' },
};

export const MUSIC_PAK_NAMES = Object.keys(MUSIC_PAKS);

export function musicPakRecord(pak: string): string {
  return `${MUSIC_PAK_DIR}${pak}.dbr`;
}

// ---------------------------------------------------------------------------
// Ogg Vorbis
// ---------------------------------------------------------------------------

export interface VorbisIdent {
  channels: number;
  sampleRate: number;
}

/**
 * The identification header of an Ogg Vorbis file: channel count and sample
 * rate, which is all a replacement track has to get right. An Ogg that is not
 * Vorbis (Opus, FLAC-in-Ogg) has no such header and is refused — the game
 * links `libvorbis`, nothing else.
 */
export function vorbisIdent(head: Buffer): VorbisIdent | undefined {
  if (head.length < 58 || head.toString('latin1', 0, 4) !== 'OggS') return undefined;
  const at = head.indexOf(Buffer.from('\x01vorbis', 'latin1'));
  if (at < 0 || at + 30 > head.length) return undefined;
  return { channels: head[at + 11]!, sampleRate: head.readUInt32LE(at + 12) };
}

export const STOCK_SAMPLE_RATE = 44100;
export const STOCK_CHANNELS = 2;
/** Integrated loudness of the stock tracks (`lament` −14.1, `lonely moon` −15.6, `dreaded` −14.8 LUFS). A replacement should be normalised to this, or it is inaudible under the ambience. */
export const STOCK_LUFS = -15;

/** `Hiraeth (Scott Buckley).mp3` → `hiraeth_scott_buckley.ogg` — what the game will call it. */
export function trackSlug(path: string): string {
  const name = basename(path).replace(/\.[^.]+$/, '');
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${slug || 'track'}.ogg`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface MusicPakState {
  pak: string;
  record: string;
  tracks: string[];
  randomize: boolean;
  /** Which archive the winning record came from: an expansion, the mod, or `target`. */
  from: string;
  raw: RawArzRecord;
}

function pakOf(record: string): string {
  return basename(record, '.dbr').toLowerCase();
}

function tracksOf(rec: RawArzRecord): string[] {
  return (rec.fields.find((f) => f.key === 'tracks')?.values ?? []).map(String).filter((s) => s.length > 0);
}

function randomizeOf(rec: RawArzRecord): boolean {
  return Number(rec.fields.find((f) => f.key === 'randomize')?.values[0] ?? 0) !== 0;
}

/**
 * Every music pak as the game would merge it: the game's archives in load
 * order, then — given a target — the mod being played, or the campaign's base
 * mod. Last wins, per record. Without a target it is the stock game alone.
 */
export function readMusicPaks(gameDir: string, target?: GameDataTarget): Map<string, MusicPakState> {
  const isPak = (r: string) => r.toLowerCase().startsWith(MUSIC_PAK_DIR) && basename(r).toLowerCase().startsWith('musicpak');
  const sources: { from: string; path: string }[] = gameArchives(gameDir).map((a) => ({ from: a.expansion, path: a.path }));
  if (target?.kind === 'mod') {
    const found = resolveModArchive(gameDir, target.mod);
    if (found) sources.push({ from: target.mod, path: found.archivePath });
  } else if (target) {
    sources.push({ from: 'target', path: targetArchivePath(gameDir, target) });
  }
  const out = new Map<string, MusicPakState>();
  for (const source of sources) {
    let buf: Buffer;
    try {
      buf = readFileSync(source.path);
    } catch {
      continue; // an expansion not owned, or a base mod nobody has made yet
    }
    for (const [record, raw] of readArzRaw(buf, { filter: isPak })) {
      out.set(pakOf(record), { pak: pakOf(record), record, tracks: tracksOf(raw), randomize: randomizeOf(raw), from: source.from, raw });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface MusicAssignment {
  /** Local audio files, absolute paths. Must already be Ogg Vorbis. */
  tracks: readonly string[];
  /** `replace` (default) makes these the whole list; `add` keeps what the pak has. */
  mode?: 'replace' | 'add';
  /** Left out: `true` when the list ends up longer than one, else what the pak had. */
  randomize?: boolean;
}

export interface MusicPlanInput {
  gameDir: string;
  target?: GameDataTarget;
  assignments: Readonly<Record<string, MusicAssignment>>;
}

export interface MusicCopy {
  from: string;
  /** Absolute destination under the override folder. */
  to: string;
  /** How the game names it — what goes into the record. */
  track: string;
  /** The destination already holds a different file, and will be overwritten. */
  overwrites: boolean;
}

export interface MusicChange {
  pak: string;
  record: string;
  info: MusicPakInfo;
  before: string[];
  after: string[];
  randomizeBefore: boolean;
  randomizeAfter: boolean;
  /** `replace` rewrites a record the target holds; `append` adds one it lacks; `none` when nothing moves. */
  action: 'replace' | 'append' | 'none';
  /** The record as the target held it, when `action` is `replace` — what an undo puts back. */
  original?: RawArzRecord;
}

export type MusicRefusal =
  | { kind: 'nothing-asked-for' }
  | { kind: 'nothing-to-change' }
  | { kind: 'unknown-pak'; pak: string }
  | { kind: 'pak-missing'; pak: string; record: string }
  | { kind: 'no-tracks'; pak: string }
  | { kind: 'file-missing'; path: string }
  | { kind: 'not-vorbis'; path: string }
  | { kind: 'wrong-encoding'; path: string; channels: number; sampleRate: number }
  | { kind: 'slug-collision'; track: string; paths: string[] }
  | { kind: 'target-mod-missing'; mod: string; installed: string[] }
  | { kind: 'target-unreadable'; path: string; detail: string }
  | { kind: 'verify-mismatch'; detail: string };

export interface MusicPlan {
  target: GameDataTarget;
  arzPath: string;
  action: 'patch' | 'create';
  /** Where the audio goes: `<gamedir>/settings/sound/music/custom`. */
  audioDir: string;
  changes: MusicChange[];
  copies: MusicCopy[];
  refusals: MusicRefusal[];
  /** The archive bytes. Present only when `refusals` is empty. */
  output?: Buffer;
  launchHint?: string;
}

export function customAudioDir(gameDir: string): string {
  return join(gameDir, SETTINGS_OVERRIDE_DIR, ...CUSTOM_TRACK_PREFIX.replace(/\/$/, '').split('/'));
}

function withValues(rec: RawArzRecord, tracks: string[], randomize: boolean): RawArzRecord {
  const fields = rec.fields.map((f) => {
    if (f.key === 'tracks') return { ...f, values: [...tracks] };
    if (f.key === 'randomize') return { ...f, values: [randomize ? 1 : 0] };
    return f;
  });
  if (!fields.some((f) => f.key === 'tracks')) fields.push({ key: 'tracks', type: 2, values: [...tracks] });
  if (!fields.some((f) => f.key === 'randomize')) fields.push({ key: 'randomize', type: 0, values: [randomize ? 1 : 0] });
  return { ...rec, fields };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Work out the edit and build the archive. `output` is present only when
 * nothing refused; nothing here writes to disk.
 */
export function planMusic(input: MusicPlanInput): MusicPlan {
  const { gameDir } = input;
  const target = input.target ?? { kind: 'campaign' };
  const refusals: MusicRefusal[] = [];
  const changes: MusicChange[] = [];
  const copies: MusicCopy[] = [];
  const plan: MusicPlan = {
    target,
    arzPath: targetArchivePath(gameDir, target),
    action: 'create',
    audioDir: customAudioDir(gameDir),
    changes,
    copies,
    refusals,
    ...(target.kind === 'campaign' ? { launchHint: '/basemods' } : {}),
  };

  const asked = Object.keys(input.assignments);
  if (!asked.length) {
    refusals.push({ kind: 'nothing-asked-for' });
    return plan;
  }
  if (target.kind === 'mod' && !resolveModArchive(gameDir, target.mod)) {
    refusals.push({ kind: 'target-mod-missing', mod: target.mod, installed: listMods(gameDir).map((m) => m.name) });
    return plan;
  }

  // The audio first: a file that is not there or not Vorbis refuses before a
  // record is so much as read.
  const slugs = new Map<string, Set<string>>();
  const trackOf = new Map<string, string>();
  for (const pak of asked) {
    for (const path of input.assignments[pak]!.tracks) {
      if (trackOf.has(path)) continue;
      let head: Buffer;
      try {
        head = readFileSync(path).subarray(0, 4096);
      } catch {
        refusals.push({ kind: 'file-missing', path });
        continue;
      }
      const ident = vorbisIdent(head);
      if (!ident) {
        refusals.push({ kind: 'not-vorbis', path });
        continue;
      }
      if (ident.sampleRate !== STOCK_SAMPLE_RATE || ident.channels !== STOCK_CHANNELS) {
        refusals.push({ kind: 'wrong-encoding', path, ...ident });
        continue;
      }
      const slug = trackSlug(path);
      const track = `${CUSTOM_TRACK_PREFIX}${slug}`;
      trackOf.set(path, track);
      const set = slugs.get(slug) ?? new Set<string>();
      set.add(path);
      slugs.set(slug, set);
    }
  }
  for (const [slug, paths] of slugs) {
    if (paths.size > 1) refusals.push({ kind: 'slug-collision', track: `${CUSTOM_TRACK_PREFIX}${slug}`, paths: [...paths] });
  }
  for (const pak of asked) {
    if (!(pak.toLowerCase() in MUSIC_PAKS)) refusals.push({ kind: 'unknown-pak', pak });
  }
  if (refusals.length) return plan;

  let paks: Map<string, MusicPakState>;
  try {
    paks = readMusicPaks(gameDir, target);
  } catch (err) {
    refusals.push({ kind: 'target-unreadable', path: plan.arzPath, detail: (err as Error).message });
    return plan;
  }

  let existing: Buffer | undefined;
  let held = new Set<string>();
  try {
    existing = readFileSync(plan.arzPath);
    plan.action = 'patch';
    held = new Set(arzRecordNames(existing).map((n) => n.toLowerCase()));
  } catch {
    existing = undefined;
  }

  const toReplace: RawArzRecord[] = [];
  const toAppend: RawArzRecord[] = [];
  const expected = new Map<string, RawArzRecord>();

  for (const name of asked) {
    const pak = name.toLowerCase();
    const info = MUSIC_PAKS[pak]!;
    const state = paks.get(pak);
    if (!state) {
      refusals.push({ kind: 'pak-missing', pak, record: musicPakRecord(pak) });
      continue;
    }
    const assignment = input.assignments[name]!;
    const added = assignment.tracks.map((p) => trackOf.get(p)!);
    const after = assignment.mode === 'add' ? [...state.tracks, ...added.filter((t) => !state.tracks.includes(t))] : added;
    if (!after.length) {
      refusals.push({ kind: 'no-tracks', pak });
      continue;
    }
    const randomize = assignment.randomize ?? (after.length > 1 ? true : state.randomize);
    const inTarget = held.has(state.record.toLowerCase());
    const unchanged = sameList(after, state.tracks) && randomize === state.randomize && (inTarget || state.from === 'target');
    const change: MusicChange = {
      pak,
      record: state.record,
      info,
      before: state.tracks,
      after,
      randomizeBefore: state.randomize,
      randomizeAfter: randomize,
      action: unchanged ? 'none' : inTarget ? 'replace' : 'append',
      ...(inTarget && !unchanged ? { original: state.raw } : {}),
    };
    changes.push(change);
    if (unchanged) continue;
    const rec = withValues(state.raw, after, randomize);
    expected.set(state.record, rec);
    (inTarget ? toReplace : toAppend).push(rec);
    for (const path of assignment.tracks) {
      const track = trackOf.get(path)!;
      if (copies.some((c) => c.track === track)) continue;
      const to = join(plan.audioDir, basename(track));
      let overwrites = false;
      try {
        overwrites = !readFileSync(to).equals(readFileSync(path));
      } catch {
        overwrites = false;
      }
      copies.push({ from: path, to, track, overwrites });
    }
  }
  if (refusals.length) return plan;
  if (!expected.size) {
    refusals.push({ kind: 'nothing-to-change' });
    return plan;
  }

  let output: Buffer;
  try {
    if (existing) {
      output = existing;
      if (toReplace.length) output = replaceArzRecords(output, toReplace);
      if (toAppend.length) output = appendArzRecords(output, toAppend);
    } else {
      output = writeArz(toAppend);
    }
  } catch (err) {
    refusals.push({ kind: 'verify-mismatch', detail: `could not build: ${(err as Error).message}` });
    return plan;
  }

  const detail = verify(output, existing, expected, toAppend.length);
  if (detail) {
    refusals.push({ kind: 'verify-mismatch', detail });
    return plan;
  }
  plan.output = output;
  return plan;
}

/** Every record that went in comes back identical, and nothing else moved. */
function verify(
  output: Buffer,
  source: Buffer | undefined,
  expected: ReadonlyMap<string, RawArzRecord>,
  added: number,
): string | undefined {
  if (source) {
    const sourceData = source.readUInt32LE(4);
    if (!output.subarray(24, sourceData).equals(source.subarray(24, sourceData))) {
      return 'a block that was already in the archive has moved';
    }
    if (output.readUInt32LE(12) !== source.readUInt32LE(12) + added) {
      return `${source.readUInt32LE(12)} records in, ${output.readUInt32LE(12)} out, ${added} added`;
    }
  }
  let readBack: Map<string, RawArzRecord>;
  try {
    readBack = readArzRaw(output, { filter: (r) => expected.has(r) });
  } catch (err) {
    return `the archive just written does not read back: ${(err as Error).message}`;
  }
  if (readBack.size !== expected.size) return `${expected.size} records went in, ${readBack.size} came out`;
  for (const [path, want] of expected) {
    const after = readBack.get(path)!;
    if (after.type !== want.type) return `${path}: template class changed`;
    if (after.fields.length !== want.fields.length) return `${path}: ${want.fields.length} fields in, ${after.fields.length} out`;
    for (const [i, was] of want.fields.entries()) {
      const now = after.fields[i]!;
      if (now.key !== was.key || now.type !== was.type) return `${path}: field ${i} changed`;
      if (now.values.length !== was.values.length || now.values.some((v, j) => v !== was.values[j])) {
        return `${path}.${was.key}: values differ`;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export interface MusicUndo {
  /** Records this library appended: they are removed. */
  appended: readonly string[];
  /** Records it replaced, as they were: they are put back. */
  replaced: readonly RawArzRecord[];
}

/** Reverse a `planMusic` commit on the archive as it is now. */
export function undoMusic(buf: Buffer, undo: MusicUndo): Buffer {
  let out = buf;
  if (undo.replaced.length) out = replaceArzRecords(out, undo.replaced);
  if (undo.appended.length) out = removeArzRecords(out, undo.appended);
  return out;
}
