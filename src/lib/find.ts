// Find in document (read view). Searches the text of the file page by page, from
// the same character boxes text selection uses, and keeps only the matches: one
// rectangle per line of each match. The page text itself is never held, so a long
// document costs no more than its matches.

import { api } from "./api";
import type { DocId, Rect } from "./types";
import { decodeChars, selectionRects } from "./textSelect";

/** Matches kept for one search. More than this is reported as "capped". */
export const MAX_HITS = 2000;

export interface Hit {
  pageId: string;
  /** One rectangle per line, in the display space of the unrotated page. */
  rects: Rect[];
}

export interface FindResult {
  hits: Hit[];
  /** The search stopped at `MAX_HITS`; the document may hold more. */
  capped: boolean;
}

/** Lower case, with each run of white space as one space (a line break in the page
 *  matches a space in the query). `at[i]` is where folded character `i` is in `text`. */
function fold(text: string): { s: string; at: number[] } {
  let s = "";
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!space && s) {
        s += " ";
        at.push(i);
      }
      space = true;
      continue;
    }
    space = false;
    // A few letters grow when lower-cased; keep those as they are so indices line up.
    const lower = ch.toLowerCase();
    s += lower.length === 1 ? lower : ch;
    at.push(i);
  }
  return { s, at };
}

/** Where `query` occurs in `text`, as inclusive character ranges. Case and the
 *  amount of white space do not matter; matches do not overlap. */
export function matchRanges(text: string, query: string): [number, number][] {
  const q = fold(query).s.trim();
  if (!q) return [];
  const { s, at } = fold(text);
  const out: [number, number][] = [];
  for (let i = s.indexOf(q); i >= 0; i = s.indexOf(q, i + q.length)) out.push([at[i], at[i + q.length - 1]]);
  return out;
}

/**
 * Searches `pages` in order. `onProgress` gets the matches so far after each page
 * that adds some. A page whose text cannot be read is skipped. Set
 * `signal.cancelled` to stop: the promise then resolves with what was found.
 */
export async function findInPages(
  pages: { id: string; docId: DocId; pageIndex: number }[],
  query: string,
  signal: { cancelled: boolean },
  onProgress: (hits: Hit[]) => void,
): Promise<FindResult> {
  const hits: Hit[] = [];
  for (const page of pages) {
    if (signal.cancelled) break;
    let ranges: [number, number][] = [];
    let chars;
    try {
      chars = decodeChars(await api.textChars(page.docId, page.pageIndex));
      ranges = matchRanges(chars.text, query);
    } catch {
      continue;
    }
    if (signal.cancelled) break;
    for (const [a, b] of ranges) {
      const rects = selectionRects(chars, a, b);
      if (rects.length === 0) continue;
      hits.push({ pageId: page.id, rects });
      if (hits.length === MAX_HITS) return { hits, capped: true };
    }
    if (ranges.length) onProgress([...hits]);
  }
  return { hits, capped: false };
}
