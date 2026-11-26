// The document outline (bookmarks): loading it, and the pure logic the Outline panel
// uses to show it as a tree and map it onto the pages of a tab.
//
// An outline is source data: it never changes for a document id, so it is cached for
// as long as the app runs, like the file's comments.

import { api } from "./api";
import type { DocId, Outline, OutlineItem } from "./types";

const cache = new Map<DocId, Outline>();
const inflight = new Map<DocId, Promise<Outline>>();

export function cachedOutline(docId: DocId): Outline | undefined {
  return cache.get(docId);
}

/** The outline of a document (cached; concurrent calls share one request). */
export function loadOutline(docId: DocId): Promise<Outline> {
  const hit = cache.get(docId);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(docId);
  if (!p) {
    p = api.outline(docId).then(
      (o) => {
        inflight.delete(docId);
        cache.set(docId, o);
        return o;
      },
      (e) => {
        inflight.delete(docId);
        throw e;
      },
    );
    inflight.set(docId, p);
  }
  return p;
}

/** For tests. */
export function clearOutlineCache() {
  cache.clear();
  inflight.clear();
}

/** Where each source page is in a tab: `docId:pageIndex` → its first position. */
export function pagePositions(pages: readonly { docId: DocId; pageIndex: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  pages.forEach((p, i) => {
    const k = `${p.docId}:${p.pageIndex}`;
    if (!map.has(k)) map.set(k, i);
  });
  return map;
}

/** The tab position each entry goes to: null when it has no page in this file, or
 *  when its page was removed from the tab. */
export function entryTargets(docId: DocId, items: readonly OutlineItem[], positions: Map<string, number>): (number | null)[] {
  return items.map((it) => (it.pageIndex == null ? null : positions.get(`${docId}:${it.pageIndex}`) ?? null));
}

export function hasChildren(items: readonly OutlineItem[], i: number): boolean {
  return i + 1 < items.length && items[i + 1].depth > items[i].depth;
}

/** Entries the file shows collapsed: those with children that are not open. */
export function initiallyCollapsed(items: readonly OutlineItem[]): Set<number> {
  const out = new Set<number>();
  items.forEach((it, i) => {
    if (!it.open && hasChildren(items, i)) out.add(i);
  });
  return out;
}

/** Indices of the entries shown when the entries in `collapsed` hide their children. */
export function visibleRows(items: readonly OutlineItem[], collapsed: ReadonlySet<number>): number[] {
  const out: number[] = [];
  let hideBelow = Infinity; // entries deeper than this are inside a collapsed entry
  items.forEach((it, i) => {
    if (it.depth > hideBelow) return;
    hideBelow = Infinity;
    out.push(i);
    if (collapsed.has(i) && hasChildren(items, i)) hideBelow = it.depth;
  });
  return out;
}

/**
 * The entry for the page being read: the one whose page is the latest at or before
 * `current` (the last such entry in document order when several share it). -1 when
 * none is. When that entry is hidden in a collapsed parent, the nearest shown
 * ancestor stands for it.
 */
export function currentEntry(
  items: readonly OutlineItem[],
  targets: readonly (number | null)[],
  current: number,
  shown: ReadonlySet<number>,
): number {
  let best = -1;
  targets.forEach((t, i) => {
    if (t != null && t <= current && (best < 0 || t >= targets[best]!)) best = i;
  });
  if (best < 0 || shown.has(best)) return best;
  // Walk up: the parent of an entry is the closest earlier entry that is shallower.
  let depth = items[best].depth;
  for (let i = best - 1; i >= 0 && depth > 0; i--) {
    if (items[i].depth >= depth) continue;
    depth = items[i].depth;
    if (shown.has(i)) return i;
  }
  return -1;
}
