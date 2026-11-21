import { describe, expect, it } from "vitest";
import { type Tabs, activeTab, initialTabs, isDirty, neighbourTab, referencedDocs, tabsReducer } from "./tabs";
import { doc, page } from "../test/fixtures";

const openAll = (...docIds: number[]): Tabs =>
  docIds.reduce((s, id) => tabsReducer(s, { type: "open", doc: doc(id, 2) }), initialTabs);
const titles = (s: Tabs) => s.tabs.map((t) => t.title);

describe("tabs", () => {
  it("opening a document adds a tab in front with its own history", () => {
    const s = openAll(1, 2);
    expect(titles(s)).toEqual(["doc1.pdf", "doc2.pdf"]);
    const t = activeTab(s)!;
    expect(t.docId).toBe(2);
    expect(t.history.present.pages.map((p) => [p.docId, p.pageIndex])).toEqual([[2, 0], [2, 1]]);
    expect(t.history.past).toEqual([]);
    expect(t.currentPageId).toBe(t.history.present.pages[0].id);
    expect(isDirty(t)).toBe(false);
  });

  it("opening a document that already has a tab switches to it", () => {
    const s = openAll(1, 2);
    const again = tabsReducer(s, { type: "open", doc: doc(1, 2) });
    expect(titles(again)).toEqual(["doc1.pdf", "doc2.pdf"]);
    expect(activeTab(again)!.docId).toBe(1);
    expect(tabsReducer(again, { type: "open", doc: doc(1, 2) })).toBe(again);
  });

  it("a document with no pages opens with no current page", () => {
    const s = tabsReducer(initialTabs, { type: "open", doc: doc(1, 0) });
    expect(activeTab(s)!.currentPageId).toBeNull();
  });

  it("edits go to the named tab only, and undo stays per tab", () => {
    let s = openAll(1, 2);
    const [a, b] = s.tabs;
    s = tabsReducer(s, { type: "edit", id: a.id, action: { type: "delete", ids: [a.history.present.pages[0].id] } });
    expect(s.tabs[0].history.present.pages).toHaveLength(1);
    expect(isDirty(s.tabs[0])).toBe(true);
    expect(s.tabs[1]).toBe(b);
    s = tabsReducer(s, { type: "edit", id: b.id, action: { type: "undo" } });
    expect(s.tabs[1]).toBe(b); // nothing to undo in b
    s = tabsReducer(s, { type: "edit", id: a.id, action: { type: "undo" } });
    expect(s.tabs[0].history.present.pages).toHaveLength(2);
  });

  it("an action that changes nothing keeps the same state", () => {
    const s = openAll(1);
    expect(tabsReducer(s, { type: "edit", id: s.tabs[0].id, action: { type: "redo" } })).toBe(s);
    expect(tabsReducer(s, { type: "edit", id: "nope", action: { type: "undo" } })).toBe(s);
  });

  it("merging appends another document's pages to the tab", () => {
    let s = openAll(1);
    const id = s.tabs[0].id;
    s = tabsReducer(s, { type: "edit", id, action: { type: "append", pages: [page("x", 7, 0)] } });
    expect(s.tabs[0].history.present.pages.map((p) => p.docId)).toEqual([1, 1, 7]);
  });

  it("openMerged puts several documents into one new tab, in order", () => {
    const s0 = openAll(1);
    const s = tabsReducer(s0, { type: "openMerged", docs: [doc(2, 1), doc(3, 2)] });
    expect(titles(s)).toEqual(["doc1.pdf", "doc2.pdf"]);
    const t = activeTab(s)!;
    expect(t.merged).toBe(true);
    expect(t.history.present.pages.map((p) => [p.docId, p.pageIndex])).toEqual([[2, 0], [3, 0], [3, 1]]);
    expect(t.currentPageId).toBe(t.history.present.pages[0].id);
    expect(isDirty(t)).toBe(false);
    expect(referencedDocs([t])).toEqual(new Set([2, 3]));
    // Opening one of the merged files on its own gets its own tab.
    const again = tabsReducer(s, { type: "open", doc: doc(2, 1) });
    expect(titles(again)).toEqual(["doc1.pdf", "doc2.pdf", "doc2.pdf"]);
    expect(activeTab(again)!.merged).toBeUndefined();
    // A single document is an ordinary tab; nothing changes nothing.
    expect(activeTab(tabsReducer(initialTabs, { type: "openMerged", docs: [doc(4, 1)] }))!.merged).toBeUndefined();
    expect(tabsReducer(s, { type: "openMerged", docs: [] })).toBe(s);
  });

  it("activate switches tabs; unknown or current ids change nothing", () => {
    const s = openAll(1, 2);
    const first = tabsReducer(s, { type: "activate", id: s.tabs[0].id });
    expect(activeTab(first)!.docId).toBe(1);
    expect(tabsReducer(first, { type: "activate", id: s.tabs[0].id })).toBe(first);
    expect(tabsReducer(first, { type: "activate", id: "nope" })).toBe(first);
  });

  it("closing the front tab brings its right neighbour forward, else the left one", () => {
    let s = openAll(1, 2, 3);
    s = tabsReducer(s, { type: "activate", id: s.tabs[1].id });
    s = tabsReducer(s, { type: "close", id: s.tabs[1].id });
    expect(titles(s)).toEqual(["doc1.pdf", "doc3.pdf"]);
    expect(activeTab(s)!.docId).toBe(3);
    s = tabsReducer(s, { type: "close", id: s.tabs[1].id });
    expect(activeTab(s)!.docId).toBe(1);
    s = tabsReducer(s, { type: "close", id: s.tabs[0].id });
    expect(s).toEqual({ tabs: [], active: null });
    expect(activeTab(s)).toBeNull();
  });

  it("closing a background tab keeps the front one; unknown ids change nothing", () => {
    const s = openAll(1, 2);
    const next = tabsReducer(s, { type: "close", id: s.tabs[0].id });
    expect(activeTab(next)!.docId).toBe(2);
    expect(tabsReducer(s, { type: "close", id: "nope" })).toBe(s);
  });

  it("remembers the current page per tab", () => {
    let s = openAll(1, 2);
    const id = s.tabs[0].id;
    s = tabsReducer(s, { type: "setCurrentPage", id, pageId: "p9" });
    expect(s.tabs[0].currentPageId).toBe("p9");
    expect(tabsReducer(s, { type: "setCurrentPage", id, pageId: "p9" })).toBe(s);
  });

  it("neighbourTab wraps around in both directions", () => {
    const s = openAll(1, 2, 3); // third is active
    expect(neighbourTab(s, 1)).toBe(s.tabs[0].id);
    expect(neighbourTab(s, -1)).toBe(s.tabs[1].id);
    expect(neighbourTab(initialTabs, 1)).toBeNull();
  });

  it("referencedDocs includes documents only reachable through undo or redo", () => {
    let s = openAll(1, 2);
    const id = s.tabs[0].id;
    s = tabsReducer(s, { type: "edit", id, action: { type: "append", pages: [page("x", 7, 0)] } });
    s = tabsReducer(s, { type: "edit", id, action: { type: "undo" } });
    expect(referencedDocs(s.tabs)).toEqual(new Set([1, 2, 7]));
    expect(referencedDocs([s.tabs[1]])).toEqual(new Set([2]));
  });
});
