import { describe, expect, it } from "vitest";
import {
  type History,
  type ParagraphLink,
  type Workspace,
  displaySize,
  initialHistory,
  newPageId,
  pagesFromDoc,
  pruneLinks,
  reducer,
} from "./workspace";
import { EMPTY_EDITS, type PageEdits, type Watermark } from "../lib/types";
import { block, doc, page } from "../test/fixtures";

const ids = (h: History) => h.present.pages.map((p) => p.id);
const start = (n: number): History =>
  reducer(initialHistory, { type: "reset", pages: Array.from({ length: n }, (_, i) => page(`p${i + 1}`, 1, i)) });

const WM: Watermark = {
  text: "DRAFT",
  font: { family: "Helvetica", bold: true, italic: false },
  size: 48,
  color: [200, 0, 0],
  opacity: 0.3,
  angle: 45,
};

function link(a: string, b: string, objsA = [1], objsB = [2]): ParagraphLink {
  const side = (pageId: string, objectIndices: number[], blockId: string) => ({
    pageId,
    objectIndices,
    blockId,
    x: 72,
    baseline: 100,
    width: 300,
    capacity: 3,
  });
  return {
    id: `link-${a}-${b}`,
    a: side(a, objsA, `${a}-blk`),
    b: side(b, objsB, `${b}-blk`),
    text: "joined",
    style: { font: WM.font, size: 12, color: [0, 0, 0], lineHeight: 1.2, align: "left" },
  };
}

const removing = (objects: number[]): PageEdits => ({ ...EMPTY_EDITS, removedObjects: objects });

describe("newPageId / pagesFromDoc", () => {
  it("makes unique ids", () => {
    const all = new Set(Array.from({ length: 50 }, newPageId));
    expect(all.size).toBe(50);
  });

  it("creates one unrotated, unedited item per page in order", () => {
    const items = pagesFromDoc(doc(7, 3));
    expect(items.map((p) => [p.docId, p.pageIndex, p.rotation])).toEqual([
      [7, 0, 0],
      [7, 1, 0],
      [7, 2, 0],
    ]);
    expect(items.every((p) => p.edits === EMPTY_EDITS)).toBe(true);
    expect(new Set(items.map((p) => p.id)).size).toBe(3);
  });
});

describe("reducer: reset / append / delete", () => {
  it("reset replaces everything, clears history and marks it saved", () => {
    const h0 = reducer(start(2), { type: "setWatermark", watermark: WM });
    const h = reducer(h0, { type: "reset", pages: [page("x")] });
    expect(ids(h)).toEqual(["x"]);
    expect(h.present.watermark).toBeNull();
    expect(h.past).toEqual([]);
    expect(h.future).toEqual([]);
    expect(h.saved).toBe(h.present);
  });

  it("append adds pages at the end and is undoable", () => {
    const h = reducer(start(2), { type: "append", pages: [page("n1"), page("n2")] });
    expect(ids(h)).toEqual(["p1", "p2", "n1", "n2"]);
    expect(ids(reducer(h, { type: "undo" }))).toEqual(["p1", "p2"]);
  });

  it("delete removes only the given ids", () => {
    const h = reducer(start(4), { type: "delete", ids: ["p2", "p4"] });
    expect(ids(h)).toEqual(["p1", "p3"]);
  });
});

describe("reducer: move", () => {
  it("moves a page backward before the target", () => {
    expect(ids(reducer(start(4), { type: "move", ids: ["p4"], overId: "p2" }))).toEqual(["p1", "p4", "p2", "p3"]);
  });

  it("moves a page forward after the target", () => {
    expect(ids(reducer(start(4), { type: "move", ids: ["p1"], overId: "p3" }))).toEqual(["p2", "p3", "p1", "p4"]);
  });

  it("moves a multi-selection as one block, keeping its order", () => {
    expect(ids(reducer(start(5), { type: "move", ids: ["p1", "p3"], overId: "p5" }))).toEqual([
      "p2",
      "p4",
      "p5",
      "p1",
      "p3",
    ]);
  });

  it("is a no-op (no history entry) when dropping on itself or on unknown ids", () => {
    const h = start(3);
    expect(reducer(h, { type: "move", ids: ["p1", "p2"], overId: "p2" })).toBe(h);
    expect(reducer(h, { type: "move", ids: ["nope"], overId: "p2" })).toBe(h);
    expect(reducer(h, { type: "move", ids: ["p1"], overId: "nope" })).toBe(h);
  });
});

describe("reducer: rotate", () => {
  it("rotates selected pages and wraps around 360", () => {
    let h = start(2);
    h = reducer(h, { type: "rotate", ids: ["p1"], delta: 90 });
    h = reducer(h, { type: "rotate", ids: ["p1"], delta: 180 });
    expect(h.present.pages[0].rotation).toBe(270);
    h = reducer(h, { type: "rotate", ids: ["p1"], delta: 90 });
    expect(h.present.pages[0].rotation).toBe(0);
    expect(h.present.pages[1].rotation).toBe(0);
  });

  it("handles negative rotation", () => {
    const h = reducer(start(1), { type: "rotate", ids: ["p1"], delta: -90 });
    expect(h.present.pages[0].rotation).toBe(270);
  });
});

describe("reducer: edits, watermark, links", () => {
  it("setEdits updates only the listed pages", () => {
    const edits = { ...EMPTY_EDITS, blocks: [block("b1")] };
    const h = reducer(start(2), { type: "setEdits", updates: [{ id: "p2", edits }] });
    expect(h.present.pages[0].edits).toBe(EMPTY_EDITS);
    expect(h.present.pages[1].edits).toBe(edits);
  });

  it("setEdits keeps existing links unless new ones are given", () => {
    let h = start(2);
    const l = link("p1", "p2");
    h = reducer(h, {
      type: "setEdits",
      updates: [
        { id: "p1", edits: removing([1]) },
        { id: "p2", edits: removing([2]) },
      ],
      links: [l],
    });
    expect(h.present.links).toEqual([l]);
    h = reducer(h, { type: "setEdits", updates: [] });
    expect(h.present.links).toEqual([l]);
  });

  it("setWatermark sets and clears", () => {
    let h = reducer(start(1), { type: "setWatermark", watermark: WM });
    expect(h.present.watermark).toBe(WM);
    h = reducer(h, { type: "setWatermark", watermark: null });
    expect(h.present.watermark).toBeNull();
  });
});

describe("reducer: undo / redo / markSaved", () => {
  it("undo and redo walk the history", () => {
    let h = start(3);
    h = reducer(h, { type: "delete", ids: ["p1"] });
    h = reducer(h, { type: "rotate", ids: ["p2"], delta: 90 });
    h = reducer(h, { type: "undo" });
    expect(h.present.pages[0].rotation).toBe(0);
    h = reducer(h, { type: "undo" });
    expect(ids(h)).toEqual(["p1", "p2", "p3"]);
    h = reducer(h, { type: "redo" });
    expect(ids(h)).toEqual(["p2", "p3"]);
    h = reducer(h, { type: "redo" });
    expect(h.present.pages[0].rotation).toBe(90);
  });

  it("undo/redo with nothing to do returns the same history", () => {
    const h = start(1);
    expect(reducer(h, { type: "undo" })).toBe(h);
    expect(reducer(h, { type: "redo" })).toBe(h);
  });

  it("a new change clears the redo stack", () => {
    let h = start(2);
    h = reducer(h, { type: "delete", ids: ["p1"] });
    h = reducer(h, { type: "undo" });
    h = reducer(h, { type: "rotate", ids: ["p1"], delta: 90 });
    expect(h.future).toEqual([]);
  });

  it("keeps at most 200 undo steps", () => {
    let h = start(1);
    for (let i = 0; i < 250; i++) h = reducer(h, { type: "rotate", ids: ["p1"], delta: 90 });
    expect(h.past).toHaveLength(200);
  });

  it("markSaved records the present as saved", () => {
    let h = reducer(start(1), { type: "rotate", ids: ["p1"], delta: 90 });
    expect(h.saved).not.toBe(h.present);
    h = reducer(h, { type: "markSaved" });
    expect(h.saved).toBe(h.present);
  });
});

describe("pruneLinks", () => {
  const ws = (pages: Workspace["pages"], links: ParagraphLink[]): Workspace => ({ pages, watermark: null, links });
  const linkedPages = () => [
    page("a", 1, 0, { edits: removing([1]) }),
    page("b", 1, 1, { edits: removing([2]) }),
    page("c", 1, 2),
  ];

  it("returns the same object when there are no links", () => {
    const w = ws([page("a")], []);
    expect(pruneLinks(w)).toBe(w);
  });

  it("keeps a link whose halves are on consecutive pages with their objects removed", () => {
    const w = ws(linkedPages(), [link("a", "b")]);
    expect(pruneLinks(w)).toBe(w);
  });

  it("drops a link when the pages are no longer consecutive", () => {
    const [a, b, c] = linkedPages();
    expect(pruneLinks(ws([a, c, b], [link("a", "b")])).links).toEqual([]);
    expect(pruneLinks(ws([b, a, c], [link("a", "b")])).links).toEqual([]);
  });

  it("drops a link when one page was deleted", () => {
    const [a, , c] = linkedPages();
    expect(pruneLinks(ws([a, c], [link("a", "b")])).links).toEqual([]);
  });

  it("drops a link when its original objects were restored", () => {
    const [a, , c] = linkedPages();
    const restored = page("b", 1, 1);
    expect(pruneLinks(ws([a, restored, c], [link("a", "b")])).links).toEqual([]);
  });

  it("runs on every committed change", () => {
    let h = reducer(initialHistory, { type: "reset", pages: linkedPages() });
    h = reducer(h, {
      type: "setEdits",
      updates: [],
      links: [link("a", "b")],
    });
    expect(h.present.links).toHaveLength(1);
    h = reducer(h, { type: "delete", ids: ["b"] });
    expect(h.present.links).toEqual([]);
  });
});

describe("displaySize", () => {
  it("swaps width and height for quarter turns only", () => {
    const info = { width: 612, height: 792 };
    expect(displaySize(info, 0)).toBe(info);
    expect(displaySize(info, 180)).toBe(info);
    expect(displaySize(info, 90)).toEqual({ width: 792, height: 612 });
    expect(displaySize(info, 270)).toEqual({ width: 792, height: 612 });
  });
});
