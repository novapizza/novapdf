import { afterEach, describe, expect, it } from "vitest";
import {
  cachedOutline,
  clearOutlineCache,
  currentEntry,
  entryTargets,
  hasChildren,
  initiallyCollapsed,
  loadOutline,
  pagePositions,
  visibleRows,
} from "./outline";
import type { OutlineItem } from "./types";
import { tauriMock } from "../test/tauri";
import { outlineItem as item } from "../test/fixtures";

afterEach(clearOutlineCache);

/**
 *   0 A          p0
 *   1   A.1      p1
 *   2     A.1.a  p2
 *   3   A.2      p3
 *   4 B          p5   (closed)
 *   5   B.1      p6
 *   6 C          none
 */
const TREE: OutlineItem[] = [
  item("A", 0, 0, { open: true }),
  item("A.1", 1, 1, { open: true }),
  item("A.1.a", 2, 2),
  item("A.2", 1, 3),
  item("B", 0, 5),
  item("B.1", 1, 6),
  item("C", 0, null),
];

describe("loading", () => {
  it("caches per document and shares requests in flight", async () => {
    tauriMock.handle("get_outline", ({ docId }) => ({ items: [item(`doc ${docId}`, 0, 0)], truncated: false }));
    expect(cachedOutline(1)).toBeUndefined();
    const [a, b] = await Promise.all([loadOutline(1), loadOutline(1)]);
    expect(a).toBe(b);
    expect(cachedOutline(1)).toBe(a);
    expect(await loadOutline(1)).toBe(a);
    expect(tauriMock.calls("get_outline")).toEqual([{ docId: 1 }]);
    expect((await loadOutline(2)).items[0].title).toBe("doc 2");
  });

  it("a failed load is not cached", async () => {
    let fail = true;
    tauriMock.handle("get_outline", () => {
      if (fail) throw new Error("worker crashed");
      return { items: [], truncated: false };
    });
    await expect(loadOutline(1)).rejects.toThrow("worker crashed");
    expect(cachedOutline(1)).toBeUndefined();
    fail = false;
    expect(await loadOutline(1)).toEqual({ items: [], truncated: false });
  });
});

describe("mapping onto the tab", () => {
  it("finds where each source page is now; removed pages and other files have none", () => {
    const pages = [
      { docId: 1, pageIndex: 3 },
      { docId: 2, pageIndex: 0 },
      { docId: 1, pageIndex: 0 },
      { docId: 1, pageIndex: 3 }, // duplicated: the first copy wins
    ];
    const pos = pagePositions(pages);
    expect(pos.get("1:3")).toBe(0);
    expect(pos.get("1:0")).toBe(2);
    expect(entryTargets(1, TREE, pos)).toEqual([2, null, null, 0, null, null, null]);
    expect(entryTargets(2, TREE.slice(0, 1), pos)).toEqual([1]);
  });
});

describe("the tree", () => {
  it("knows which entries have children", () => {
    expect(TREE.map((_, i) => hasChildren(TREE, i))).toEqual([true, true, false, false, true, false, false]);
  });

  it("starts collapsed where the file says, and hides what collapsed entries hold", () => {
    const closed = initiallyCollapsed(TREE);
    expect([...closed]).toEqual([4]);
    expect(visibleRows(TREE, closed)).toEqual([0, 1, 2, 3, 4, 6]);
    expect(visibleRows(TREE, new Set([0]))).toEqual([0, 4, 5, 6]);
    expect(visibleRows(TREE, new Set([1, 4]))).toEqual([0, 1, 3, 4, 6]);
    // Collapsing an entry without children hides nothing.
    expect(visibleRows(TREE, new Set([2, 6]))).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(visibleRows([], new Set())).toEqual([]);
  });
});

describe("the current entry", () => {
  const all = new Set(TREE.map((_, i) => i));
  const targets = [0, 1, 2, 3, 5, 6, null];

  it("is the entry with the latest page at or before the page being read", () => {
    expect(currentEntry(TREE, targets, 0, all)).toBe(0);
    expect(currentEntry(TREE, targets, 2, all)).toBe(2);
    expect(currentEntry(TREE, targets, 4, all)).toBe(3);
    expect(currentEntry(TREE, targets, 9, all)).toBe(5);
  });

  it("is none before the first bookmarked page", () => {
    expect(currentEntry(TREE, [3, null, null, null, null, null, null], 1, all)).toBe(-1);
  });

  it("prefers the later entry when several go to the same page", () => {
    expect(currentEntry(TREE, [0, 0, 0, null, null, null, null], 0, all)).toBe(2);
  });

  it("works when pages were reordered", () => {
    // A's page is now last in the tab.
    expect(currentEntry(TREE, [9, 1, 2, 3, 5, 6, null], 9, all)).toBe(0);
  });

  it("falls back to the nearest shown ancestor, not an earlier sibling", () => {
    const shown = new Set(visibleRows(TREE, new Set([1])));
    expect(currentEntry(TREE, targets, 2, shown)).toBe(1);
    const top = new Set(visibleRows(TREE, new Set([0])));
    expect(currentEntry(TREE, targets, 3, top)).toBe(0);
    // A shown set that lacks every ancestor (never the case in the panel).
    expect(currentEntry(TREE, targets, 2, new Set())).toBe(-1);
  });
});
