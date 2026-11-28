import { describe, expect, it, vi } from "vitest";
import { MAX_HITS, findInPages, matchRanges } from "./find";
import { tauriMock } from "../test/tauri";
import type { TextChars } from "./types";

/** One 10×12 pt box per character, left to right on one line; "\n" starts a new line. */
function chars(text: string): TextChars {
  const boxes: number[] = [];
  let x = 0;
  let y = 0;
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") {
      boxes.push(0, 0, 0, 0);
      if (ch === "\n") {
        x = 0;
        y += 20;
      }
      continue;
    }
    boxes.push(x, y, 10, 12);
    x += 10;
  }
  return { codes: [...text].map((c) => c.charCodeAt(0)), boxes };
}

const page = (i: number) => ({ id: `p${i}`, docId: 1, pageIndex: i });

describe("matchRanges", () => {
  it("ignores case and finds every match, without overlaps", () => {
    expect(matchRanges("Soil and SOIL and soil", "soil")).toEqual([
      [0, 3],
      [9, 12],
      [18, 21],
    ]);
    expect(matchRanges("aaaa", "aa")).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("treats a line break in the page as the space in the query", () => {
    const text = "the northern\r\nridge";
    const [[a, b]] = matchRanges(text, "northern  ridge");
    expect(text.slice(a, b + 1)).toBe("northern\r\nridge");
  });

  it("ignores white space around the query and at the start of the page", () => {
    expect(matchRanges("  report", " report ")).toEqual([[2, 7]]);
  });

  it("finds nothing for an empty query or no match", () => {
    expect(matchRanges("report", "   ")).toEqual([]);
    expect(matchRanges("report", "soil")).toEqual([]);
  });

  it("keeps positions right after a letter that grows when lower-cased", () => {
    // "İ".toLowerCase() is two code units; the match after it must not shift.
    expect(matchRanges("İ soil", "soil")).toEqual([[2, 5]]);
  });
});

describe("findInPages", () => {
  it("returns one hit per match with a rectangle per line, in page order", async () => {
    tauriMock.handle("text_chars", (a) => (a.pageIndex === 0 ? chars("soil here") : chars("no\nsoil\nsample soil")));
    const progress = vi.fn();
    const r = await findInPages([page(0), page(1)], "soil", { cancelled: false }, progress);
    expect(r.capped).toBe(false);
    expect(r.hits.map((h) => h.pageId)).toEqual(["p0", "p1", "p1"]);
    expect(r.hits[0].rects).toEqual([{ x: 0, y: 0, width: 40, height: 12 }]);
    expect(r.hits[1].rects).toEqual([{ x: 0, y: 20, width: 40, height: 12 }]);
    // Reported after each page that added matches, with everything found so far.
    expect(progress.mock.calls.map((c) => c[0].length)).toEqual([1, 3]);
  });

  it("a match across a line break gets a rectangle on each line", async () => {
    tauriMock.handle("text_chars", () => chars("field\nreport"));
    const r = await findInPages([page(0)], "field report", { cancelled: false }, vi.fn());
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].rects).toHaveLength(2);
  });

  it("skips pages whose text cannot be read, and pages without a match", async () => {
    tauriMock.handle("text_chars", (a) => {
      if (a.pageIndex === 0) throw "worker crashed";
      return a.pageIndex === 1 ? chars("nothing") : chars("soil");
    });
    const progress = vi.fn();
    const r = await findInPages([page(0), page(1), page(2)], "soil", { cancelled: false }, progress);
    expect(r.hits.map((h) => h.pageId)).toEqual(["p2"]);
    expect(progress).toHaveBeenCalledTimes(1);
  });

  it("drops matches that have no visible characters", async () => {
    tauriMock.handle("text_chars", () => ({ codes: [..."soil"].map((c) => c.charCodeAt(0)), boxes: new Array(16).fill(0) }));
    expect((await findInPages([page(0)], "soil", { cancelled: false }, vi.fn())).hits).toEqual([]);
  });

  it("stops at the limit and says so", async () => {
    tauriMock.handle("text_chars", () => chars("a".repeat(MAX_HITS + 5)));
    const r = await findInPages([page(0), page(1)], "a", { cancelled: false }, vi.fn());
    expect(r.capped).toBe(true);
    expect(r.hits).toHaveLength(MAX_HITS);
    expect(tauriMock.calls("text_chars")).toHaveLength(1);
  });

  it("stops when cancelled, before a page and while one is being read", async () => {
    tauriMock.handle("text_chars", () => chars("soil"));
    expect((await findInPages([page(0)], "soil", { cancelled: true }, vi.fn())).hits).toEqual([]);
    expect(tauriMock.calls("text_chars")).toHaveLength(0);

    const signal = { cancelled: false };
    tauriMock.handle("text_chars", () => {
      signal.cancelled = true;
      return chars("soil");
    });
    const progress = vi.fn();
    expect((await findInPages([page(0), page(1)], "soil", signal, progress)).hits).toEqual([]);
    expect(progress).not.toHaveBeenCalled();
  });
});
