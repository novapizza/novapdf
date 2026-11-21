import { describe, expect, it } from "vitest";
import { cssFamily, cssFont, estimateBlockBox } from "./fontCss";
import { block } from "../test/fixtures";

// The test canvas (src/test/setup.ts) measures every character as 0.5 em.

describe("cssFamily", () => {
  it("maps the standard-14 families to local fallbacks", () => {
    expect(cssFamily("Helvetica")).toMatch(/^Helvetica, Arial/);
    expect(cssFamily("times")).toMatch(/Times New Roman/);
    expect(cssFamily("COURIER")).toMatch(/Courier New/);
  });

  it("quotes other families with a fallback", () => {
    expect(cssFamily("Noto Serif")).toBe('"Noto Serif", Arial, sans-serif');
  });

  it("strips characters that could break out of the CSS value", () => {
    const out = cssFamily(`Evil"; background:url(x)}<script>\\`);
    expect(out).toBe('"Evil background:url(x)script", Arial, sans-serif');
    expect(out).not.toMatch(/[;{}<>\\]/);
    expect(out.match(/"/g)).toHaveLength(2);
  });

  it("caps very long names", () => {
    expect(cssFamily("x".repeat(500)).length).toBeLessThan(160);
  });
});

describe("cssFont", () => {
  it("builds a CSS font shorthand", () => {
    expect(cssFont({ family: "Helvetica", bold: true, italic: true }, 14)).toMatch(/^italic 700 14px Helvetica/);
    expect(cssFont({ family: "Helvetica", bold: false, italic: false }, 9)).toMatch(/^400 9px /);
  });
});

describe("estimateBlockBox", () => {
  it("places the box from the baseline using the font size", () => {
    const box = estimateBlockBox(block("b", { x: 50, baseline: 100, size: 10, width: null, text: "abcd" }));
    expect(box.x).toBe(50);
    expect(box.y).toBeCloseTo(100 - 8.8);
    // One line: 1.15 em tall.
    expect(box.height).toBeCloseTo(11.5);
  });

  it("without a wrap width, is as wide as the widest hard line (at least two em)", () => {
    const b = block("b", { size: 10, width: null, text: "ab\nabcdefgh" });
    const box = estimateBlockBox(b);
    expect(box.width).toBe(40); // 8 chars × 5 pt
    expect(box.height).toBeCloseTo(10 * 1.2 + 11.5); // two lines
    expect(estimateBlockBox(block("b", { size: 10, width: null, text: "a" })).width).toBe(20);
  });

  it("wraps at the given width and counts the lines", () => {
    // "aaaa " = 4 chars measured (trimEnd) = 20pt; width 45 → two words per line.
    const b = block("b", { size: 10, width: 45, lineHeight: 1, text: "aaaa aaaa aaaa aaaa aaaa" });
    const box = estimateBlockBox(b);
    expect(box.width).toBe(45);
    expect(box.height).toBeCloseTo(2 * 10 + 11.5); // three lines
  });

  it("applies indent and horizontal scale", () => {
    const plain = estimateBlockBox(block("b", { size: 10, width: null, text: "abcdefgh" }));
    const scaled = estimateBlockBox(block("b", { size: 10, width: null, text: "abcdefgh", hScale: 0.5, indent: 7 }));
    expect(plain.width).toBe(40);
    expect(scaled.width).toBe(27);
  });

  it("first-line indent pushes words to the next line", () => {
    const text = "aaaa aaaa";
    const noIndent = estimateBlockBox(block("b", { size: 10, width: 50, lineHeight: 1, text }));
    const indented = estimateBlockBox(block("b", { size: 10, width: 50, lineHeight: 1, indent: 20, text }));
    expect(indented.height).toBeGreaterThan(noIndent.height);
  });
});
