// Comments (PDF annotations): loading the ones in a file, and the pure logic the
// overlay and the Marks panel share.
//
// Comments already in a file are source data: they never change for a document id,
// so they are cached per page for as long as the app runs. Loads go to a thumbnail
// worker (`background`), so they never queue in front of viewing or editing.

import { api } from "./api";
import type { AnnotInfo, DocId, NewAnnot, PageAnnots, PageEdits, Point, Rect } from "./types";

/** Pages listed per request when scanning a whole document. */
export const SCAN_CHUNK = 20;
/** Size of a sticky-note icon, in points (matches the worker). */
export const NOTE_SIZE = 20;

const cache = new Map<string, PageAnnots>();
const inflight = new Map<string, Promise<PageAnnots>>();
const key = (docId: DocId, pageIndex: number) => `${docId}:${pageIndex}`;

export function cachedPageAnnots(docId: DocId, pageIndex: number): PageAnnots | undefined {
  return cache.get(key(docId, pageIndex));
}

function store(docId: DocId, pages: PageAnnots[]) {
  for (const p of pages) cache.set(key(docId, p.pageIndex), p);
}

/** Comments on one page (cached). */
export function loadPageAnnots(docId: DocId, pageIndex: number): Promise<PageAnnots> {
  const k = key(docId, pageIndex);
  const hit = cache.get(k);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(k);
  if (!p) {
    p = api.listAnnotations(docId, pageIndex, 1, true).then(
      (pages) => {
        inflight.delete(k);
        store(docId, pages);
        return cache.get(k) ?? { pageIndex, annots: [], more: 0 };
      },
      (e) => {
        inflight.delete(k);
        throw e;
      },
    );
    inflight.set(k, p);
  }
  return p;
}

/**
 * Loads the comments of every page of a document that is not cached yet, in chunks,
 * calling `onProgress` with the number of pages done. Stops when `signal` aborts.
 */
export async function scanDocument(
  docId: DocId,
  pageCount: number,
  onProgress: (done: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  let i = 0;
  while (i < pageCount) {
    if (signal?.aborted) return;
    if (cache.has(key(docId, i))) {
      i += 1;
      onProgress(i);
      continue;
    }
    let count = 1;
    while (count < SCAN_CHUNK && i + count < pageCount && !cache.has(key(docId, i + count))) count += 1;
    const pages = await api.listAnnotations(docId, i, count, true);
    store(docId, pages);
    // The worker may stop early on a page with a lot of text; carry on after it.
    i += Math.max(1, pages.length);
    onProgress(Math.min(i, pageCount));
  }
}

/** For tests. */
export function clearAnnotCache() {
  cache.clear();
  inflight.clear();
}

// ---------- edits over the file's comments ----------

/** Text markup whose position is tied to the text under it. */
export const TEXT_MARKUP = new Set(["Highlight", "Underline", "StrikeOut", "Squiggly"]);

/**
 * The file's comments as they are after the edits: removed ones dropped, changed text
 * and moves applied. Replies stay in the list (with `inReplyTo`); callers nest or skip
 * them.
 */
export function visibleAnnots(list: AnnotInfo[], edits: PageEdits): AnnotInfo[] {
  const removed = new Set(edits.removedAnnots);
  const changed = new Map((edits.changedAnnots ?? []).map((c) => [c.index, c]));
  return list
    .filter((a) => !removed.has(a.index))
    .map((a) => {
      const c = changed.get(a.index);
      if (!c) return a;
      return {
        ...a,
        contents: c.contents ?? a.contents,
        date: c.date,
        rect: c.at ? { ...a.rect, x: c.at.x, y: c.at.y } : a.rect,
      };
    });
}

/** Comments that can be moved: notes (markup stays with its text). */
export const isNote = (a: NewAnnot | AnnotInfo) => ("kind" in a ? a.kind === "note" : a.subtype === "Text");

/** Has text worth flagging on markup: its own text, or (for one in the file) replies. */
export function hasComment(a: NewAnnot | AnnotInfo, list: AnnotInfo[] = []): boolean {
  if (a.contents.trim()) return true;
  return "index" in a && list.some((r) => r.inReplyTo === a.index);
}

/**
 * Edits with comment `ref` moved so its top-left corner is at `at` (clamped onto the
 * page of display size `page`). Returns null for anything but a note, or when it
 * does not move.
 */
export function moveNote(
  edits: PageEdits,
  ref: { kind: "file"; index: number } | { kind: "new"; id: string },
  at: Point,
  page: { width: number; height: number },
  existing: AnnotInfo[],
  date: string,
): PageEdits | null {
  const clamp = (v: number, max: number) => Math.round(Math.min(Math.max(0, v), Math.max(0, max)) * 100) / 100;
  if (ref.kind === "new") {
    const list = edits.annotations ?? [];
    const a = list.find((x) => x.id === ref.id);
    if (!a || a.kind !== "note") return null;
    const x = clamp(at.x, page.width - NOTE_SIZE);
    const y = clamp(at.y, page.height - NOTE_SIZE);
    if (x === a.x && y === a.y) return null;
    return { ...edits, annotations: list.map((n) => (n.id === ref.id ? { ...a, x, y } : n)) };
  }
  const info = visibleAnnots(existing, edits).find((x) => x.index === ref.index);
  if (!info || !isNote(info)) return null;
  const x = clamp(at.x, page.width - info.rect.width);
  const y = clamp(at.y, page.height - info.rect.height);
  if (x === info.rect.x && y === info.rect.y) return null;
  const prev = (edits.changedAnnots ?? []).find((c) => c.index === ref.index);
  return {
    ...edits,
    changedAnnots: [
      ...(edits.changedAnnots ?? []).filter((c) => c.index !== ref.index),
      { ...prev, index: ref.index, at: { x, y }, date },
    ],
  };
}

/**
 * Indices to remove when deleting comment `index`: the comment, its popup, every
 * reply to it (at any depth) and their popups. Without this, the popup and replies
 * would be left behind as orphans.
 */
export function deletionSet(list: AnnotInfo[], index: number): number[] {
  const out = new Set<number>([index]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of list) {
      if (!out.has(a.index) && a.inReplyTo != null && out.has(a.inReplyTo)) {
        out.add(a.index);
        grew = true;
      }
    }
  }
  for (const a of list) if (out.has(a.index) && a.popup != null) out.add(a.popup);
  return [...out].sort((x, y) => x - y);
}

/** Replies to comment `index`, oldest first as listed in the file. */
export function repliesTo(list: AnnotInfo[], index: number): AnnotInfo[] {
  return list.filter((a) => a.inReplyTo === index);
}

/** Bounds of a comment created in the app, in display space. */
export function annotBounds(a: NewAnnot): Rect {
  if (a.kind === "note") return { x: a.x, y: a.y, width: NOTE_SIZE, height: NOTE_SIZE };
  const xs: number[] = [];
  const ys: number[] = [];
  if (a.kind === "highlight") {
    for (const r of a.rects) xs.push(r.x, r.x + r.width), ys.push(r.y, r.y + r.height);
  } else {
    const pad = a.width / 2;
    for (const s of a.strokes) for (const p of s) xs.push(p.x - pad, p.x + pad), ys.push(p.y - pad, p.y + pad);
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** True when `area` overlaps a highlight (new, or text markup already in the file). */
export function overlapsMarkup(area: Rect, edits: PageEdits, existing: AnnotInfo[] | undefined): boolean {
  const fresh = (edits.annotations ?? []).some(
    (a) => a.kind === "highlight" && a.rects.some((r) => rectsOverlap(r, area)),
  );
  if (fresh) return true;
  return visibleAnnots(existing ?? [], edits).some((a) => TEXT_MARKUP.has(a.subtype) && rectsOverlap(a.rect, area));
}

// ---------- ids, dates, author ----------

let counter = 0;
export function newAnnotId(kind: string): string {
  counter += 1;
  return `nova-${kind}-${Date.now().toString(36)}-${counter}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A date in PDF format, local time with its offset: `D:YYYYMMDDHHmmSS+HH'mm'`. */
export function pdfDate(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `D:${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}'${pad2(abs % 60)}'`
  );
}

/** Parses a PDF date (any precision, optional offset). Null when it is not one. */
export function parsePdfDate(s: string): Date | null {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{0,2}'?)?/.exec(s.trim());
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", sec = "00", tz] = m;
  let offset = 0;
  if (tz && tz !== "Z") {
    const t = /([+-])(\d{2})'?(\d{0,2})/.exec(tz)!;
    offset = (t[1] === "-" ? -1 : 1) * (Number(t[2]) * 60 + Number(t[3] || 0));
  }
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec) - offset * 60_000;
  return Number.isNaN(utc) ? null : new Date(utc);
}

/** Short, readable date for a comment, or "" when there is none. */
export function formatAnnotDate(s: string): string {
  const d = parsePdfDate(s);
  return d ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}

const AUTHOR_KEY = "novapdf.author";

/** The name written on new comments. Set by the user; never taken from the OS. */
export function loadAuthor(): string {
  try {
    return localStorage.getItem(AUTHOR_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveAuthor(name: string) {
  try {
    localStorage.setItem(AUTHOR_KEY, name);
  } catch {
    // Storage blocked: the name lasts for this session only.
  }
}

/** Label for a comment kind in the UI. */
export function kindLabel(subtype: string): string {
  switch (subtype) {
    case "Text":
    case "note":
      return "Note";
    case "Highlight":
    case "highlight":
      return "Highlight";
    case "Ink":
    case "ink":
      return "Drawing";
    case "FreeText":
      return "Text box";
    case "StrikeOut":
      return "Strikethrough";
    case "FileAttachment":
      return "Attachment";
    default:
      return subtype;
  }
}
