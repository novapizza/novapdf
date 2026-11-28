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

export type RGB = [number, number, number];

export interface Point {
  x: number;
  y: number;
}

interface NewAnnotBase {
  /** Unique id, also written as /NM. */
  id: string;
  color: RGB;
  opacity: number;
  contents: string;
  author: string;
  /** PDF date, see `pdfDate`. */
  date: string;
}

/** A comment created in the app. Geometry is in display space, like `TextBlock`. */
export type NewAnnot = NewAnnotBase &
  (
    | { kind: "note"; x: number; y: number }
    | { kind: "highlight"; rects: Rect[] }
    | { kind: "ink"; strokes: Point[][]; width: number }
  );

/** An in-place change to a comment already in the file. */
export interface AnnotChange {
  /** Index on the original page. */
  index: number;
  /** New text; left out, the text stays as it is. */
  contents?: string;
  /** New top-left corner of a moved note, in display space. */
  at?: Point;
  date: string;
}

export interface PageEdits {
  removedObjects: number[];
  removedAnnots: number[];
  blocks: TextBlock[];
  /** Changes to comments already in the file. */
  changedAnnots?: AnnotChange[];
  /** Comments created in the app. */
  annotations?: NewAnnot[];
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

/** A comment already in the file. Geometry is in display space. */
export interface AnnotInfo {
  /** Index on the page, as used by `removedAnnots` and `changedAnnots`. */
  index: number;
  /** PDF subtype, such as "Text" or "Highlight". */
  subtype: string;
  rect: Rect;
  /** Plain text (`/Contents`). */
  contents: string;
  /** The text was cut: it must not be edited or written back. */
  truncated: boolean;
  author: string;
  date: string;
  color: RGB | null;
  popup: number | null;
  inReplyTo: number | null;
}

export interface PageAnnots {
  pageIndex: number;
  annots: AnnotInfo[];
  /** Comments beyond the per-page cap, not listed. */
  more: number;
}

/** One bookmark of a document's outline. The tree comes flat, in document order. */
export interface OutlineItem {
  title: string;
  /** 0 for top-level entries. */
  depth: number;
  /** Page in the source document, or null when the bookmark goes nowhere in this file. */
  pageIndex: number | null;
  /** Where on that page, in display space (0 = top), when the file says. */
  y: number | null;
  /** Whether the file shows this entry's children expanded. */
  open: boolean;
}

export interface Outline {
  items: OutlineItem[];
  /** Entries were left out (too many, too deep, or a loop in the file). */
  truncated: boolean;
}

/** Characters of a page: one UTF-16 code unit each, and x, y, width, height per character. */
export interface TextChars {
  codes: number[];
  boxes: number[];
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
  /** Opened with a password; a save keeps it. */
  protected?: boolean;
}

export interface OpenOutcome {
  fileName: string;
  document: OpenedDocument | null;
  error: string | null;
  /** The file needs a password: send it with this id (`api.unlockFile`). With `error`
   *  set too, the password just tried was wrong. */
  locked?: number;
}

/** The recent files list (src-tauri/src/recent.rs). No paths: entries open by id. */
export interface RecentView {
  /** Off: nothing is recorded, and the list is empty. */
  enabled: boolean;
  /** Newest first. */
  items: RecentItem[];
}

export interface RecentItem {
  id: number;
  fileName: string;
  /** The folder the file is in, for display only. */
  folder: string;
  /** Milliseconds since the Unix epoch. */
  openedAt: number;
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
  /** Downloaded and set to install when the app quits. */
  downloaded: boolean;
}

export const EMPTY_EDITS: PageEdits = { removedObjects: [], removedAnnots: [], blocks: [] };

export function editsAreEmpty(e: PageEdits): boolean {
  return (
    e.removedObjects.length === 0 &&
    e.removedAnnots.length === 0 &&
    e.blocks.length === 0 &&
    !e.changedAnnots?.length &&
    !e.annotations?.length
  );
}

/**
 * Edits for a page-view render. Comments created or changed in the app are drawn by
 * the overlay, not by PDFium, so adding or typing into one never re-renders the page.
 * A note in the file that was moved is left out of the render (the overlay draws it
 * where it now is), so moving one re-renders the page once. (Thumbnails and saves use
 * the full edits.)
 */
export function viewEdits(e: PageEdits): PageEdits {
  if (!e.changedAnnots?.length && !e.annotations?.length) return e;
  const moved = (e.changedAnnots ?? []).filter((c) => c.at).map((c) => c.index);
  const removedAnnots = moved.length ? [...new Set([...e.removedAnnots, ...moved])] : e.removedAnnots;
  return { removedObjects: e.removedObjects, removedAnnots, blocks: e.blocks };
}
