import { afterEach, describe, expect, it, vi } from "vitest";
import {
  annotBounds,
  cachedPageAnnots,
  clearAnnotCache,
  deletionSet,
  formatAnnotDate,
  hasComment,
  isNote,
  kindLabel,
  moveNote,
  loadAuthor,
  loadPageAnnots,
  newAnnotId,
  overlapsMarkup,
  parsePdfDate,
  pdfDate,
  rectsOverlap,
  repliesTo,
  saveAuthor,
  scanDocument,
  visibleAnnots,
} from "./annotations";
import { EMPTY_EDITS, type PageAnnots, type PageEdits, viewEdits } from "./types";
import { tauriMock } from "../test/tauri";
import { annotInfo, newHighlight, newInk, newNote } from "../test/fixtures";

afterEach(() => clearAnnotCache());

/** Answers list_annotations with one note per page, stopping early when `stopAfter` is set. */
function serve(stopAfter?: number) {
  tauriMock.handle("list_annotations", (a) => {
    const first = a.first as number;
    const count = Math.min(a.count as number, stopAfter ?? Infinity);
    return Array.from({ length: count }, (_, i): PageAnnots => ({
      pageIndex: first + i,
      annots: [annotInfo(0, { contents: `p${first + i}` })],
      more: 0,
    }));
  });
}

describe("loading", () => {
  it("loads one page on a background worker and caches it", async () => {
    serve();
    const [a, b] = [loadPageAnnots(1, 3), loadPageAnnots(1, 3)];
    expect((await a).annots[0].contents).toBe("p3");
    expect(await b).toBe(await a);
    expect(await loadPageAnnots(1, 3)).toBe(await a);
    expect(cachedPageAnnots(1, 3)).toBe(await a);
    expect(tauriMock.calls("list_annotations")).toEqual([{ docId: 1, first: 3, count: 1, background: true }]);
  });

  it("returns an empty page when the worker lists nothing for it", async () => {
    tauriMock.handle("list_annotations", () => []);
    expect(await loadPageAnnots(1, 0)).toEqual({ pageIndex: 0, annots: [], more: 0 });
  });

  it("forgets failures so the next call retries", async () => {
    tauriMock.handle("list_annotations", () => {
      throw new Error("worker crashed");
    });
    await expect(loadPageAnnots(2, 0)).rejects.toThrow("worker crashed");
    serve();
    await expect(loadPageAnnots(2, 0)).resolves.toMatchObject({ pageIndex: 0 });
  });

  it("scans a document in chunks, skipping cached pages", async () => {
    serve();
    await loadPageAnnots(3, 25);
    const progress: number[] = [];
    await scanDocument(3, 45, (n) => progress.push(n));
    expect(tauriMock.calls("list_annotations").slice(1).map((c) => [c.first, c.count])).toEqual([
      [0, 20],
      [20, 5],
      [26, 19],
    ]);
    expect(progress.at(-1)).toBe(45);
    expect(cachedPageAnnots(3, 44)?.annots[0].contents).toBe("p44");
  });

  it("carries on after a response that stopped early, and stops when aborted", async () => {
    serve(2);
    await scanDocument(4, 5, () => {});
    expect(tauriMock.calls("list_annotations").map((c) => c.first)).toEqual([0, 2, 4]);
    serve(0);
    await scanDocument(5, 2, () => {});
    expect(tauriMock.calls("list_annotations").filter((c) => c.docId === 5).map((c) => c.first)).toEqual([0, 1]);
    const ctrl = new AbortController();
    ctrl.abort();
    tauriMock.invoke.mockClear();
    await scanDocument(6, 10, () => {}, ctrl.signal);
    expect(tauriMock.calls("list_annotations")).toEqual([]);
  });
});

describe("edits over the file's comments", () => {
  const list = [
    annotInfo(0, { popup: 1 }),
    annotInfo(2, { inReplyTo: 0, popup: 3 }),
    annotInfo(4, { inReplyTo: 2 }),
    annotInfo(5, { subtype: "Highlight", rect: { x: 72, y: 90, width: 100, height: 14 } }),
    annotInfo(6, { inReplyTo: 5 }),
  ];

  it("drops removed comments and applies changed text", () => {
    const edits = {
      ...EMPTY_EDITS,
      removedAnnots: [4],
      changedAnnots: [{ index: 0, contents: "new", date: "D:2026" }],
    };
    const out = visibleAnnots(list, edits);
    expect(out.map((a) => a.index)).toEqual([0, 2, 5, 6]);
    expect(out[0]).toMatchObject({ contents: "new", date: "D:2026" });
    expect(out[1]).toBe(list[1]);
    expect(visibleAnnots(list, EMPTY_EDITS)).toEqual(list);
  });

  it("deletes a comment with its popup and every reply at any depth", () => {
    expect(deletionSet(list, 0)).toEqual([0, 1, 2, 3, 4]);
    expect(deletionSet(list, 5)).toEqual([5, 6]);
    expect(deletionSet(list, 4)).toEqual([4]);
  });

  it("lists replies", () => {
    expect(repliesTo(list, 0).map((a) => a.index)).toEqual([2]);
    expect(repliesTo(list, 4)).toEqual([]);
  });

  it("finds highlights under an area", () => {
    const area = { x: 80, y: 95, width: 10, height: 5 };
    expect(overlapsMarkup(area, EMPTY_EDITS, list)).toBe(true);
    expect(overlapsMarkup(area, { ...EMPTY_EDITS, removedAnnots: [5] }, list)).toBe(false);
    expect(overlapsMarkup(area, EMPTY_EDITS, undefined)).toBe(false);
    const edits = { ...EMPTY_EDITS, annotations: [newNote("n", { x: 80, y: 95 }), newHighlight("h")] };
    expect(overlapsMarkup(area, edits, [])).toBe(true);
    expect(overlapsMarkup({ x: 500, y: 500, width: 1, height: 1 }, edits, list)).toBe(false);
  });

  it("checks rectangle overlap", () => {
    const r = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsOverlap(r, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap(r, { x: 10, y: 0, width: 5, height: 5 })).toBe(false);
  });
});

describe("moving notes", () => {
  const page = { width: 600, height: 800 };
  const DATE = "D:2026";

  it("moves a note made in the app, kept on the page; other kinds do not move", () => {
    const edits: PageEdits = { ...EMPTY_EDITS, annotations: [newNote("n1"), newHighlight("h1")] };
    const ref = { kind: "new", id: "n1" } as const;
    expect(moveNote(edits, ref, { x: 200.123, y: 300 }, page, [], DATE)!.annotations![0]).toMatchObject({ x: 200.12, y: 300 });
    expect(moveNote(edits, ref, { x: 900, y: -5 }, page, [], DATE)!.annotations![0]).toMatchObject({ x: 580, y: 0 });
    expect(moveNote(edits, ref, { x: 50, y: 60 }, page, [], DATE)).toBeNull(); // where it already is
    expect(moveNote(edits, { kind: "new", id: "h1" }, { x: 1, y: 1 }, page, [], DATE)).toBeNull();
    expect(moveNote(edits, { kind: "new", id: "gone" }, { x: 1, y: 1 }, page, [], DATE)).toBeNull();
  });

  it("moves a note in the file in place, keeping changed text, and only notes", () => {
    const list = [annotInfo(0), annotInfo(1, { subtype: "Highlight" })];
    const ref = { kind: "file", index: 0 } as const;
    const typed: PageEdits = { ...EMPTY_EDITS, changedAnnots: [{ index: 0, contents: "typed", date: "D:2025" }] };
    const moved = moveNote(typed, ref, { x: 10, y: 790 }, page, list, DATE)!;
    expect(moved.changedAnnots).toEqual([{ index: 0, contents: "typed", at: { x: 10, y: 780 }, date: DATE }]);
    const shown = visibleAnnots(list, moved)[0];
    expect(shown.rect).toEqual({ x: 10, y: 780, width: 20, height: 20 });
    expect(shown.contents).toBe("typed");
    expect(moveNote(EMPTY_EDITS, ref, { x: 100, y: 100 }, page, list, DATE)).toBeNull();
    expect(moveNote(EMPTY_EDITS, { kind: "file", index: 1 }, { x: 1, y: 1 }, page, list, DATE)).toBeNull();
    expect(moveNote(EMPTY_EDITS, { kind: "file", index: 9 }, { x: 1, y: 1 }, page, list, DATE)).toBeNull();
  });

  it("a moved note in the file is left out of page-view renders (the overlay draws it)", () => {
    const moved: PageEdits = {
      ...EMPTY_EDITS,
      removedAnnots: [4],
      changedAnnots: [{ index: 0, at: { x: 1, y: 2 }, date: DATE }, { index: 2, contents: "text only", date: DATE }],
      annotations: [newNote("n1")],
    };
    expect(viewEdits(moved)).toEqual({ ...EMPTY_EDITS, removedAnnots: [4, 0] });
    const textOnly: PageEdits = { ...EMPTY_EDITS, changedAnnots: [{ index: 2, contents: "x", date: DATE }] };
    expect(viewEdits(textOnly)).toEqual(EMPTY_EDITS);
    expect(viewEdits(EMPTY_EDITS)).toBe(EMPTY_EDITS);
  });

  it("knows notes, and which comments carry text", () => {
    expect([isNote(newNote("n")), isNote(newHighlight("h")), isNote(annotInfo(0)), isNote(annotInfo(1, { subtype: "Ink" }))]).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(hasComment(newHighlight("h", { contents: "Why?" }))).toBe(true);
    expect(hasComment(newHighlight("h", { contents: " \n" }))).toBe(false);
    const list = [annotInfo(0, { contents: "" }), annotInfo(1, { inReplyTo: 0 })];
    expect(hasComment(list[0], list)).toBe(true);
    expect(hasComment(list[0])).toBe(false);
  });
});

describe("annotBounds", () => {
  it("covers notes, highlights and ink strokes with their width", () => {
    expect(annotBounds(newNote("n", { x: 5, y: 6 }))).toEqual({ x: 5, y: 6, width: 20, height: 20 });
    const hl = newHighlight("h", {
      rects: [
        { x: 10, y: 10, width: 50, height: 10 },
        { x: 5, y: 22, width: 20, height: 10 },
      ],
    });
    expect(annotBounds(hl)).toEqual({ x: 5, y: 10, width: 55, height: 22 });
    expect(annotBounds(newInk("i", { width: 4 }))).toEqual({ x: 8, y: 8, width: 24, height: 14 });
  });
});

describe("dates and ids", () => {
  it("writes local time with its offset", () => {
    const d = new Date(2026, 10, 26, 9, 5, 7);
    const off = -d.getTimezoneOffset();
    const s = pdfDate(d);
    expect(s).toMatch(/^D:20261126090507[+-]\d{2}'\d{2}'$/);
    expect(parsePdfDate(s)?.getTime()).toBe(d.getTime());
    expect(s.slice(16, 17)).toBe(off >= 0 ? "+" : "-");
  });

  it("writes negative offsets", () => {
    const d = new Date(2026, 0, 1);
    vi.spyOn(d, "getTimezoneOffset").mockReturnValue(330);
    expect(pdfDate(d).endsWith("-05'30'")).toBe(true);
  });

  it("parses PDF dates of any precision", () => {
    expect(parsePdfDate("D:20240101120000Z")?.toISOString()).toBe("2024-01-01T12:00:00.000Z");
    expect(parsePdfDate("D:20240101120000+07'00'")?.toISOString()).toBe("2024-01-01T05:00:00.000Z");
    expect(parsePdfDate("D:20240101120000-0530")?.toISOString()).toBe("2024-01-01T17:30:00.000Z");
    expect(parsePdfDate("2024")?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(parsePdfDate("yesterday")).toBeNull();
    expect(formatAnnotDate("")).toBe("");
    expect(formatAnnotDate("D:20240101120000Z")).not.toBe("");
  });

  it("makes unique ids", () => {
    expect(newAnnotId("note")).not.toBe(newAnnotId("note"));
    expect(newAnnotId("ink")).toMatch(/^nova-ink-/);
  });
});

describe("author name", () => {
  it("round-trips through storage", () => {
    saveAuthor("Linh");
    expect(loadAuthor()).toBe("Linh");
    localStorage.removeItem("novapdf.author");
    expect(loadAuthor()).toBe("");
  });

  it("survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadAuthor()).toBe("");
    expect(() => saveAuthor("x")).not.toThrow();
  });
});

describe("kindLabel", () => {
  it("names comment kinds", () => {
    expect([
      kindLabel("Text"),
      kindLabel("note"),
      kindLabel("Highlight"),
      kindLabel("highlight"),
      kindLabel("Ink"),
      kindLabel("ink"),
      kindLabel("FreeText"),
      kindLabel("StrikeOut"),
      kindLabel("FileAttachment"),
      kindLabel("Square"),
    ]).toEqual([
      "Note",
      "Note",
      "Highlight",
      "Highlight",
      "Drawing",
      "Drawing",
      "Text box",
      "Strikethrough",
      "Attachment",
      "Square",
    ]);
  });
});
