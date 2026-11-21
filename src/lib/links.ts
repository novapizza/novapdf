// Paragraphs that continue from one page onto the next ("linked paragraphs").
//
// A PDF has no text flow, so we do what layout tools do with threaded frames: the
// paragraph's two halves become two boxes, the text is edited as one, and it is
// split so the first box keeps its original number of lines and the rest goes
// into the second box. The second box may grow into empty space below it but never
// over other content; text that still does not fit is reported as overflow.
//
// Line breaks come from the PDF worker, measured with the same fonts that draw them.

import { api } from "./api";
import { estimateBlockBox } from "./fontCss";
import type { PageEdits, PageText, Paragraph, Rect, TextBlock } from "./types";
import type { LinkSide, LinkStyle, PageItem, ParagraphLink } from "../state/workspace";

const round2 = (n: number) => Math.round(n * 100) / 100;
let counter = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++counter}`;

/** Bottom margin we never fill, in points. */
const BOTTOM_MARGIN = 36;

/** Joins the two halves. A word hyphenated across the page break is rejoined. */
export function joinParagraphText(a: string, b: string): string {
  const left = a.trimEnd();
  const right = b.trimStart();
  if (!left) return right;
  if (!right) return left;
  if (/\p{L}-$/u.test(left) && /^\p{Ll}/u.test(right)) return left.slice(0, -1) + right;
  return `${left} ${right}`;
}

/** Extra lines a box may grow into below its last line before it would touch other
 *  content on the page (or the bottom margin). */
export function roomBelowBox(
  box: { x: number; width: number; lastBaseline: number },
  text: PageText,
  edits: PageEdits,
  step: number,
  size: number,
  ignore: { paragraphId?: number; blocks?: Set<string> } = {},
): number {
  const removed = new Set(edits.removedObjects);
  const { lastBaseline } = box;
  const x0 = box.x;
  const x1 = box.x + box.width;
  let limit = text.height - BOTTOM_MARGIN;
  const consider = (r: Rect) => {
    if (r.y > lastBaseline && r.x < x1 && r.x + r.width > x0) limit = Math.min(limit, r.y);
  };
  const ignoreBlocks = ignore.blocks ?? new Set<string>();
  for (const p of text.paragraphs) {
    if (p.id === ignore.paragraphId || p.objectIndices.some((i) => removed.has(i))) continue;
    consider(p.bounds);
  }
  for (const l of text.loose) {
    if (removed.has(l.objectIndex) || l.rotated || l.watermarkMark || l.transparent) continue;
    consider(l.bounds);
  }
  for (const b of edits.blocks) if (!ignoreBlocks.has(b.id)) consider(estimateBlockBox(b));
  const extra = Math.floor((limit - 0.3 * size - lastBaseline) / step);
  return Math.max(0, extra);
}

/** Extra lines a paragraph may grow into below itself. */
export function roomBelow(para: Paragraph, text: PageText, edits: PageEdits, step: number, size: number): number {
  return roomBelowBox(
    { x: para.bounds.x, width: para.bounds.width, lastBaseline: para.firstBaseline + (para.lineCount - 1) * step },
    text,
    edits,
    step,
    size,
    { paragraphId: para.id },
  );
}

/** Wrap width for an edited paragraph. Justified text must keep its right edge, so it
 *  only gets a hair of tolerance; ragged text gets half an em of slack. */
export function paragraphWidth(p: Paragraph, minWidth = 0): number {
  const w = Math.max(p.bounds.width, minWidth);
  return round2(w + (p.align === "justify" ? 0.5 : p.size * 0.5));
}

function boxWidth(p: Paragraph, other: Paragraph): number {
  return paragraphWidth(p, p.wrap ? 0 : other.bounds.width);
}

/** A new link between paragraph `a` (end of its page) and `b` (start of the next). */
export function createLink(
  pageA: PageItem,
  a: Paragraph,
  pageB: PageItem,
  b: Paragraph,
  textB: PageText,
): ParagraphLink {
  const lineHeight = a.wrap ? a.lineHeight : b.wrap ? b.lineHeight : 1.2;
  const style: LinkStyle = {
    font: a.font,
    size: round2(a.size),
    color: a.color,
    lineHeight: round2(lineHeight),
    align: a.align,
    hScale: Math.min(a.hScale ?? 1, b.hScale ?? 1),
  };
  const step = style.size * style.lineHeight;
  return {
    id: newId("link"),
    text: joinParagraphText(a.text, b.text),
    style,
    a: {
      pageId: pageA.id,
      objectIndices: a.objectIndices,
      blockId: newId("linka"),
      x: round2(a.bounds.x),
      baseline: round2(a.firstBaseline),
      width: boxWidth(a, b),
      capacity: Math.max(1, a.lineCount),
      indent: round2(a.indent ?? 0),
    },
    b: {
      pageId: pageB.id,
      objectIndices: b.objectIndices,
      blockId: newId("linkb"),
      x: round2(b.bounds.x),
      baseline: round2(b.firstBaseline),
      width: boxWidth(b, a),
      capacity: Math.max(1, b.lineCount) + roomBelow(b, textB, pageB.edits, step, style.size),
    },
  };
}

export interface Split {
  partA: string;
  partB: string;
  linesA: number;
  linesB: number;
  /** Lines that fit in neither box. */
  overflow: number;
}

export const normalizeText = (s: string) => s.replace(/\r\n?/g, "\n");

/** Splits the text between the two boxes using the worker's real line breaks. */
export async function splitLink(text: string, style: LinkStyle, a: LinkSide, b: LinkSide): Promise<Split> {
  const norm = normalizeText(text);
  const layout = (t: string, side: LinkSide) =>
    api
      .layoutText({ text: t, font: style.font, size: style.size, width: side.width, indent: side.indent ?? 0, hScale: style.hScale ?? 1 })
      .then((r) => r.lineStarts);
  const starts = await layout(norm, a);
  if (starts.length <= a.capacity) {
    return { partA: norm.trimEnd(), partB: "", linesA: norm.trim() ? starts.length : 0, linesB: 0, overflow: 0 };
  }
  const chars = Array.from(norm);
  const cut = starts[a.capacity];
  const partA = chars.slice(0, cut).join("").trimEnd();
  const partB = chars.slice(cut).join("").replace(/^[ \t]+/, "").trimEnd();
  const linesB = partB ? (await layout(partB, b)).length : 0;
  return { partA, partB, linesA: a.capacity, linesB, overflow: Math.max(0, linesB - b.capacity) };
}

function sideBlock(side: LinkSide, text: string, style: LinkStyle, continues: boolean): TextBlock {
  return {
    id: side.blockId,
    x: side.x,
    baseline: side.baseline,
    width: side.width,
    text,
    font: style.font,
    size: style.size,
    color: style.color,
    lineHeight: style.lineHeight,
    align: style.align,
    indent: side.indent ?? 0,
    hScale: style.hScale ?? 1,
    continues,
  };
}

/** Page edits with this half of the link applied: the original paragraph removed and
 *  the half drawn as a block (none when it is empty). */
export function applySide(
  edits: PageEdits,
  side: LinkSide,
  text: string,
  style: LinkStyle,
  continues = false,
): PageEdits {
  const have = new Set(edits.removedObjects);
  const removedObjects = [...edits.removedObjects, ...side.objectIndices.filter((i) => !have.has(i))];
  const blocks = edits.blocks.filter((b) => b.id !== side.blockId);
  if (text.trim()) blocks.push(sideBlock(side, text, style, continues));
  return { ...edits, removedObjects, blocks };
}

/** Edits for both pages of a link after a split. */
export function linkUpdates(
  pages: PageItem[],
  link: ParagraphLink,
  split: Pick<Split, "partA" | "partB">,
): { id: string; edits: PageEdits }[] {
  const pa = pages.find((p) => p.id === link.a.pageId);
  const pb = pages.find((p) => p.id === link.b.pageId);
  if (!pa || !pb) return [];
  return [
    // The first half continues on the next page, so its last line is justified too.
    { id: pa.id, edits: applySide(pa.edits, link.a, split.partA, link.style, split.partB.trim() !== "") },
    { id: pb.id, edits: applySide(pb.edits, link.b, split.partB, link.style) },
  ];
}

/** The link (and which half) a block belongs to. */
export function findLinkForBlock(
  links: ParagraphLink[],
  blockId: string,
): { link: ParagraphLink; side: "a" | "b" } | null {
  for (const link of links) {
    if (link.a.blockId === blockId) return { link, side: "a" };
    if (link.b.blockId === blockId) return { link, side: "b" };
  }
  return null;
}
