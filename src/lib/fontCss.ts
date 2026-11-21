import type { FontSpec, TextBlock } from "./types";

/** CSS font-family for a font name. React assigns it through the CSSOM, and quotes
 *  and backslashes are stripped, so a hostile name cannot inject CSS. */
export function cssFamily(family: string): string {
  const clean = family.replace(/["'\\;{}<>]/g, "").slice(0, 120);
  switch (clean.toLowerCase()) {
    case "helvetica":
      return "Helvetica, Arial, 'Liberation Sans', sans-serif";
    case "times":
      return "'Times New Roman', Times, 'Liberation Serif', serif";
    case "courier":
      return "'Courier New', Courier, 'Liberation Mono', monospace";
    default:
      return `"${clean}", Arial, sans-serif`;
  }
}

export function cssFont(font: FontSpec, sizePx: number): string {
  return `${font.italic ? "italic " : ""}${font.bold ? "700 " : "400 "}${sizePx}px ${cssFamily(font.family)}`;
}

let ctx: CanvasRenderingContext2D | null = null;
function measureCtx(): CanvasRenderingContext2D {
  if (!ctx) ctx = document.createElement("canvas").getContext("2d")!;
  return ctx;
}

/** Approximate on-screen box of a text block in page points, for overlays only.
 *  The page image itself always comes from the real PDF renderer. */
export function estimateBlockBox(b: TextBlock): { x: number; y: number; width: number; height: number } {
  const c = measureCtx();
  c.font = cssFont(b.font, b.size);
  const hs = b.hScale ?? 1;
  const indent = b.indent ?? 0;
  const w = (s: string) => c.measureText(s).width * hs;
  let lines = 0;
  let widest = 0;
  for (const hard of b.text.split("\n")) {
    if (b.width == null) {
      lines += 1;
      widest = Math.max(widest, w(hard) + indent);
      continue;
    }
    let current = "";
    let first = true;
    for (const word of hard.split(/(?<= )/)) {
      const candidate = current + word;
      const limit = first ? b.width - indent : b.width;
      if (current.trim() && w(candidate.trimEnd()) > limit) {
        lines += 1;
        first = false;
        current = word;
      } else {
        current = candidate;
      }
    }
    lines += 1;
    widest = b.width;
  }
  const width = b.width ?? Math.max(widest, b.size * 2);
  const height = (Math.max(lines, 1) - 1) * b.size * b.lineHeight + b.size * 1.15;
  return { x: b.x, y: b.baseline - b.size * 0.88, width, height };
}
