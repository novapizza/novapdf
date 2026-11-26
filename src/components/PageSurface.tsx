import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { errorMessage } from "../lib/api";
import { cssFamily, estimateBlockBox } from "../lib/fontCss";
import { loadPageText } from "../lib/pageText";
import type { RenderRequest } from "../lib/api";
import { cached, requestRender } from "../lib/renderCache";
import type { LooseText, NewAnnot, PageEdits, PageText, Paragraph, TextBlock, Watermark } from "../lib/types";
import { editsAreEmpty, viewEdits } from "../lib/types";
import type { PageItem } from "../state/workspace";
import { type AnnotActions, type AnnotRef, type AnnotStyle, AnnotationLayer, type ReadTool, type TextSel } from "./AnnotationLayer";
import { thumbRequest } from "./PageGrid";

/** Width of the filmstrip thumbnails, whose cached images double as placeholders. */
export const STRIP_W = 148;
/** Pages that mount further from the reader wait this long, so pages that fly past
 *  while scrolling never hit the worker. */
const RENDER_DELAY_MS = 90;

export type Selection =
  | { kind: "block"; id: string }
  | { kind: "para"; para: Paragraph }
  | { kind: "loose"; loose: LooseText };

export interface Editing {
  draft: TextBlock;
  /** Set when the draft replaces an original paragraph that is not yet removed. */
  paragraph: Paragraph | null;
  isNew: boolean;
  /** Lines the text uses vs. lines available before it reaches the content below. */
  budget?: { lines: number | null; capacity: number | null };
}

/** Callbacks from a page to the document view. The object is stable across renders. */
export interface SurfaceActions {
  select(pageId: string, sel: Selection | null): void;
  clickParagraph(pageId: string, para: Paragraph): void;
  editBlock(pageId: string, block: TextBlock): void;
  clickEmpty(pageId: string, pt: { x: number; y: number }): void;
  moveBlock(pageId: string, block: TextBlock, dx: number, dy: number): void;
  changeDraft(draft: TextBlock): void;
  finishEditing(cancel: boolean): void;
  /** Narrow the glyphs slightly so the edited text fits its line budget. */
  fitDraft(): void;
  error(message: string): void;
}

interface Props {
  page: PageItem;
  number: number;
  /** Page size in points as laid out (rotated in read mode). */
  width: number;
  height: number;
  top: number;
  left: number;
  scale: number;
  mode: "read" | "edit";
  tool: "select" | "text";
  watermark: Watermark | null;
  edits: PageEdits;
  selection: Selection | null;
  editing: Editing | null;
  /** Blocks on this page that belong to a linked paragraph. */
  linkedBlocks: ReadonlySet<string> | null;
  /** In "pick" mode this page holds the paragraph to link to. */
  pickTarget: boolean;
  /** Render order: 0 is the page the reader is on, then visible pages, then the rest.
   *  A page that mounts with rank 0 (a jump to it) renders without delay. */
  rank: number;
  /** Overlays are shown but do not respond (for example while a linked paragraph is edited). */
  locked: boolean;
  actions: SurfaceActions;
  /** Comments: tools and state for read view (edit mode only draws new comments, dimmed). */
  readTool: ReadTool;
  annotStyle: AnnotStyle;
  author: string;
  annotSelected: AnnotRef | null;
  noteDraft: NewAnnot | null;
  textSel: TextSel | null;
  annotActions: AnnotActions;
}

export const PageSurface = memo(function PageSurface(p: Props) {
  const { page, mode, edits, scale, actions } = p;
  const cssW = Math.round(p.width * scale);
  const cssH = Math.round(p.height * scale);
  const editMode = mode === "edit";
  const rotation = editMode ? 0 : page.rotation;

  // ---- page image (real PDFium output, with edits) ----
  // Comments made in the app are drawn by the overlay, so they are left out here:
  // adding or typing into one never re-renders the page.
  const shown = viewEdits(edits);
  const rank = useRef(p.rank);
  rank.current = p.rank;
  const renderWidth = Math.min(4000, Math.ceil((cssW * (window.devicePixelRatio || 1)) / 200) * 200);
  const viewRequest = (): RenderRequest => ({
    docId: page.docId,
    pageIndex: page.pageIndex,
    width: renderWidth,
    format: "png",
    rotation,
    edits: editsAreEmpty(shown) ? null : shown,
    watermark: p.watermark,
    priority: "view",
  });
  // A page rendered before (another tab, scrolling back) shows at once.
  const [imageUrl, setImageUrl] = useState<string | null>(() => cached(viewRequest()) ?? null);
  const [rendering, setRendering] = useState(imageUrl == null);
  // Until then, the filmstrip thumbnail (usually cached already) stands in, scaled up.
  const [placeholder] = useState(() =>
    imageUrl == null && (!editMode || page.rotation === 0)
      ? cached(thumbRequest(page, STRIP_W, p.watermark))
      : undefined,
  );
  const editsKey = JSON.stringify(shown);
  const wmKey = JSON.stringify(p.watermark);
  useEffect(() => {
    const req = viewRequest();
    const hit = cached(req);
    if (hit) {
      setImageUrl(hit);
      setRendering(false);
      return;
    }
    let alive = true;
    const ctrl = new AbortController();
    setRendering(true);
    const start = () =>
      requestRender(req, ctrl.signal, () => rank.current).then(
        (url) => {
          if (!alive) return;
          setImageUrl(url);
          setRendering(false);
        },
        (e) => {
          if (!alive) return;
          setRendering(false);
          actions.error(`Page ${p.number}: ${errorMessage(e)}`);
        },
      );
    const t = rank.current === 0 ? (start(), undefined) : setTimeout(start, RENDER_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(t);
      ctrl.abort(); // not started yet: drop it, the reader moved on
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.docId, page.pageIndex, renderWidth, rotation, editsKey, wmKey]);

  // ---- text (edit mode only) ----
  const [pageText, setPageText] = useState<PageText | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!editMode) return;
    let alive = true;
    setTextError(null);
    const start = () =>
      loadPageText(page.docId, page.pageIndex).then(
        (t) => alive && setPageText(t),
        (e) => alive && setTextError(errorMessage(e)),
      );
    // Same rule as the image: pages scrolled past never ask the worker for text.
    const t = rank.current === 0 ? (start(), undefined) : setTimeout(start, RENDER_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [editMode, page.docId, page.pageIndex, attempt]);

  const removed = useMemo(() => new Set(edits.removedObjects), [edits.removedObjects]);
  const paragraphs = useMemo(
    () => (pageText?.paragraphs ?? []).filter((x) => !x.objectIndices.some((i) => removed.has(i))),
    [pageText, removed],
  );
  const loose = useMemo(
    () => (pageText?.loose ?? []).filter((l) => !removed.has(l.objectIndex)),
    [pageText, removed],
  );

  // ---- block dragging ----
  const [drag, setDrag] = useState<{ id: string; x0: number; y0: number; dx: number; dy: number } | null>(null);

  const toPage = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).closest(".page-surface")!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const px = (n: number) => `${n * scale}px`;
  const sel = p.selection;
  const interactive = editMode && !p.locked;
  const showParas = editMode && (p.tool === "select" || p.pickTarget);

  return (
    <div
      className={`page-surface${editMode ? ` tool-${p.tool}` : ""}${p.pickTarget ? " pick-target" : ""}`}
      style={{ top: p.top, left: p.left, width: cssW, height: cssH }}
      data-page={p.number}
      onClick={(e) => {
        if (!editMode) return p.annotActions.select(page.id, null);
        if (!interactive || p.editing) return;
        actions.clickEmpty(page.id, toPage(e));
      }}
    >
      {imageUrl ? (
        <img className="page-image" src={imageUrl} alt={`Page ${p.number}`} draggable={false} />
      ) : (
        placeholder && <img className="page-image placeholder" src={placeholder} alt="" draggable={false} />
      )}
      {rendering && <span className="spinner page-spinner" aria-label="Rendering" />}

      <AnnotationLayer
        page={page}
        width={rotation % 180 ? p.height : p.width}
        height={rotation % 180 ? p.width : p.height}
        scale={scale}
        rotation={rotation}
        edits={edits}
        interactive={!editMode}
        tool={p.readTool}
        style={p.annotStyle}
        author={p.author}
        selected={p.annotSelected}
        draft={p.noteDraft}
        textSel={p.textSel}
        rank={p.rank}
        actions={p.annotActions}
      />

      {showParas &&
        paragraphs.map((para) => (
          <div
            key={`p${para.id}`}
            className={`ov ov-para${sel?.kind === "para" && sel.para.id === para.id ? " selected" : ""}`}
            style={{
              left: px(para.bounds.x),
              top: px(para.bounds.y),
              width: px(para.bounds.width),
              height: px(para.bounds.height),
              pointerEvents: interactive || p.pickTarget ? "auto" : "none",
            }}
            title={
              p.pickTarget
                ? "Link to this paragraph"
                : para.mixedStyles
                  ? "Mixed formatting: editing will use one style"
                  : "Click to edit"
            }
            onClick={(e) => {
              e.stopPropagation();
              actions.clickParagraph(page.id, para);
            }}
          />
        ))}

      {editMode &&
        p.tool === "select" &&
        !p.pickTarget &&
        loose.map((l) => (
          <div
            key={`l${l.objectIndex}`}
            className={`ov ov-loose${sel?.kind === "loose" && sel.loose.objectIndex === l.objectIndex ? " selected" : ""}`}
            style={{
              left: px(l.bounds.x),
              top: px(l.bounds.y),
              width: px(l.bounds.width),
              height: px(l.bounds.height),
              pointerEvents: interactive ? "auto" : "none",
            }}
            title={l.watermarkMark ? "Watermark" : "Text object"}
            onClick={(e) => {
              e.stopPropagation();
              actions.select(page.id, { kind: "loose", loose: l });
            }}
          />
        ))}

      {editMode &&
        edits.blocks.map((b) => {
          if (p.editing && p.editing.draft.id === b.id) return null;
          const box = estimateBlockBox(b);
          const moving = drag?.id === b.id;
          const linked = p.linkedBlocks?.has(b.id) ?? false;
          return (
            <div
              key={b.id}
              className={`ov ov-block${linked ? " linked" : ""}${sel?.kind === "block" && sel.id === b.id ? " selected" : ""}`}
              style={{
                left: px(box.x),
                top: px(box.y),
                width: px(box.width),
                height: px(box.height),
                transform: moving ? `translate(${drag!.dx}px, ${drag!.dy}px)` : undefined,
                pointerEvents: interactive && p.tool === "select" ? "auto" : "none",
              }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                actions.select(page.id, { kind: "block", id: b.id });
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                setDrag({ id: b.id, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 });
              }}
              onPointerMove={(e) => drag && setDrag({ ...drag, dx: e.clientX - drag.x0, dy: e.clientY - drag.y0 })}
              onPointerUp={() => {
                if (!drag) return;
                const { dx, dy } = drag;
                setDrag(null);
                if (Math.hypot(dx, dy) > 2) actions.moveBlock(page.id, b, dx / scale, dy / scale);
              }}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                actions.editBlock(page.id, b);
              }}
              title={linked ? "Linked paragraph: double-click to edit across pages" : "Drag to move, double-click to edit"}
            />
          );
        })}

      {p.editing && (
        <InlineEditor
          editing={p.editing}
          scale={scale}
          onChange={actions.changeDraft}
          onCommit={() => actions.finishEditing(false)}
          onCancel={() => actions.finishEditing(true)}
          onFit={actions.fitDraft}
        />
      )}

      {editMode && textError && (
        <div className="notice error page-notice" onClick={(e) => e.stopPropagation()}>
          Text could not be read on this page: {textError}{" "}
          <button onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </div>
      )}
      {editMode && page.rotation !== 0 && (
        <span className="page-badge" title="Edit mode shows pages unrotated">
          Shown unrotated · {page.rotation}° on save
        </span>
      )}
    </div>
  );
});

function InlineEditor(props: {
  editing: Editing;
  scale: number;
  onChange: (b: TextBlock) => void;
  onCommit: () => void;
  onCancel: () => void;
  onFit: () => void;
}) {
  const { draft, budget } = props.editing;
  const ref = useRef<HTMLTextAreaElement>(null);
  const box = estimateBlockBox(draft);
  const s = props.scale;
  const hs = draft.hScale ?? 1;
  const cssWidth =
    draft.width != null ? draft.width * s + 6 : Math.max(box.width + draft.size * 2, 120 / s) * s + 6;
  const over = budget?.lines != null && budget.capacity != null ? budget.lines - budget.capacity : 0;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  });

  return (
    <div className="inline-wrap" style={{ left: box.x * s - 3, top: box.y * s - 3, width: cssWidth }}>
    <textarea
      ref={ref}
      className="inline-editor"
      value={draft.text}
      spellCheck
      onChange={(e) => props.onChange({ ...draft, text: e.target.value })}
      onBlur={props.onCommit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          props.onCancel();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          props.onCommit();
        }
        e.stopPropagation();
      }}
      style={{
        // Narrowed glyphs are shown by scaling the editor horizontally.
        width: cssWidth / hs,
        transform: hs !== 1 ? `scaleX(${hs})` : undefined,
        textIndent: (draft.indent ?? 0) * s / hs,
        textAlignLast: draft.align === "justify" && draft.continues ? "justify" : undefined,
        fontFamily: cssFamily(draft.font.family),
        fontWeight: draft.font.bold ? 700 : 400,
        fontStyle: draft.font.italic ? "italic" : "normal",
        fontSize: draft.size * s,
        lineHeight: draft.lineHeight,
        color: `rgb(${draft.color.join(",")})`,
        textAlign: draft.align,
        whiteSpace: draft.width == null ? "pre" : "pre-wrap",
      }}
    />
      {budget?.capacity != null && budget.lines != null && (
        <div
          className={`line-budget${over > 0 ? " over" : ""}`}
          // Keep focus in the editor when using these controls.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => e.stopPropagation()}
        >
          {over > 0 ? (
            <>
              <span>
                {budget.lines} / {budget.capacity} lines · {over} line{over === 1 ? "" : "s"} will overlap the text below
              </span>
              <button onClick={props.onFit} title="Narrow the letters slightly so the text fits">
                Tighten to fit
              </button>
            </>
          ) : (
            <span>
              {budget.lines} / {budget.capacity} lines
            </span>
          )}
        </div>
      )}
    </div>
  );
}
