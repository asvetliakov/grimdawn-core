/**
 * Music paks: the records that name the game's tracks, and putting other
 * tracks in them.
 *
 * The archive surgery is the same as `gamedata.ts` uses, so what is worth
 * pinning here is the part that is new — a *list* being replaced, a record
 * being appended and then taken out again (`removeArzRecords`), the Vorbis
 * check standing in front of the copy — and, on a machine with the game, that
 * the pak table matches what the install actually defines.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { appendArzRecords, arzRecordNames, readArzRaw, removeArzRecords, writeArz, type RawArzRecord } from '../src/db/arz.js';
import { findGameDir } from '../src/db/gamefiles.js';
import {
  MUSIC_PAKS,
  MUSIC_PAK_NAMES,
  musicPakRecord,
  planMusic,
  readMusicPaks,
  trackSlug,
  undoMusic,
  vorbisIdent,
} from '../src/db/music.js';
import { MISSING_GAME_MESSAGE, haveGameInstall } from './paths.js';

/** A Vorbis identification header inside a first Ogg page, as ffmpeg writes one. */
function fakeOgg(sampleRate = 44100, channels = 2): Buffer {
  const page = Buffer.alloc(28 + 30 + 40);
  page.write('OggS', 0, 'latin1');
  page.write('\x01vorbis', 28, 'latin1');
  page[28 + 11] = channels;
  page.writeUInt32LE(sampleRate, 28 + 12);
  return page;
}

function pak(record: string, tracks: string[], randomize = 0): RawArzRecord {
  return {
    record,
    type: 'MusicSession',
    fileTime: 1n,
    fields: [
      { key: 'templateName', type: 2, values: ['database/templates/musicpak.tpl'] },
      { key: 'Class', type: 2, values: ['MusicSession'] },
      { key: 'randomize', type: 0, values: [randomize] },
      { key: 'tracks', type: 2, values: tracks },
    ],
  };
}

describe('vorbisIdent', () => {
  it('reads the channel count and sample rate', () => {
    expect(vorbisIdent(fakeOgg(44100, 2))).toEqual({ channels: 2, sampleRate: 44100 });
    expect(vorbisIdent(fakeOgg(48000, 1))).toEqual({ channels: 1, sampleRate: 48000 });
  });
  it('is undefined for anything that is not Ogg Vorbis', () => {
    expect(vorbisIdent(Buffer.from('ID3\x03\x00'.padEnd(100, '\0'), 'latin1'))).toBeUndefined();
    const opus = fakeOgg();
    opus.write('OpusHead', 28, 'latin1');
    expect(vorbisIdent(opus)).toBeUndefined();
  });
});

describe('trackSlug', () => {
  it('names a file the way the game can look it up', () => {
    expect(trackSlug('/x/Hiraeth (Scott Buckley).mp3')).toBe('hiraeth_scott_buckley.ogg');
    expect(trackSlug("/x/Devil's Crossing.ogg")).toBe('devils_crossing.ogg');
    expect(trackSlug('/x/Góða Nótt.flac')).toBe('goa_nott.ogg');
  });
});

describe('removeArzRecords', () => {
  const a = pak('records/a.dbr', ['sound/music/a.ogg']);
  const b = pak('records/b.dbr', ['sound/music/b.ogg', 'sound/music/c.ogg'], 1);
  const c = pak('records/c.dbr', ['sound/music/c.ogg']);
  const archive = writeArz([a, b, c]);

  it('drops the named records and leaves every other one identical', () => {
    const out = removeArzRecords(archive, ['records/B.dbr']);
    expect(arzRecordNames(out)).toEqual(['records/a.dbr', 'records/c.dbr']);
    const back = readArzRaw(out);
    expect(back.get('records/a.dbr')).toEqual(a);
    expect(back.get('records/c.dbr')).toEqual(c);
    // The data region and the string table are carried over byte for byte.
    const dataEnd = archive.readUInt32LE(4);
    expect(out.subarray(24, dataEnd).equals(archive.subarray(24, dataEnd))).toBe(true);
    expect(out.readUInt32LE(20)).toBe(archive.readUInt32LE(20));
  });
  it('throws for a name the archive does not define', () => {
    expect(() => removeArzRecords(archive, ['records/z.dbr'])).toThrow(/not in this archive/);
  });
  it('is the inverse of an append, through undoMusic', () => {
    // Append b to an archive that has a and c, then undo it: the archive must
    // come back naming what it named, with both survivors byte-identical on the
    // way out. Anything less does not test the undo at all.
    const grown = appendArzRecords(writeArz([a, c]), [b]);
    expect(arzRecordNames(grown)).toEqual(['records/a.dbr', 'records/c.dbr', 'records/b.dbr']);
    const undone = undoMusic(grown, { appended: ['records/b.dbr'], replaced: [] });
    expect(arzRecordNames(undone)).toEqual(['records/a.dbr', 'records/c.dbr']);
    const back = readArzRaw(undone);
    expect(back.get('records/a.dbr')).toEqual(a);
    expect(back.get('records/c.dbr')).toEqual(c);
  });
});

describe('the pak table', () => {
  it('names every pak by its record basename', () => {
    for (const name of MUSIC_PAK_NAMES) {
      expect(name).toMatch(/^musicpak/);
      expect(musicPakRecord(name)).toBe(`records/sounds/soundpak_musicambient/${name}.dbr`);
    }
  });
  it('gives each hub exactly one pak and keeps the sewer hideout named', () => {
    const hubs = MUSIC_PAK_NAMES.filter((n) => MUSIC_PAKS[n]!.kind === 'hub');
    expect(hubs.sort()).toEqual(['musicpak_kurncamp', 'musicpak_lonelymoon', 'musicpak_witchgodcamp', 'musicpaka00', 'musicpaka02']);
  });
});

describe.skipIf(!haveGameInstall())(`music paks on the live install (${haveGameInstall() ? 'live' : MISSING_GAME_MESSAGE})`, () => {
  if (!haveGameInstall()) it.skip(MISSING_GAME_MESSAGE, () => {});
  const realGameDir = findGameDir()!;

  it('defines exactly the paks the table names, in the expansions it says', () => {
    const live = readMusicPaks(realGameDir);
    const stock = [...live.values()];
    expect(stock.map((p) => p.pak).sort()).toEqual([...MUSIC_PAK_NAMES].sort());
    for (const p of stock) {
      expect(p.tracks.length, p.pak).toBeGreaterThan(0);
      for (const t of p.tracks) expect(t).toMatch(/^sound\/music\/.*\.ogg$/);
      expect(p.from, p.pak).toBe(MUSIC_PAKS[p.pak]!.expansion === '' ? 'base' : MUSIC_PAKS[p.pak]!.expansion);
    }
    expect(live.get('musicpaka01')!.tracks.length).toBe(13);
    expect(live.get('musicpak_lonelymoon')!.tracks).toEqual(['sound/music/lonely moon.ogg']);
  });

  // A game directory of symlinks to the real archives and an empty `mods/`,
  // so the campaign target is created rather than the real one written.
  const temp = mkdtempSync(join(tmpdir(), 'gd-music-'));
  const gameDir = join(temp, 'game');
  mkdirSync(join(gameDir, 'mods'), { recursive: true });
  mkdirSync(join(gameDir, 'database'));
  symlinkSync(join(realGameDir, 'database', 'database.arz'), join(gameDir, 'database', 'database.arz'));
  for (const x of ['gdx1', 'gdx2', 'gdx3']) {
    const src = join(realGameDir, x);
    if (existsSync(src)) symlinkSync(src, join(gameDir, x));
  }
  const audio = join(temp, 'audio');
  mkdirSync(audio);
  const good = join(audio, 'Hiraeth.ogg');
  writeFileSync(good, fakeOgg());
  writeFileSync(join(audio, 'mono.ogg'), fakeOgg(44100, 1));
  writeFileSync(join(audio, 'song.mp3'), Buffer.from('ID3'.padEnd(100, '\0')));
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  it('refuses audio it cannot use before reading a record', () => {
    const plan = planMusic({
      gameDir,
      assignments: {
        musicpaka00: { tracks: [join(audio, 'mono.ogg'), join(audio, 'song.mp3'), join(audio, 'absent.ogg')] },
        musicpak_nowhere: { tracks: [good] },
      },
    });
    expect(plan.refusals.map((r) => r.kind).sort()).toEqual(['file-missing', 'not-vorbis', 'unknown-pak', 'wrong-encoding']);
    expect(plan.output).toBeUndefined();
  });

  it('creates the campaign base mod, appends the pak, and undoes it', () => {
    const plan = planMusic({ gameDir, assignments: { musicpaka00: { tracks: [good] }, musicpaka01: { tracks: [good], mode: 'add' } } });
    expect(plan.refusals).toEqual([]);
    expect(plan.action).toBe('create');
    expect(plan.launchHint).toBe('/basemods');
    expect(plan.copies).toHaveLength(1);
    expect(plan.copies[0]!.track).toBe('sound/music/custom/hiraeth.ogg');
    expect(plan.copies[0]!.to).toBe(join(gameDir, 'settings', 'sound', 'music', 'custom', 'hiraeth.ogg'));

    const dc = plan.changes.find((c) => c.pak === 'musicpaka00')!;
    expect(dc.action).toBe('append');
    expect(dc.before).toEqual(['sound/music/lament.ogg']);
    expect(dc.after).toEqual(['sound/music/custom/hiraeth.ogg']);
    expect(dc.randomizeAfter).toBe(false); // one track: what the pak had

    const wild = plan.changes.find((c) => c.pak === 'musicpaka01')!;
    expect(wild.after).toHaveLength(14);
    expect(wild.after.at(-1)).toBe('sound/music/custom/hiraeth.ogg');
    expect(wild.randomizeAfter).toBe(true);

    const target = plan.arzPath;
    writeFileSync(target, plan.output!);
    const written = readMusicPaks(gameDir, { kind: 'campaign' });
    expect(written.get('musicpaka00')!.from).toBe('target');
    expect(written.get('musicpaka00')!.tracks).toEqual(['sound/music/custom/hiraeth.ogg']);

    // The same assignment again is nothing to change; a different one replaces.
    const again = planMusic({ gameDir, assignments: { musicpaka00: { tracks: [good] } } });
    expect(again.refusals.map((r) => r.kind)).toEqual(['nothing-to-change']);
    const other = planMusic({ gameDir, assignments: { musicpaka00: { tracks: [good], randomize: true } } });
    expect(other.refusals).toEqual([]);
    expect(other.action).toBe('patch');
    expect(other.changes[0]!.action).toBe('replace');
    expect(other.changes[0]!.original).toBeDefined();
    writeFileSync(target, other.output!);
    expect(readMusicPaks(gameDir, { kind: 'campaign' }).get('musicpaka00')!.randomize).toBe(true);

    // Undo: what was appended goes; what was replaced comes back.
    const undone = undoMusic(other.output!, {
      appended: [musicPakRecord('musicpaka00'), musicPakRecord('musicpaka01')],
      replaced: [],
    });
    expect(arzRecordNames(undone)).toEqual([]);
    writeFileSync(target, undone);
    expect(readMusicPaks(gameDir, { kind: 'campaign' }).get('musicpaka00')!.from).toBe('base');
  });
});
