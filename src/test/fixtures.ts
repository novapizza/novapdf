// Builders for test data. Keep shapes in sync with src/lib/types.ts.
import type { AnnotInfo, NewAnnot, OpenOutcome, PageText, Paragraph, TextBlock } from "../lib/types";
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

/** A comment already in the file. */
export function annotInfo(index: number, extra: Partial<AnnotInfo> = {}): AnnotInfo {
  return {
    index,
    subtype: "Text",
    rect: { x: 100, y: 100, width: 20, height: 20 },
    contents: `Comment ${index}`,
    truncated: false,
    author: "Ann",
    date: "D:20240101120000Z",
    color: null,
    popup: null,
    inReplyTo: null,
    ...extra,
  };
}

const ANNOT_BASE = { color: [255, 235, 59] as [number, number, number], opacity: 1, contents: "", author: "", date: "D:20261126000000Z" };

export function newNote(id: string, extra: Partial<NewAnnot & { kind: "note" }> = {}): NewAnnot {
  return { ...ANNOT_BASE, id, kind: "note", x: 50, y: 60, ...extra };
}

export function newHighlight(id: string, extra: Partial<NewAnnot & { kind: "highlight" }> = {}): NewAnnot {
  return { ...ANNOT_BASE, id, kind: "highlight", rects: [{ x: 72, y: 90, width: 100, height: 14 }], ...extra };
}

export function newInk(id: string, extra: Partial<NewAnnot & { kind: "ink" }> = {}): NewAnnot {
  return {
    ...ANNOT_BASE,
    id,
    kind: "ink",
    color: [33, 33, 33],
    strokes: [[{ x: 10, y: 10 }, { x: 30, y: 20 }]],
    width: 2,
    ...extra,
  };
}
