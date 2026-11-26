import { afterEach, describe, expect, it } from "vitest";
import {
  type PageChars,
  boxToRotated,
  charAt,
  clearCharCache,
  decodeChars,
  loadTextChars,
  rotationTransform,
  selectionRects,
  selectionText,
  toUnrotated,
} from "./textSelect";
import type { Rotation } from "./types";
import { tauriMock } from "../test/tauri";

afterEach(() => clearCharCache());

/** "Hi\r\nyo": two lines of 10 × 12 pt characters at y 100 and y 120; the line
 *  break characters were inserted by PDFium and have no box. */
function chars(): PageChars {
  const codes = [..."Hi\r\nyo"].map((c) => c.charCodeAt(0));
  const boxes = [
    [10, 100, 10, 12],
    [20, 100, 10, 12],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [10, 120, 10, 12],
    [20, 120, 10, 12],
  ].flat();
  return decodeChars({ codes, boxes });
}

describe("decodeChars", () => {
  it("keeps one code unit per character, including surrogate halves", () => {
    const c = decodeChars({ codes: [0xd83d, 0xde00, 65], boxes: [] });
    expect(c.text).toBe("😀A");
    expect(c.text.length).toBe(3);
  });

  it("handles pages longer than one chunk", () => {
    const c = decodeChars({ codes: Array(20_000).fill(97), boxes: [] });
    expect(c.text.length).toBe(20_000);
  });
});

describe("loadTextChars", () => {
  it("asks the worker once per page and keeps the last few pages", async () => {
    tauriMock.handle("text_chars", () => ({ codes: [72], boxes: [0, 0, 1, 1] }));
    const a = loadTextChars(1, 0);
    expect(loadTextChars(1, 0)).toBe(a);
    expect((await a).text).toBe("H");
    for (let i = 1; i <= 12; i++) loadTextChars(1, i);
    tauriMock.invoke.mockClear();
    loadTextChars(1, 0); // evicted by the 12 newer pages
    expect(tauriMock.calls("text_chars")).toEqual([{ docId: 1, pageIndex: 0 }]);
  });

  it("forgets failures", async () => {
    let fail = true;
    tauriMock.handle("text_chars", () => {
      if (fail) throw new Error("nope");
      return { codes: [], boxes: [] };
    });
    await expect(loadTextChars(2, 0)).rejects.toThrow("nope");
    fail = false;
    await expect(loadTextChars(2, 0)).resolves.toEqual({ text: "", boxes: [] });
  });
});

describe("charAt", () => {
  it("finds the character under a point, or the nearest one", () => {
    const c = chars();
    expect(charAt(c, 15, 105)).toBe(0);
    expect(charAt(c, 25, 125)).toBe(5);
    expect(charAt(c, 50, 106)).toBe(1); // 20 pt to the right of "i"
    expect(charAt(c, 500, 500)).toBeNull();
    expect(charAt(c, 50, 106, 10)).toBeNull();
  });
});

describe("selection", () => {
  it("draws one rectangle per line, in either drag direction", () => {
    const c = chars();
    const lines = [
      { x: 10, y: 100, width: 20, height: 12 },
      { x: 10, y: 120, width: 20, height: 12 },
    ];
    expect(selectionRects(c, 0, 5)).toEqual(lines);
    expect(selectionRects(c, 5, 0)).toEqual(lines);
    expect(selectionRects(c, 1, 1)).toEqual([{ x: 20, y: 100, width: 10, height: 12 }]);
    expect(selectionRects(c, 2, 3)).toEqual([]);
  });

  it("starts a new line when text jumps back left at the same height", () => {
    const c = decodeChars({
      codes: [97, 98, 99],
      boxes: [
        [100, 100, 10, 12],
        [110, 99, 10, 14],
        [10, 100, 10, 12],
      ].flat(),
    });
    expect(selectionRects(c, 0, 2)).toEqual([
      { x: 100, y: 99, width: 20, height: 14 },
      { x: 10, y: 100, width: 10, height: 12 },
    ]);
  });

  it("copies the text with plain line breaks", () => {
    expect(selectionText(chars(), 5, 0)).toBe("Hi\nyo");
    expect(selectionText(decodeChars({ codes: [97, 13, 98], boxes: [] }), 0, 2)).toBe("a\nb");
  });
});

describe("rotated pages", () => {
  const W = 200;
  const H = 100;
  // Where the unrotated point (u, v) appears on the page turned clockwise.
  const turned = (r: Rotation, u: number, v: number) =>
    r === 90 ? [H - v, u] : r === 180 ? [W - u, H - v] : r === 270 ? [v, W - u] : [u, v];

  it("maps pointer positions back to the unrotated page", () => {
    for (const r of [0, 90, 180, 270] as Rotation[]) {
      for (const [u, v] of [
        [0, 0],
        [30, 70],
        [W, H],
      ]) {
        const [sx, sy] = turned(r, u, v);
        expect(toUnrotated(sx, sy, r, W, H), `rotation ${r}`).toEqual({ x: u, y: v });
      }
    }
  });

  it("places a rectangle on the turned page", () => {
    const r = { x: 10, y: 20, width: 30, height: 5 };
    expect(boxToRotated(r, 0, W, H)).toEqual(r);
    expect(boxToRotated(r, 90, W, H)).toEqual({ x: 75, y: 10, width: 5, height: 30 });
    expect(boxToRotated(r, 180, W, H)).toEqual({ x: 160, y: 75, width: 30, height: 5 });
    expect(boxToRotated(r, 270, W, H)).toEqual({ x: 20, y: 160, width: 5, height: 30 });
  });

  it("turns the overlay box with the page", () => {
    expect(rotationTransform(0, W, H)).toBeUndefined();
    expect(rotationTransform(90, W, H)).toBe("translate(100px, 0px) rotate(90deg)");
    expect(rotationTransform(180, W, H)).toBe("translate(200px, 100px) rotate(180deg)");
    expect(rotationTransform(270, W, H)).toBe("translate(0px, 200px) rotate(270deg)");
  });
});
