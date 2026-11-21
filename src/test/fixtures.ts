// Builders for test data. Keep shapes in sync with src/lib/types.ts.
import type { OpenOutcome, PageText, Paragraph, TextBlock } from "../lib/types";
import { EMPTY_EDITS } from "../lib/types";
import type { DocInfo, PageItem } from "../state/workspace";

export const LETTER = { width: 612, height: 792 };

export function doc(docId: number, pageCount: number, fileName = `doc${docId}.pdf`): DocInfo {
  return { docId, fileName, pages: Array.from({ length: pageCount }, () => ({ ...LETTER })) };
}

export function page(id: string, docId = 1, pageIndex = 0, extra: Partial<PageItem> = {}): PageItem {
  return { id, docId, pageIndex, rotation: 0, edits: EMPTY_EDITS, ...extra };
}

export function opened(d: DocInfo): OpenOutcome {
  return { fileName: d.fileName, document: d, error: null };
}

export function block(id: string, extra: Partial<TextBlock> = {}): TextBlock {
  return {
    id,
    x: 72,
    baseline: 100,
    width: 200,
    text: "Hello",
    font: { family: "Helvetica", bold: false, italic: false },
    size: 12,
    color: [0, 0, 0],
    lineHeight: 1.2,
    align: "left",
    ...extra,
  };
}

export function paragraph(id: number, extra: Partial<Paragraph> = {}): Paragraph {
  return {
    id,
    objectIndices: [id * 10, id * 10 + 1],
    bounds: { x: 72, y: 90, width: 300, height: 30 },
    text: "Paragraph text",
    font: { family: "Helvetica", bold: false, italic: false },
    sourceFont: "ABCDEF+Helvetica",
    size: 12,
    color: [0, 0, 0],
    lineHeight: 1.25,
    firstBaseline: 100,
    align: "left",
    wrap: true,
    lineCount: 2,
    indent: 0,
    hScale: 1,
    mixedStyles: false,
    ...extra,
  };
}

export function pageText(extra: Partial<PageText> = {}): PageText {
  return { width: 612, height: 792, paragraphs: [], loose: [], ...extra };
}

/** A tiny valid JPEG header, enough for a Blob. */
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
