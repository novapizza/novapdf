import type { Align, DocId, FontSpec, PageEdits, PageInfo, Rotation, Watermark } from "../lib/types";
import { EMPTY_EDITS } from "../lib/types";

export interface DocInfo {
  docId: DocId;
  fileName: string;
  pages: PageInfo[];
}

export interface PageItem {
  id: string;
  docId: DocId;
  pageIndex: number;
  rotation: Rotation;
  edits: PageEdits;
}

/** One half of a paragraph that continues from one page onto the next. */
export interface LinkSide {
  pageId: string;
  /** Objects of the original paragraph, removed while the link exists. */
  objectIndices: number[];
  /** Id of the text block that draws this half. */
  blockId: string;
  x: number;
  baseline: number;
  width: number;
  /** Most lines this box may hold. */
  capacity: number;
  /** First-line indent (only the half that starts the paragraph has one). */
  indent?: number;
}

export interface LinkStyle {
  font: FontSpec;
  size: number;
  color: [number, number, number];
  lineHeight: number;
  align: Align;
  hScale?: number;
}

/** A paragraph that runs from the bottom of page `a` onto the top of page `b`.
 *  Its text is edited as one and split between the two boxes. */
export interface ParagraphLink {
  id: string;
  a: LinkSide;
  b: LinkSide;
  text: string;
  style: LinkStyle;
}

export interface Workspace {
  pages: PageItem[];
  watermark: Watermark | null;
  links: ParagraphLink[];
}

export interface History {
  past: Workspace[];
  present: Workspace;
  future: Workspace[];
  saved: Workspace;
}

const HISTORY_LIMIT = 200;

export type Action =
  | { type: "reset"; pages: PageItem[] }
  | { type: "append"; pages: PageItem[] }
  | { type: "delete"; ids: string[] }
  | { type: "move"; ids: string[]; overId: string }
  | { type: "rotate"; ids: string[]; delta: 90 | -90 | 180 }
  | { type: "setEdits"; updates: { id: string; edits: PageEdits }[]; links?: ParagraphLink[] }
  | { type: "setWatermark"; watermark: Watermark | null }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "markSaved" };

let counter = 0;
export function newPageId(): string {
  counter += 1;
  return `p${Date.now().toString(36)}-${counter}`;
}

export function pagesFromDoc(doc: DocInfo): PageItem[] {
  return doc.pages.map((_, i) => ({
    id: newPageId(),
    docId: doc.docId,
    pageIndex: i,
    rotation: 0,
    edits: EMPTY_EDITS,
  }));
}

const EMPTY: Workspace = { pages: [], watermark: null, links: [] };
export const initialHistory: History = { past: [], present: EMPTY, future: [], saved: EMPTY };

/** Drops links that no longer hold: a page was deleted or moved so the two halves
 *  are not on consecutive pages, or a page was restored. The text blocks stay. */
export function pruneLinks(ws: Workspace): Workspace {
  if (ws.links.length === 0) return ws;
  const index = new Map(ws.pages.map((p, i) => [p.id, i]));
  const removed = (side: LinkSide) => {
    const page = ws.pages[index.get(side.pageId) ?? -1];
    if (!page) return false;
    const set = new Set(page.edits.removedObjects);
    return side.objectIndices.every((i) => set.has(i));
  };
  const links = ws.links.filter((l) => {
    const ia = index.get(l.a.pageId);
    const ib = index.get(l.b.pageId);
    return ia != null && ib === ia + 1 && removed(l.a) && removed(l.b);
  });
  return links.length === ws.links.length ? ws : { ...ws, links };
}

function commit(h: History, raw: Workspace): History {
  if (raw === h.present) return h;
  const next = pruneLinks(raw);
  const past = [...h.past, h.present];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { ...h, past, present: next, future: [] };
}

/** Moves the selected pages as one block next to `overId`, keeping their order. */
function movePages(pages: PageItem[], ids: string[], overId: string): PageItem[] {
  const moving = new Set(ids);
  if (moving.has(overId)) return pages;
  const fromIndex = pages.findIndex((p) => p.id === ids[0]);
  const overIndex = pages.findIndex((p) => p.id === overId);
  if (fromIndex < 0 || overIndex < 0) return pages;
  const block = pages.filter((p) => moving.has(p.id));
  const rest = pages.filter((p) => !moving.has(p.id));
  let at = rest.findIndex((p) => p.id === overId);
  if (fromIndex < overIndex) at += 1; // moving forward: drop after the target
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

export function reducer(h: History, a: Action): History {
  const ws = h.present;
  switch (a.type) {
    case "reset": {
      const present: Workspace = { pages: a.pages, watermark: null, links: [] };
      return { past: [], present, future: [], saved: present };
    }
    case "append":
      return commit(h, { ...ws, pages: [...ws.pages, ...a.pages] });
    case "delete": {
      const del = new Set(a.ids);
      return commit(h, { ...ws, pages: ws.pages.filter((p) => !del.has(p.id)) });
    }
    case "move": {
      const pages = movePages(ws.pages, a.ids, a.overId);
      return pages === ws.pages ? h : commit(h, { ...ws, pages });
    }
    case "rotate": {
      const ids = new Set(a.ids);
      return commit(h, {
        ...ws,
        pages: ws.pages.map((p) =>
          ids.has(p.id)
            ? { ...p, rotation: ((((p.rotation + a.delta) % 360) + 360) % 360) as Rotation }
            : p,
        ),
      });
    }
    case "setEdits": {
      const map = new Map(a.updates.map((u) => [u.id, u.edits]));
      return commit(h, {
        ...ws,
        pages: ws.pages.map((p) => (map.has(p.id) ? { ...p, edits: map.get(p.id)! } : p)),
        links: a.links ?? ws.links,
      });
    }
    case "setWatermark":
      return commit(h, { ...ws, watermark: a.watermark });
    case "undo": {
      if (h.past.length === 0) return h;
      const prev = h.past[h.past.length - 1];
      return { ...h, past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
    }
    case "redo": {
      if (h.future.length === 0) return h;
      const [next, ...future] = h.future;
      return { ...h, past: [...h.past, h.present], present: next, future };
    }
    case "markSaved":
      return { ...h, saved: h.present };
  }
}

/** Display size of a page item in points, after its app-level rotation. */
export function displaySize(info: PageInfo, rotation: Rotation): PageInfo {
  return rotation === 90 || rotation === 270
    ? { width: info.height, height: info.width }
    : info;
}
