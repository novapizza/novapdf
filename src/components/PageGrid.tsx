import { memo, useEffect, useRef, useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { requestRender, cached } from "../lib/renderCache";
import type { RenderRequest } from "../lib/api";
import type { Watermark } from "../lib/types";
import { editsAreEmpty } from "../lib/types";
import { type DocInfo, type PageItem, displaySize } from "../state/workspace";
import { paperName } from "./Shell";

interface Props {
  pages: PageItem[];
  docs: Map<number, DocInfo>;
  watermark: Watermark | null;
  selection: Set<string>;
  thumbWidth: number;
  onSelect: (id: string, mode: "single" | "toggle" | "range") => void;
  onMove: (ids: string[], overId: string) => void;
  onOpenEditor: (id: string) => void;
}

/** Device pixels, rounded up to 60 px steps so nearby sizes share cache entries
 *  without rendering (and decoding) far more pixels than the thumbnail shows. */
function renderWidth(cssWidth: number): number {
  const px = cssWidth * (window.devicePixelRatio || 1);
  return Math.min(1200, Math.ceil(px / 60) * 60);
}

export function thumbRequest(page: PageItem, cssWidth: number, watermark: Watermark | null): RenderRequest {
  return {
    docId: page.docId,
    pageIndex: page.pageIndex,
    width: renderWidth(cssWidth),
    format: "jpeg",
    rotation: page.rotation,
    edits: editsAreEmpty(page.edits) ? null : page.edits,
    watermark,
    priority: "thumb",
  };
}

export function useThumbnail(req: RenderRequest, visible: boolean) {
  const [url, setUrl] = useState<string | undefined>(() => cached(req));
  const [error, setError] = useState(false);
  const key = JSON.stringify(req);
  useEffect(() => {
    if (!visible) return;
    const hit = cached(req);
    if (hit) {
      setUrl(hit);
      return;
    }
    const ctrl = new AbortController();
    requestRender(req, ctrl.signal).then(
      (u) => {
        if (!ctrl.signal.aborted) {
          setUrl(u);
          setError(false);
        }
      },
      (e) => {
        if (!(e instanceof DOMException && e.name === "AbortError") && !ctrl.signal.aborted) setError(true);
      },
    );
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible]);
  return { url, error };
}

// One IntersectionObserver for every thumbnail (grid and filmstrip) instead of one
// each: a 1000-page document would otherwise create 2000 observers.
const watchers = new Map<Element, (visible: boolean) => void>();
let sharedObserver: IntersectionObserver | null = null;

function observe(el: Element, onChange: (visible: boolean) => void): () => void {
  sharedObserver ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) watchers.get(e.target)?.(e.isIntersecting);
    },
    { rootMargin: "400px 0px" },
  );
  const io = sharedObserver;
  watchers.set(el, onChange);
  io.observe(el);
  return () => {
    watchers.delete(el);
    io.unobserve(el);
  };
}

/** Whether the element is on screen or within 400 px of it. */
export function useVisible<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observe(el, setVisible);
  }, []);
  return [ref, visible];
}

interface ThumbProps {
  page: PageItem;
  number: number;
  doc: DocInfo | undefined;
  showFile: boolean;
  watermark: Watermark | null;
  selected: boolean;
  width: number;
  onSelect: Props["onSelect"];
  onOpenEditor: Props["onOpenEditor"];
}

const Thumb = memo(function Thumb(p: ThumbProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: p.page.id,
  });
  const [boxRef, visible] = useVisible<HTMLDivElement>();
  const info = p.doc?.pages[p.page.pageIndex] ?? { width: 612, height: 792 };
  const size = displaySize(info, p.page.rotation);
  const height = Math.round((p.width * size.height) / size.width);
  const { url, error } = useThumbnail(thumbRequest(p.page, p.width, p.watermark), visible);
  const edited = !editsAreEmpty(p.page.edits);

  return (
    <div
      ref={setNodeRef}
      className={`thumb${p.selected ? " selected" : ""}${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition, width: p.width }}
      {...attributes}
      {...listeners}
      onClick={(e) => p.onSelect(p.page.id, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "single")}
      onDoubleClick={() => p.onOpenEditor(p.page.id)}
      aria-label={`Page ${p.number}`}
    >
      <div className="thumb-head">
        <span className="thumb-num">{String(p.number).padStart(2, "0")}</span>
        {edited && <span className="badge gold" title="This page has edits">Edited</span>}
        {p.page.rotation !== 0 && <span className="badge">{p.page.rotation}° CW</span>}
        <span
          className={`thumb-check${p.selected ? " on" : ""}`}
          role="checkbox"
          aria-checked={p.selected}
          aria-label={`Select page ${p.number}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            p.onSelect(p.page.id, "toggle");
          }}
        />
      </div>
      <div className="thumb-img" ref={boxRef} style={{ height }}>
        {url ? (
          <img src={url} alt="" draggable={false} decoding="async" />
        ) : (
          <div className={`thumb-placeholder${error ? " error" : ""}`}>{error ? "Render failed" : ""}</div>
        )}
        {p.selected && <span className="thumb-selected">Selected</span>}
      </div>
      <div className="thumb-label">
        <span>{paperName(size.width, size.height)}</span>
        {p.showFile && p.doc && (
          <span className="thumb-file" title={p.doc.fileName}>
            {p.doc.fileName}
          </span>
        )}
      </div>
    </div>
  );
});

export function PageGrid(props: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [dragId, setDragId] = useState<string | null>(null);
  const multiDoc = props.docs.size > 1;

  const onDragStart = (e: DragStartEvent) => setDragId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    if (!e.over || e.active.id === e.over.id) return;
    const active = String(e.active.id);
    const ids = props.selection.has(active)
      ? props.pages.filter((p) => props.selection.has(p.id)).map((p) => p.id)
      : [active];
    props.onMove(ids, String(e.over.id));
  };

  const dragCount = dragId && props.selection.has(dragId) ? props.selection.size : 1;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragId(null)}>
      <SortableContext items={props.pages.map((p) => p.id)} strategy={rectSortingStrategy}>
        <div className="grid" role="listbox" aria-multiselectable>
          {props.pages.map((page, i) => (
            <Thumb
              key={page.id}
              page={page}
              number={i + 1}
              doc={props.docs.get(page.docId)}
              showFile={multiDoc}
              watermark={props.watermark}
              selected={props.selection.has(page.id)}
              width={props.thumbWidth}
              onSelect={props.onSelect}
              onOpenEditor={props.onOpenEditor}
            />
          ))}
        </div>
      </SortableContext>
      <DragOverlay>
        {dragId && dragCount > 1 ? <div className="drag-count">{dragCount} pages</div> : null}
      </DragOverlay>
    </DndContext>
  );
}
