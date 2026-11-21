import { describe, expect, it } from "vitest";
import {
  applySide,
  createLink,
  findLinkForBlock,
  joinParagraphText,
  linkUpdates,
  normalizeText,
  paragraphWidth,
  roomBelow,
  roomBelowBox,
  splitLink,
} from "./links";
import { EMPTY_EDITS, type PageEdits } from "./types";
import type { LinkSide, LinkStyle } from "../state/workspace";
import { tauriMock } from "../test/tauri";
import { block, page, pageText, paragraph } from "../test/fixtures";

describe("joinParagraphText", () => {
  it("joins with one space and trims the seam", () => {
    expect(joinParagraphText("end of page  ", "  start of next")).toBe("end of page start of next");
  });
  it("rejoins a word hyphenated across the break", () => {
    expect(joinParagraphText("a hyphen-", "ated word")).toBe("a hyphenated word");
    expect(joinParagraphText("Việt-", "nam")).toBe("Việtnam");
  });
  it("keeps the hyphen before a capital or a number", () => {
    expect(joinParagraphText("Jean-", "Paul")).toBe("Jean- Paul");
    expect(joinParagraphText("pages 1-", "5")).toBe("pages 1- 5");
  });
  it("handles an empty side", () => {
    expect(joinParagraphText("  ", "b")).toBe("b");
    expect(joinParagraphText("a", " ")).toBe("a");
  });
});

describe("normalizeText", () => {
  it("turns CRLF and CR into LF", () => {
    expect(normalizeText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});

describe("paragraphWidth", () => {
  it("gives ragged text half an em of slack and justified text almost none", () => {
    expect(paragraphWidth(paragraph(1, { size: 12, align: "left" }))).toBe(306);
    expect(paragraphWidth(paragraph(1, { size: 12, align: "justify" }))).toBe(300.5);
  });
  it("respects a minimum width", () => {
    expect(paragraphWidth(paragraph(1, { size: 10 }), 400)).toBe(405);
  });
});

describe("roomBelowBox / roomBelow", () => {
  // Page 792 tall: content limit is 792 - 36 = 756.
  const box = { x: 72, width: 300, lastBaseline: 100 };

  it("fills down to the bottom margin on an empty page", () => {
    // (756 - 0.3*10 - 100) / 12 = 54.4 → 54
    expect(roomBelowBox(box, pageText(), EMPTY_EDITS, 12, 10)).toBe(54);
  });

  it("stops at the next paragraph that overlaps horizontally", () => {
    const below = paragraph(2, { bounds: { x: 100, y: 200, width: 100, height: 20 } });
    // (200 - 3 - 100) / 12 = 8.08 → 8
    expect(roomBelowBox(box, pageText({ paragraphs: [below] }), EMPTY_EDITS, 12, 10)).toBe(8);
  });

  it("ignores content beside the box, above it, removed, or the paragraph itself", () => {
    const beside = paragraph(2, { bounds: { x: 400, y: 200, width: 100, height: 20 } });
    const above = paragraph(3, { bounds: { x: 72, y: 50, width: 100, height: 20 } });
    const removed = paragraph(4, { objectIndices: [40], bounds: { x: 72, y: 150, width: 100, height: 20 } });
    const self = paragraph(5, { bounds: { x: 72, y: 150, width: 100, height: 20 } });
    const text = pageText({ paragraphs: [beside, above, removed, self] });
    const edits = { ...EMPTY_EDITS, removedObjects: [40] };
    expect(roomBelowBox(box, text, edits, 12, 10, { paragraphId: 5 })).toBe(54);
  });

  it("ignores rotated, watermark and transparent loose text but not plain loose text", () => {
    const loose = (extra: object) => ({
      objectIndex: 9,
      bounds: { x: 72, y: 160, width: 50, height: 10 },
      text: "x",
      rotated: false,
      transparent: false,
      watermarkMark: false,
      ...extra,
    });
    const skip = pageText({ loose: [loose({ rotated: true }), loose({ watermarkMark: true }), loose({ transparent: true })] });
    expect(roomBelowBox(box, skip, EMPTY_EDITS, 12, 10)).toBe(54);
    const plain = pageText({ loose: [loose({})] });
    expect(roomBelowBox(box, plain, EMPTY_EDITS, 12, 10)).toBe(4);
    expect(roomBelowBox(box, plain, { ...EMPTY_EDITS, removedObjects: [9] }, 12, 10)).toBe(54);
  });

  it("stops at added text boxes unless told to ignore them", () => {
    const edits: PageEdits = { ...EMPTY_EDITS, blocks: [block("tb", { x: 80, baseline: 300, size: 10 })] };
    const blocked = roomBelowBox(box, pageText(), edits, 12, 10);
    expect(blocked).toBeLessThan(54);
    expect(roomBelowBox(box, pageText(), edits, 12, 10, { blocks: new Set(["tb"]) })).toBe(54);
  });

  it("never returns a negative number", () => {
    const tight = paragraph(2, { bounds: { x: 72, y: 101, width: 100, height: 20 } });
    expect(roomBelowBox(box, pageText({ paragraphs: [tight] }), EMPTY_EDITS, 12, 10)).toBe(0);
  });

  it("roomBelow measures from the paragraph's last line", () => {
    const p = paragraph(1, { firstBaseline: 100, lineCount: 3 });
    // last baseline = 100 + 2*12 = 124 → (756 - 3 - 124)/12 = 52.4 → 52
    expect(roomBelow(p, pageText({ paragraphs: [p] }), EMPTY_EDITS, 12, 10)).toBe(52);
  });
});

describe("createLink", () => {
  it("joins the halves and sizes each box from its paragraph", () => {
    const pa = page("A", 1, 0);
    const pb = page("B", 1, 1);
    const a = paragraph(1, { text: "ends in the", firstBaseline: 700, lineCount: 3, indent: 18, size: 11.234 });
    const b = paragraph(2, { text: "sentence here", firstBaseline: 72, lineCount: 1, wrap: false, hScale: 0.9 });
    const l = createLink(pa, a, pb, b, pageText({ paragraphs: [b] }));

    expect(l.text).toBe("ends in the sentence here");
    expect(l.style.size).toBe(11.23);
    expect(l.style.lineHeight).toBe(1.25); // from a (wraps)
    expect(l.style.hScale).toBe(0.9); // the narrower of the two
    expect(l.a).toMatchObject({ pageId: "A", objectIndices: a.objectIndices, capacity: 3, indent: 18, baseline: 700 });
    expect(l.b).toMatchObject({ pageId: "B", objectIndices: b.objectIndices, baseline: 72 });
    expect(l.b.indent).toBeUndefined();
    // b has room to grow below its one line.
    expect(l.b.capacity).toBeGreaterThan(1);
    expect(l.a.blockId).not.toBe(l.b.blockId);
  });

  it("uses 1.2 line height when neither half wraps", () => {
    const one = paragraph(1, { wrap: false, lineCount: 1 });
    const l = createLink(page("A"), one, page("B"), paragraph(2, { wrap: false, lineCount: 1 }), pageText());
    expect(l.style.lineHeight).toBe(1.2);
  });

  it("takes b's line height when only b wraps", () => {
    const a = paragraph(1, { wrap: false, lineCount: 1 });
    const b = paragraph(2, { wrap: true, lineHeight: 1.4 });
    expect(createLink(page("A"), a, page("B"), b, pageText()).style.lineHeight).toBe(1.4);
  });
});

describe("splitLink", () => {
  const style: LinkStyle = {
    font: { family: "Helvetica", bold: false, italic: false },
    size: 10,
    color: [0, 0, 0],
    lineHeight: 1.2,
    align: "left",
  };
  const side = (capacity: number, indent?: number): LinkSide => ({
    pageId: "p",
    objectIndices: [],
    blockId: "b",
    x: 0,
    baseline: 0,
    width: 100,
    capacity,
    indent,
  });
  /** Fake layout: one word per line. Line starts are code-point offsets. */
  const wordPerLine = () =>
    tauriMock.handle("layout_text", (a) => {
      const chars = Array.from((a.args as { text: string }).text);
      const starts = [0];
      chars.forEach((c, i) => c === " " && i + 1 < chars.length && starts.push(i + 1));
      return { lineStarts: starts };
    });

  it("keeps everything in box A when it fits", async () => {
    wordPerLine();
    const s = await splitLink("one two\n", style, side(3), side(3));
    expect(s).toEqual({ partA: "one two", partB: "", linesA: 2, linesB: 0, overflow: 0 });
  });

  it("reports zero lines for blank text", async () => {
    tauriMock.handle("layout_text", () => ({ lineStarts: [0] }));
    expect((await splitLink("   ", style, side(1), side(1))).linesA).toBe(0);
  });

  it("moves the remaining lines to box B and reports overflow", async () => {
    wordPerLine();
    const s = await splitLink("one two three four five", style, side(2), side(2));
    expect(s.partA).toBe("one two");
    expect(s.partB).toBe("three four five");
    expect(s.linesA).toBe(2);
    expect(s.linesB).toBe(3);
    expect(s.overflow).toBe(1);
  });

  it("splits on code points, so emoji and accents are not cut in half", async () => {
    wordPerLine();
    const s = await splitLink("😀😀 ée x", style, side(1), side(5));
    expect(s.partA).toBe("😀😀");
    expect(s.partB).toBe("ée x");
  });

  it("normalises line endings and passes indent and scale to the worker", async () => {
    wordPerLine();
    await splitLink("a\r\nb", { ...style, hScale: 0.9 }, side(5, 12), side(5));
    expect(tauriMock.calls("layout_text")[0]).toEqual({
      args: { text: "a\nb", font: style.font, size: 10, width: 100, indent: 12, hScale: 0.9 },
    });
  });
});

describe("applySide / linkUpdates / findLinkForBlock", () => {
  const style: LinkStyle = {
    font: { family: "Helvetica", bold: false, italic: false },
    size: 10,
    color: [1, 2, 3],
    lineHeight: 1.2,
    align: "justify",
  };
  const sideA: LinkSide = { pageId: "A", objectIndices: [1, 2], blockId: "ba", x: 5, baseline: 6, width: 100, capacity: 2, indent: 9 };
  const sideB: LinkSide = { pageId: "B", objectIndices: [7], blockId: "bb", x: 5, baseline: 6, width: 100, capacity: 2 };
  const theLink = { id: "L", a: sideA, b: sideB, text: "t", style };

  it("removes the original objects once and draws the half as a block", () => {
    const edits = applySide({ ...EMPTY_EDITS, removedObjects: [2, 50] }, sideA, "hello", style, true);
    expect(edits.removedObjects).toEqual([2, 50, 1]);
    expect(edits.blocks).toEqual([
      expect.objectContaining({ id: "ba", text: "hello", indent: 9, hScale: 1, continues: true, color: [1, 2, 3], align: "justify" }),
    ]);
  });

  it("replaces its own previous block and draws nothing for empty text", () => {
    const first = applySide(EMPTY_EDITS, sideB, "old", style);
    const other = { ...first, blocks: [...first.blocks, block("keep")] };
    const second = applySide(other, sideB, "  ", style);
    expect(second.blocks.map((b) => b.id)).toEqual(["keep"]);
    expect(applySide(other, sideB, "new", style).blocks.map((b) => [b.id, b.text, b.indent])).toEqual([
      ["keep", "Hello", undefined],
      ["bb", "new", 0],
    ]);
  });

  it("linkUpdates edits both pages and justifies A's last line only when B has text", () => {
    const pages = [page("A"), page("B")];
    const [ua, ub] = linkUpdates(pages, theLink, { partA: "x", partB: "y" });
    expect(ua.id).toBe("A");
    expect(ua.edits.blocks[0].continues).toBe(true);
    expect(ub.edits.blocks[0].text).toBe("y");
    const [ua2, ub2] = linkUpdates(pages, theLink, { partA: "x", partB: "" });
    expect(ua2.edits.blocks[0].continues).toBe(false);
    expect(ub2.edits.blocks).toEqual([]);
  });

  it("linkUpdates returns nothing when a page is gone", () => {
    expect(linkUpdates([page("A")], theLink, { partA: "x", partB: "y" })).toEqual([]);
  });

  it("findLinkForBlock tells which half a block draws", () => {
    expect(findLinkForBlock([theLink], "ba")).toEqual({ link: theLink, side: "a" });
    expect(findLinkForBlock([theLink], "bb")).toEqual({ link: theLink, side: "b" });
    expect(findLinkForBlock([theLink], "zz")).toBeNull();
  });
});
