// Mirrors src-tauri/src/protocol.rs (camelCase JSON).

export type DocId = number;
export type Rotation = 0 | 90 | 180 | 270;
export type Align = "left" | "center" | "right" | "justify";

export interface FontSpec {
  family: string;
  bold: boolean;
  italic: boolean;
}

/** Coordinates are PDF points in display space: origin top-left, y down. */
export interface TextBlock {
  id: string;
  x: number;
  baseline: number;
  width: number | null;
  text: string;
  font: FontSpec;
  size: number;
  color: [number, number, number];
  lineHeight: number;
  align: Align;
  /** First-line indent of each paragraph, in points. */
  indent?: number;
  /** Horizontal glyph scale (1 = normal), to match the original font's metrics. */
  hScale?: number;
  /** Text continues in another box: justify the last line too. */
  continues?: boolean;
}

export interface PageEdits {
  removedObjects: number[];
  removedAnnots: number[];
  blocks: TextBlock[];
}

export interface Watermark {
  text: string;
  font: FontSpec;
  size: number;
  color: [number, number, number];
  opacity: number;
  angle: number;
}

export interface PageInfo {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Paragraph {
  id: number;
  objectIndices: number[];
  bounds: Rect;
  text: string;
  font: FontSpec;
  sourceFont: string;
  size: number;
  color: [number, number, number];
  lineHeight: number;
  firstBaseline: number;
  align: Align;
  wrap: boolean;
  lineCount: number;
  indent: number;
  hScale: number;
  mixedStyles: boolean;
}

export interface LooseText {
  objectIndex: number;
  bounds: Rect;
  text: string;
  rotated: boolean;
  transparent: boolean;
  watermarkMark: boolean;
}

export interface PageText {
  width: number;
  height: number;
  paragraphs: Paragraph[];
  loose: LooseText[];
}

export interface PageWatermarks {
  pageIndex: number;
  objects: number[];
  annots: number[];
}

export interface WatermarkScan {
  pages: PageWatermarks[];
  markedObjects: number;
  annotations: number;
  matchingText: number;
}

export interface OpenedDocument {
  docId: DocId;
  fileName: string;
  pages: PageInfo[];
}

export interface OpenOutcome {
  fileName: string;
  document: OpenedDocument | null;
  error: string | null;
}

export interface LayoutResult {
  /** Where each line starts, as code-point offsets into the text. */
  lineStarts: number[];
}

export interface UpdateStatus {
  currentVersion: string;
  /** False in builds without an updater endpoint, such as development builds. */
  configured: boolean;
  available: boolean;
  version: string | null;
  notes: string | null;
}

export const EMPTY_EDITS: PageEdits = { removedObjects: [], removedAnnots: [], blocks: [] };

export function editsAreEmpty(e: PageEdits): boolean {
  return e.removedObjects.length === 0 && e.removedAnnots.length === 0 && e.blocks.length === 0;
}
