/**
 * Localization, read from the game's own text archives.
 *
 * `resources/Text_<LOCALE>.arc` holds a handful of plain `key=value` files —
 * `tags_items.txt`, `tags_skills.txt`, `tags_ui.txt` and so on — which is where
 * `itemNameTag: tagRelicC003` becomes "Slaughter". Each expansion ships its own
 * archive and they merge in load order, last wins, exactly like the `.arz`
 * database does.
 *
 * This replaced a downloaded localization table once Stage 4's `.arc` reader
 * existed, and the game files won on every axis that was measured:
 *
 *  - **more tags** — 20,322 against 16,246, and the 739 the download had that the
 *    game does not were all the publisher's own website UI strings;
 *  - **current** — a published dump lags the installed build, and where the two
 *    disagreed the game was right (1.3.0.6 skill text against a 1.3.0.0 dump);
 *  - **every locale** — 13 ship with the game, against one fetched per language;
 *  - **no network**, which makes the whole tool work offline.
 *
 * File format: UTF-8 (the base file carries a BOM), CRLF, `#` comments, blank
 * lines, and `key=value` where the value may itself contain `=` and the game's
 * `^`/`{^n}` formatting escapes (stripped later, by `cleanText`).
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ArcArchive } from './arc.js';
import type { GameArchive } from './gamefiles.js';

/** The locale a save's item names come out in when nothing is configured. */
export const DEFAULT_LOCALE = 'en';

function textArchiveName(locale: string): string {
  return `Text_${locale.toUpperCase()}.arc`;
}

/** Locale codes this install can actually produce, e.g. `['CS', 'DE', 'EN', …]`. */
export function availableLocales(gameDir: string): string[] {
  const found = new Set<string>();
  for (const root of ['', 'gdx1', 'gdx2', 'gdx3']) {
    let files: string[];
    try {
      files = readdirSync(join(gameDir, root, 'resources'));
    } catch {
      continue;
    }
    for (const file of files) {
      const match = /^Text_([A-Za-z]+)\.arc$/.exec(file);
      if (match) found.add(match[1]!.toUpperCase());
    }
  }
  return [...found].sort();
}

/**
 * The tag → text table for one locale, merged across the base game and every
 * expansion the install has.
 *
 * `archives` is the `.arz` load order, which doubles as the text load order:
 * both are "base, then each expansion the user owns, last write wins".
 */
export function readGameText(gameDir: string, locale: string, archives: GameArchive[]): Record<string, string> {
  const tags: Record<string, string> = {};
  let found = 0;

  for (const { expansion } of archives) {
    const path = join(gameDir, expansion === 'base' ? '' : expansion, 'resources', textArchiveName(locale));
    if (!existsSync(path)) continue;
    found++;
    const archive = ArcArchive.open(path);
    try {
      for (const name of archive.names()) {
        if (!name.toLowerCase().endsWith('.txt')) continue;
        parseTagFile(archive.read(name)!.toString('utf8'), tags);
      }
    } finally {
      archive.close();
    }
  }

  if (found === 0) {
    const have = availableLocales(gameDir);
    throw new Error(
      `no ${textArchiveName(locale)} in ${gameDir} — this install ships: ${have.join(', ') || '(none)'}`,
    );
  }
  return tags;
}

/**
 * A mod's own text, folded over the game's.
 *
 * Mods ship their tags the same way the game does — an `.arc` of `key=value`
 * files under `resources/` — with one difference that matters: the filename is
 * whatever the author typed. Path of Grim Dawn's is `text_en.arc` where the
 * game's is `Text_EN.arc`, and on a case-sensitive filesystem a composed path
 * finds neither, so the directory is listed and matched instead.
 *
 * Absent text is not an error. The archive is what a mod is loaded *for*, and
 * a mod with no translation for this locale leaves its tags rendering as
 * themselves — which is worse than a name and far better than a refusal.
 * Returns how many archives were folded in, for the progress note.
 */
export function readModText(
  gameDir: string,
  mod: string,
  locale: string,
  tags: Record<string, string>,
): number {
  const dir = join(gameDir, 'mods', mod, 'resources');
  const wanted = textArchiveName(locale).toLowerCase();
  let found = 0;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const file of files) {
    if (file.toLowerCase() !== wanted) continue;
    found++;
    const archive = ArcArchive.open(join(dir, file));
    try {
      for (const name of archive.names()) {
        if (!name.toLowerCase().endsWith('.txt')) continue;
        parseTagFile(archive.read(name)!.toString('utf8'), tags);
      }
    } finally {
      archive.close();
    }
  }
  return found;
}

/** Fold one `tags_*.txt` into `tags`. Exported for the tests. */
export function parseTagFile(text: string, tags: Record<string, string> = {}): Record<string, string> {
  for (const raw of text.split('\n')) {
    // A UTF-8 BOM opens the first file of the base archive, and would otherwise
    // ride along inside the first tag's key.
    const line = raw.replace(/^﻿/, '').replace(/\r$/, '');
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    // Values legitimately contain `=`; keys never do, so the first one splits.
    if (eq <= 0) continue;
    tags[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return tags;
}
