// Text selection in read view, from PDFium's character boxes. There is no DOM text
// layer: a drag is snapped to the nearest characters, and the selection is drawn as
// one rectangle per line. The same rectangles become a highlight's quads.

import { api } from "./api";
import type { DocId, Point, Rect, Rotation, TextChars } from "./types";

export interface PageChars {
  /** One UTF-16 code unit per character, so `text[i]` is character `i`. */
  text: string;
  /** x, y, width, height per character; zero size for characters PDFium inserted. */
  boxes: number[];
}

export function decodeChars(tc: TextChars): PageChars {
  let text = "";
  for (let i = 0; i < tc.codes.length; i += 8192) text += String.fromCharCode(...tc.codes.slice(i, i + 8192));
  return { text, boxes: tc.boxes };
}

const CACHE_PAGES = 12;
const cache = new Map<string, Promise<PageChars>>();

/** Characters of a page, cached for the last few pages used. */
export function loadTextChars(docId: DocId, pageIndex: number): Promise<PageChars> {
  const k = `${docId}:${pageIndex}`;
  const hit = cache.get(k);
  if (hit) {
    cache.delete(k);
    cache.set(k, hit);
    return hit;
  }
  const p = api.textChars(docId, pageIndex).then(decodeChars);
  p.catch(() => cache.delete(k));
  cache.set(k, p);
  if (cache.size > CACHE_PAGES) cache.delete(cache.keys().next().value!);
  return p;
}

/** For tests. */
export function clearCharCache() {
  cache.clear();
}

/** Index of the character at (x, y), or the nearest one within `maxDist` points. */
export function charAt(c: PageChars, x: number, y: number, maxDist = 24): number | null {
  const b = c.boxes;
  let best: number | null = null;
  let bestD = maxDist;
  for (let i = 0; i * 4 < b.length; i++) {
    const [bx, by, bw, bh] = [b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]];
    if (bw <= 0 || bh <= 0) continue;
    const dx = Math.max(bx - x, 0, x - (bx + bw));
    const dy = Math.max(by - y, 0, y - (by + bh));
    if (dx === 0 && dy === 0) return i;
    const d = Math.hypot(dx, dy);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

const ordered = (a: number, b: number) => (a <= b ? [a, b] : [b, a]);

/** One rectangle per line for characters `a..b` (either order, inclusive). */
export function selectionRects(c: PageChars, a: number, b: number): Rect[] {
  const [lo, hi] = ordered(a, b);
  const out: Rect[] = [];
  let line: { x0: number; y0: number; x1: number; y1: number } | null = null;
  const flush = () => {
    if (line) out.push({ x: line.x0, y: line.y0, width: line.x1 - line.x0, height: line.y1 - line.y0 });
  };
  for (let i = lo; i <= hi; i++) {
    const [x, y, w, h] = c.boxes.slice(i * 4, i * 4 + 4);
    if (!(w > 0 && h > 0)) continue;
    const mid = y + h / 2;
    // Same line: the character's middle is inside the line, and it does not jump back
    // to the left (a new column or a wrapped line at the same height).
    const same = line && mid > line.y0 && mid < line.y1 && x >= line.x1 - h;
    if (line && same) {
      line.x0 = Math.min(line.x0, x);
      line.x1 = Math.max(line.x1, x + w);
      line.y0 = Math.min(line.y0, y);
      line.y1 = Math.max(line.y1, y + h);
    } else {
      flush();
      line = { x0: x, y0: y, x1: x + w, y1: y + h };
    }
  }
  flush();
  return out;
}

/** Text of characters `a..b` (either order, inclusive), with line breaks as "\n". */
export function selectionText(c: PageChars, a: number, b: number): string {
  const [lo, hi] = ordered(a, b);
  return c.text.slice(lo, hi + 1).replace(/\r\n?/g, "\n");
}

// ---------- rotated pages ----------
//
// Read view shows pages turned by their app rotation. Comments are stored unrotated
// (display space of the page as in the file), so the overlay draws in unrotated
// coordinates inside a box turned with `rotationTransform`, and maps pointer
// positions back with `toUnrotated`.

/** CSS transform (origin top-left) that turns a `w`×`h` box clockwise by `rotation`. */
export function rotationTransform(rotation: Rotation, w: number, h: number): string | undefined {
  switch (rotation) {
    case 90:
      return `translate(${h}px, 0px) rotate(90deg)`;
    case 180:
      return `translate(${w}px, ${h}px) rotate(180deg)`;
    case 270:
      return `translate(0px, ${w}px) rotate(270deg)`;
    default:
      return undefined;
  }
}

/** Maps a point on the turned page back to the unrotated `w`×`h` page. */
export function toUnrotated(sx: number, sy: number, rotation: Rotation, w: number, h: number): Point {
  switch (rotation) {
    case 90:
      return { x: sy, y: h - sx };
    case 180:
      return { x: w - sx, y: h - sy };
    case 270:
      return { x: w - sy, y: sx };
    default:
      return { x: sx, y: sy };
  }
}

/** Where a rectangle of the unrotated `w`×`h` page appears on the turned page. */
export function boxToRotated(r: Rect, rotation: Rotation, w: number, h: number): Rect {
  const at = (u: number, v: number): [number, number] =>
    rotation === 90 ? [h - v, u] : rotation === 180 ? [w - u, h - v] : rotation === 270 ? [v, w - u] : [u, v];
  const [x0, y0] = at(r.x, r.y);
  const [x1, y1] = at(r.x + r.width, r.y + r.height);
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}
