import { useEffect, useMemo, useRef, useState } from "react";

import {
  NOTE_SIZE,
  TEXT_MARKUP,
  annotBounds,
  formatAnnotDate,
  hasComment,
  isNote,
  kindLabel,
  loadPageAnnots,
  repliesTo,
  visibleAnnots,
} from "../lib/annotations";
import { errorMessage } from "../lib/api";
import {
  type PageChars,
  boxToRotated,
  charAt,
  loadTextChars,
  rotationTransform,
  selectionRects,
  selectionText,
  toUnrotated,
} from "../lib/textSelect";
import type { AnnotInfo, NewAnnot, PageEdits, Point, RGB, Rect, Rotation } from "../lib/types";
import type { PageItem } from "../state/workspace";
import { Icon, type IconName } from "./Icon";

export type ReadTool = "hand" | "select" | "highlight" | "note" | "ink";

export interface AnnotStyle {
  highlight: RGB;
  note: RGB;
  ink: RGB;
  /** Ink draws as a wide, see-through marker instead of a pen. */
  marker: boolean;
}

/** A comment on a page: one already in the file (by index) or one made in the app. */
export type AnnotRef = { kind: "file"; index: number } | { kind: "new"; id: string };

export const sameRef = (a: AnnotRef | null, b: AnnotRef | null) =>
  !!a && !!b && (a.kind === "file" ? b.kind === "file" && a.index === b.index : b.kind === "new" && a.id === b.id);

export interface TextSel {
  a: number;
  b: number;
  rects: Rect[];
  text: string;
}

/** Callbacks from a page's comment layer to the document view. Stable across renders. */
export interface AnnotActions {
  select(pageId: string, ref: AnnotRef | null): void;
  /** Adds a comment made with a tool; `select` opens its card. */
  add(pageId: string, annot: NewAnnot, select: boolean): void;
  /** Starts a new note at `at` (its card opens to type into). */
  placeNote(pageId: string, at: Point): void;
  selectText(pageId: string, sel: TextSel | null): void;
  /** Saves the text typed into a comment's card. */
  commitText(pageId: string, ref: AnnotRef, text: string): void;
  /** Adds the new note `draft` with the text typed into it; an empty note is dropped. */
  commitDraft(pageId: string, draft: NewAnnot, text: string): void;
  /** Closes the card without saving (drops an unsaved new note). */
  cancel(): void;
  /** Closes whatever is open (a card, a new note, a text selection); an open card saves
   *  what was typed as it closes. True when something was open. */
  dismiss(): boolean;
  remove(pageId: string, ref: AnnotRef): void;
  /** Moves a note so its top-left corner is at `at` (display space). */
  move(pageId: string, ref: AnnotRef, at: Point): void;
  highlightSelection(): void;
  copySelection(): void;
  error(message: string): void;
}

export const READ_TOOLS: { key: ReadTool; label: string; icon: IconName; title: string; gold?: boolean }[] = [
  { key: "hand", label: "Hand", icon: "hand", title: "Scroll, read and open comments (Esc)" },
  { key: "select", label: "Select", icon: "pointer", title: "Select text to copy or highlight" },
  { key: "highlight", label: "Highlight", icon: "highlighter", title: "Drag over text to highlight it", gold: true },
  { key: "note", label: "Note", icon: "note", title: "Click to add a sticky note", gold: true },
  { key: "ink", label: "Ink", icon: "ink", title: "Draw freehand with a pen or a marker", gold: true },
];

export const SWATCHES: { name: string; rgb: RGB }[] = [
  { name: "Yellow", rgb: [255, 235, 59] },
  { name: "Green", rgb: [165, 214, 167] },
  { name: "Blue", rgb: [144, 202, 249] },
  { name: "Pink", rgb: [244, 143, 177] },
  { name: "Red", rgb: [229, 57, 53] },
  { name: "Black", rgb: [33, 33, 33] },
];

export const DEFAULT_ANNOT_STYLE: AnnotStyle = {
  highlight: [255, 235, 59],
  note: [255, 235, 59],
  ink: [229, 57, 53],
  marker: false,
};

/** Which colour of the style a tool uses (the marker draws in the highlight colour). */
export function styleSlot(tool: ReadTool, marker: boolean): "highlight" | "note" | "ink" {
  if (tool === "note") return "note";
  if (tool === "ink" && !marker) return "ink";
  return "highlight";
}

export const MARKER_WIDTH = 12;
export const MARKER_OPACITY = 0.4;
export const PEN_WIDTH = 2;
const DELAY_MS = 90;
const CARD_W = 260;
/** Most points kept per ink stroke (validation allows more over all strokes). */
const MAX_STROKE_POINTS = 5000;

interface Props {
  page: PageItem;
  /** Unrotated page size in points. */
  width: number;
  height: number;
  scale: number;
  rotation: Rotation;
  edits: PageEdits;
  /** Read view: tools, click targets and the card. Edit mode only shows new comments, dimmed. */
  interactive: boolean;
  tool: ReadTool;
  style: AnnotStyle;
  author: string;
  selected: AnnotRef | null;
  /** A new note being written on this page. */
  draft: NewAnnot | null;
  textSel: TextSel | null;
  rank: number;
  actions: AnnotActions;
}

const rgb = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

type Gesture = { kind: "ink"; points: Point[] } | { kind: "text"; a: number; b: number; moved: boolean };

/** A note being dragged: where it started, where the pointer went down, where it is now. */
interface Drag {
  ref: AnnotRef;
  origin: Point;
  start: Point;
  at: Point;
  moved: boolean;
}

/** Pointer travel, in points, before a press on a note becomes a drag. */
const DRAG_START = 3;

export function AnnotationLayer(p: Props) {
  const { page, width, height, scale, rotation, edits, interactive, tool, actions } = p;
  const W = width * scale;
  const H = height * scale;
  const rank = useRef(p.rank);
  rank.current = p.rank;

  // ---- comments already in the file (read view only) ----
  const [fileList, setFileList] = useState<AnnotInfo[] | null>(null);
  useEffect(() => {
    if (!interactive) return;
    let alive = true;
    const start = () =>
      loadPageAnnots(page.docId, page.pageIndex).then(
        (r) => alive && setFileList(r.annots),
        (e) => alive && actions.error(`Comments on page ${page.pageIndex + 1}: ${errorMessage(e)}`),
      );
    const t = rank.current === 0 ? (start(), undefined) : setTimeout(start, DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [interactive, page.docId, page.pageIndex, actions]);
  const fileAnnots = useMemo(() => visibleAnnots(fileList ?? [], edits), [fileList, edits]);

  // ---- characters, only while a text tool is in use ----
  const wantsText = interactive && (tool === "select" || tool === "highlight");
  const [chars, setChars] = useState<PageChars | null>(null);
  useEffect(() => {
    if (!wantsText) return;
    let alive = true;
    const start = () =>
      loadTextChars(page.docId, page.pageIndex).then(
        (c) => alive && setChars(c),
        (e) => alive && actions.error(`Text on page ${page.pageIndex + 1}: ${errorMessage(e)}`),
      );
    const t = rank.current === 0 ? (start(), undefined) : setTimeout(start, DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [wantsText, page.docId, page.pageIndex, actions]);

  // ---- tools ----
  const [gesture, setGesture] = useState<Gesture | null>(null);
  /** Pointer position on the page, in unrotated display space, kept on the page. */
  const toPoint = (e: React.PointerEvent): Point => {
    const el = (e.currentTarget as Element).closest(".page-surface") ?? (e.currentTarget as Element);
    const r = el.getBoundingClientRect();
    const pt = toUnrotated((e.clientX - r.left) / scale, (e.clientY - r.top) / scale, rotation, width, height);
    const keep = (v: number, max: number) => Math.round(Math.min(Math.max(0, v), max) * 100) / 100;
    return { x: keep(pt.x, width), y: keep(pt.y, height) };
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // No mouse-down default: it would move focus to the scroll area (blurring, and so
    // dropping, a note just placed) and start a native text selection while dragging.
    e.preventDefault();
    const pt = toPoint(e);
    if (tool === "note") {
      // A click while a card is open only closes it: the next click adds a note.
      if (actions.dismiss()) return;
      const x = Math.min(Math.max(0, pt.x - NOTE_SIZE / 2), width - NOTE_SIZE);
      const y = Math.min(Math.max(0, pt.y - NOTE_SIZE / 2), height - NOTE_SIZE);
      actions.placeNote(page.id, { x, y });
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    if (tool === "ink") {
      actions.dismiss();
      setGesture({ kind: "ink", points: [pt] });
      return;
    }
    const at = chars ? charAt(chars, pt.x, pt.y) : null;
    if (at == null) {
      actions.dismiss();
      return;
    }
    setGesture({ kind: "text", a: at, b: at, moved: false });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!gesture) return;
    const pt = toPoint(e);
    if (gesture.kind === "ink") {
      const last = gesture.points[gesture.points.length - 1];
      if (gesture.points.length >= MAX_STROKE_POINTS || Math.hypot(pt.x - last.x, pt.y - last.y) < 0.75) return;
      setGesture({ kind: "ink", points: [...gesture.points, pt] });
    } else if (chars) {
      const b = charAt(chars, pt.x, pt.y);
      if (b != null && b !== gesture.b) setGesture({ ...gesture, b, moved: true });
    }
  };

  const onUp = () => {
    const g = gesture;
    setGesture(null);
    if (!g) return;
    if (g.kind === "ink") {
      const points = g.points.length === 1 ? [g.points[0], { ...g.points[0], x: g.points[0].x + 0.5 }] : g.points;
      const marker = p.style.marker;
      actions.add(
        page.id,
        {
          id: "",
          kind: "ink",
          strokes: [points],
          width: marker ? MARKER_WIDTH : PEN_WIDTH,
          opacity: marker ? MARKER_OPACITY : 1,
          color: marker ? p.style.highlight : p.style.ink,
          contents: "",
          author: p.author,
          date: "",
        },
        false,
      );
      return;
    }
    if (!chars) return;
    // A click without a drag selects nothing: it closes what is open.
    if (!g.moved) {
      actions.dismiss();
      return;
    }
    const rects = selectionRects(chars, g.a, g.b);
    if (tool === "highlight") {
      if (rects.length === 0) return;
      actions.add(
        page.id,
        { id: "", kind: "highlight", rects, opacity: 1, color: p.style.highlight, contents: "", author: p.author, date: "" },
        true,
      );
    } else {
      actions.selectText(page.id, { a: g.a, b: g.b, rects, text: selectionText(chars, g.a, g.b) });
    }
  };

  // ---- drawing ----
  const box = { width: W, height: H, transform: rotationTransform(rotation, W, H) };
  const vb = `0 0 ${width} ${height}`;
  const fresh = edits.annotations ?? [];
  const liveRects = gesture?.kind === "text" && chars ? selectionRects(chars, gesture.a, gesture.b) : [];
  const liveInk = gesture?.kind === "ink" ? gesture.points : null;
  const hand = interactive && tool === "hand";
  // Click targets: every comment with the Hand; notes with the Note tool too, so a
  // note can be opened, edited and moved without switching tools.
  const picks = (note: boolean) => hand || (interactive && tool === "note" && note);

  // ---- dragging notes ----
  const [drag, setDrag] = useState<Drag | null>(null);
  const pressNote = (ref: AnnotRef, origin: Point) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const start = toPoint(e);
    setDrag({ ref, origin, start, at: origin, moved: false });
  };
  const dragNote = (e: React.PointerEvent) => {
    if (!drag) return;
    const pt = toPoint(e);
    const dx = pt.x - drag.start.x;
    const dy = pt.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_START) return;
    setDrag({ ...drag, moved: true, at: { x: drag.origin.x + dx, y: drag.origin.y + dy } });
  };
  const dropNote = (e: React.PointerEvent) => {
    const d = drag;
    setDrag(null);
    if (!d) return;
    e.stopPropagation();
    if (d.moved) actions.move(page.id, d.ref, d.at);
    else actions.select(page.id, d.ref);
  };
  const noteHandlers = (ref: AnnotRef, origin: Point) => ({
    onPointerDown: pressNote(ref, origin),
    onPointerMove: dragNote,
    onPointerUp: dropNote,
    onPointerCancel: () => setDrag(null),
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  });
  const dragAt = (ref: AnnotRef) => (drag?.moved && sameRef(drag.ref, ref) ? drag.at : null);

  /** Click and keyboard handlers for a comment that is not dragged. */
  const pickHandlers = (ref: AnnotRef) => ({
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      actions.select(page.id, ref);
    },
  });
  /** Tab reaches every click target; Enter or Space opens it. */
  const keyHandlers = (ref: AnnotRef) => ({
    tabIndex: 0,
    role: "button",
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      actions.select(page.id, ref);
    },
  });
  // Markup that blends with the page (highlights and marker strokes) goes in a
  // multiply layer; everything else is drawn normally on top.
  const blends = (a: NewAnnot) => a.kind === "highlight" || (a.kind === "ink" && a.opacity < 1);
  const movedFile = new Set((edits.changedAnnots ?? []).filter((c) => c.at).map((c) => c.index));
  // Highlights that carry a comment get a small badge at their top-right corner as
  // seen on screen.
  const topRight = (box: Rect): Point => {
    const s = boxToRotated(box, rotation, width, height);
    return toUnrotated(s.x + s.width, s.y, rotation, width, height);
  };
  const badges = [
    ...fresh.filter((a) => a.kind === "highlight" && hasComment(a)).map((a) => ({ key: `b-${a.id}`, box: annotBounds(a) })),
    ...fileAnnots
      .filter((a) => a.inReplyTo == null && TEXT_MARKUP.has(a.subtype) && hasComment(a, fileAnnots))
      .map((a) => ({ key: `bf${a.index}`, box: a.rect })),
  ].map((b) => ({ key: b.key, at: topRight(b.box) }));

  const selectedNew = p.selected?.kind === "new" ? fresh.find((a) => a.id === (p.selected as { id: string }).id) : undefined;
  const selectedFile =
    p.selected?.kind === "file" ? fileAnnots.find((a) => a.index === (p.selected as { index: number }).index) : undefined;
  // Page size as shown (turned), for placing the card inside it.
  const shown = rotation % 180 ? { width: height, height: width } : { width, height };
  const outline = p.draft ? annotBounds(p.draft) : selectedNew ? annotBounds(selectedNew) : selectedFile?.rect;

  return (
    <>
      {interactive && tool !== "hand" && (
        <div
          className={`annot-capture tool-${tool}`}
          data-testid="annot-capture"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => setGesture(null)}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <div className={`annot-layer blend${interactive ? "" : " dim"}`} style={box} aria-hidden>
        <svg viewBox={vb} width={W} height={H}>
          {fresh.filter(blends).map((a) => (
            <Shape key={a.id} a={a} />
          ))}
          {liveRects.map((r, i) => (
            <rect
              key={i}
              x={r.x}
              y={r.y}
              width={r.width}
              height={r.height}
              fill={tool === "highlight" ? rgb(p.style.highlight) : "rgb(160,200,255)"}
            />
          ))}
          {p.textSel?.rects.map((r, i) => (
            <rect key={`s${i}`} className="text-sel" x={r.x} y={r.y} width={r.width} height={r.height} />
          ))}
          {liveInk && p.style.marker && (
            <Stroke points={liveInk} color={p.style.highlight} width={MARKER_WIDTH} opacity={MARKER_OPACITY} />
          )}
        </svg>
      </div>
      <div className={`annot-layer${interactive ? "" : " dim"}`} style={box}>
        <svg viewBox={vb} width={W} height={H}>
          {fresh
            .filter((a) => !blends(a))
            .map((a) => {
              const at = dragAt({ kind: "new", id: a.id });
              return <Shape key={a.id} a={at && a.kind === "note" ? { ...a, ...at } : a} rotation={rotation} />;
            })}
          {/* Notes in the file that were moved: the page render leaves them out
              (`viewEdits`), so they are drawn here, where they are now. */}
          {fileAnnots.filter(isNote).map((a) => {
            const ref: AnnotRef = { kind: "file", index: a.index };
            const at = dragAt(ref) ?? (movedFile.has(a.index) ? a.rect : null);
            return at ? <Shape key={`f${a.index}`} a={fileNoteShape(a, at)} rotation={rotation} /> : null;
          })}
          {p.draft && <Shape a={p.draft} rotation={rotation} />}
          {liveInk && !p.style.marker && <Stroke points={liveInk} color={p.style.ink} width={PEN_WIDTH} opacity={1} />}
          {badges.map((b) => (
            <Badge key={b.key} at={b.at} rotation={rotation} />
          ))}
          {fresh.map((a) => {
            const ref: AnnotRef = { kind: "new", id: a.id };
            const note = a.kind === "note";
            if (!picks(note)) return null;
            const b = annotBounds(note ? { ...a, ...(dragAt(ref) ?? {}) } : a);
            return (
              <rect
                key={`hit-${a.id}`}
                className={`annot-hit${note ? " movable" : ""}`}
                data-testid={`annot-${a.id}`}
                aria-label={`${kindLabel(a.kind)}${a.contents ? `: ${a.contents.slice(0, 80)}` : ""}`}
                x={b.x}
                y={b.y}
                width={b.width}
                height={b.height}
                {...keyHandlers(ref)}
                {...(note ? noteHandlers(ref, { x: a.x, y: a.y }) : pickHandlers(ref))}
              >
                <title>{a.contents || kindLabel(a.kind)}</title>
              </rect>
            );
          })}
          {outline && interactive && (
            <rect
              className="annot-outline"
              x={outline.x - 2}
              y={outline.y - 2}
              width={outline.width + 4}
              height={outline.height + 4}
            />
          )}
        </svg>
        {fileAnnots
          .filter((a) => a.inReplyTo == null && picks(isNote(a)))
          .map((a) => {
            const ref: AnnotRef = { kind: "file", index: a.index };
            const note = isNote(a);
            const r = { ...a.rect, ...(dragAt(ref) ?? {}) };
            return (
              <div
                key={`f${a.index}`}
                className={`annot-hit file${note ? " movable" : ""}`}
                data-testid={`file-annot-${a.index}`}
                aria-label={`${kindLabel(a.subtype)}${a.contents ? `: ${a.contents.slice(0, 80)}` : ""}`}
                style={{ left: r.x * scale, top: r.y * scale, width: r.width * scale, height: r.height * scale }}
                title={a.contents || kindLabel(a.subtype)}
                {...keyHandlers(ref)}
                {...(note ? noteHandlers(ref, { x: a.rect.x, y: a.rect.y }) : pickHandlers(ref))}
              />
            );
          })}
      </div>

      {interactive && p.draft && (
        <AnnotCard
          key={`draft-${p.draft.id}`}
          anchor={boxToRotated(annotBounds(p.draft), rotation, width, height)}
          scale={scale}
          shown={shown}
          title="New note"
          author={p.author}
          date=""
          text=""
          editable
          draft
          replies={[]}
          onCommit={(text) => actions.commitDraft(page.id, p.draft!, text)}
          onClose={actions.cancel}
          onDelete={actions.cancel}
        />
      )}
      {interactive && !p.draft && selectedNew && (
        <AnnotCard
          key={`new-${selectedNew.id}`}
          anchor={boxToRotated(annotBounds(selectedNew), rotation, width, height)}
          scale={scale}
          shown={shown}
          title={kindLabel(selectedNew.kind)}
          author={selectedNew.author}
          date={formatAnnotDate(selectedNew.date)}
          text={selectedNew.contents}
          editable
          draft={false}
          replies={[]}
          onCommit={(text) => actions.commitText(page.id, { kind: "new", id: selectedNew.id }, text)}
          onClose={actions.cancel}
          onDelete={() => actions.remove(page.id, { kind: "new", id: selectedNew.id })}
        />
      )}
      {interactive && !p.draft && selectedFile && (
        <AnnotCard
          key={`file-${selectedFile.index}`}
          anchor={boxToRotated(selectedFile.rect, rotation, width, height)}
          scale={scale}
          shown={shown}
          title={kindLabel(selectedFile.subtype)}
          author={selectedFile.author}
          date={formatAnnotDate(selectedFile.date)}
          text={selectedFile.contents}
          editable={!selectedFile.truncated}
          draft={false}
          replies={repliesTo(fileAnnots, selectedFile.index)}
          onCommit={(text) => actions.commitText(page.id, { kind: "file", index: selectedFile.index }, text)}
          onClose={actions.cancel}
          onDelete={() => actions.remove(page.id, { kind: "file", index: selectedFile.index })}
        />
      )}
      {interactive && p.textSel && p.textSel.rects.length > 0 && (
        <SelectionBar
          anchor={boxToRotated(p.textSel.rects[p.textSel.rects.length - 1], rotation, width, height)}
          scale={scale}
          pageW={(rotation % 180 ? height : width) * scale}
          pageH={(rotation % 180 ? width : height) * scale}
          onCopy={actions.copySelection}
          onHighlight={actions.highlightSelection}
        />
      )}
    </>
  );
}

function Stroke(props: { points: Point[]; color: RGB; width: number; opacity: number }) {
  return (
    <polyline
      points={props.points.map((q) => `${q.x},${q.y}`).join(" ")}
      fill="none"
      stroke={rgb(props.color)}
      strokeWidth={props.width}
      strokeOpacity={props.opacity}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

/** A comment made in the app, drawn the way PDFium will draw it in the saved file. */
function Shape(props: { a: NewAnnot; rotation?: Rotation }) {
  const a = props.a;
  if (a.kind === "highlight") {
    return (
      <g data-kind="highlight" fill={rgb(a.color)} fillOpacity={a.opacity}>
        {a.rects.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.width} height={r.height} />
        ))}
      </g>
    );
  }
  if (a.kind === "ink") {
    return (
      <g data-kind="ink">
        {a.strokes.map((s, i) => (
          <Stroke key={i} points={s} color={a.color} width={a.width} opacity={a.opacity} />
        ))}
      </g>
    );
  }
  // Notes keep their icon upright on a turned page (they are written with NoRotate).
  const c = NOTE_SIZE / 2;
  return (
    <g data-kind="note" transform={`translate(${a.x} ${a.y}) rotate(${-(props.rotation ?? 0)} ${c} ${c})`}>
      {/* A speech bubble, like the icon PDFium draws for the saved note. */}
      <path d="M1.5 2h17v12H9l-4.5 4v-4h-3z" fill={rgb(a.color)} stroke="rgba(0,0,0,0.7)" strokeWidth={0.9} strokeLinejoin="round" />
      <path d="M5 5.5h10M5 8h10M5 10.5h10" stroke="rgba(0,0,0,0.7)" strokeWidth={0.9} />
    </g>
  );
}

/** A note in the file, drawn by the overlay at `at` (while dragged, or once moved). */
function fileNoteShape(a: AnnotInfo, at: Point): NewAnnot {
  return {
    id: `file-${a.index}`,
    kind: "note",
    x: at.x,
    y: at.y,
    color: a.color ?? DEFAULT_ANNOT_STYLE.note,
    opacity: 1,
    contents: "",
    author: "",
    date: "",
  };
}

/** Size of the "has a comment" badge on highlights, in points. */
const BADGE = 10;

/** A small speech bubble centred on `at`, kept upright on a turned page. */
function Badge(props: { at: Point; rotation: Rotation }) {
  const c = BADGE / 2;
  return (
    <g
      className="annot-badge"
      data-kind="badge"
      transform={`translate(${props.at.x - c} ${props.at.y - c}) rotate(${-props.rotation} ${c} ${c})`}
    >
      <path d="M0.75 1h8.5v6H4.5L2.25 9V7H0.75z" />
      <path d="M2.5 3h5M2.5 5h5" className="lines" />
    </g>
  );
}

/** Room kept below a card's top edge, so it is not cut off at the bottom of the page. */
const CARD_ROOM = 200;

/** Places a floating box next to `anchor` (points on the page as shown), inside the page
 *  (the page clips what is outside it). */
export function placeBeside(anchor: Rect, scale: number, page: { width: number; height: number }, w: number) {
  const right = (anchor.x + anchor.width) * scale + 8;
  const left = right + w > page.width * scale ? Math.max(4, anchor.x * scale - w - 8) : right;
  const top = Math.max(4, Math.min(anchor.y * scale, page.height * scale - CARD_ROOM));
  return { left, top };
}

function AnnotCard(props: {
  anchor: Rect;
  scale: number;
  shown: { width: number; height: number };
  title: string;
  author: string;
  date: string;
  text: string;
  editable: boolean;
  /** A new note: focused at once, and always saved on close (an empty one is dropped). */
  draft: boolean;
  replies: AnnotInfo[];
  onCommit: (text: string) => void;
  /** Closes the card (Save, Cancel, Esc). */
  onClose: () => void;
  onDelete: () => void;
}) {
  const [text, setText] = useState(props.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Esc closes without saving; the blur that follows must not save either.
  const cancelled = useRef(false);
  // Text as last saved, and as typed: a card that closes without a blur (switching
  // mode, closing the tab) still saves what was typed.
  const saved = useRef<string | null>(props.draft ? null : props.text);
  const typed = useRef(text);
  typed.current = text;
  const onCommit = useRef(props.onCommit);
  onCommit.current = props.onCommit;
  const commit = () => {
    if (cancelled.current || typed.current === saved.current) return;
    saved.current = typed.current;
    onCommit.current(typed.current);
  };
  const save = () => {
    commit();
    props.onClose();
  };
  const cancel = () => {
    cancelled.current = true;
    props.onClose();
  };
  useEffect(() => {
    if (props.draft) ref.current?.focus({ preventScroll: true });
  }, [props.draft]);
  // Save on close a moment later, and only if the card is really gone: React's
  // StrictMode unmounts and remounts every effect once in development, and saving then
  // would drop a new note before anything was typed into it.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current) commit();
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pos = placeBeside(props.anchor, props.scale, props.shown, CARD_W);
  return (
    <div
      className="annot-card"
      role="dialog"
      aria-label={props.title}
      style={{ ...pos, width: CARD_W }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="annot-card-head">
        <strong>{props.title}</strong>
        <span className="annot-meta">{[props.author, props.date].filter(Boolean).join(" · ")}</span>
        <button
          className="ghost icon-btn"
          title="Delete comment"
          aria-label="Delete comment"
          // Keep focus in the text box, so its blur does not save before deleting.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            cancelled.current = true;
            props.onDelete();
          }}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
      {props.editable ? (
        <textarea
          ref={ref}
          className="annot-text"
          value={text}
          placeholder="Add a comment…"
          aria-label="Comment text"
          maxLength={20_000}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              save();
            }
          }}
        />
      ) : (
        <div className="annot-text readonly">
          {props.text}
          <em> (too long to edit here)</em>
        </div>
      )}
      {props.editable && (
        <div className="annot-card-actions">
          <span className="hint">Ctrl+Enter</span>
          {/* Mouse-down keeps focus in the text box, so its blur does not save first. */}
          <button className="ghost" onMouseDown={(e) => e.preventDefault()} onClick={cancel}>
            Cancel
          </button>
          <button className="primary" onMouseDown={(e) => e.preventDefault()} onClick={save}>
            Save
          </button>
        </div>
      )}
      {props.replies.length > 0 && (
        <ul className="annot-replies" aria-label="Replies">
          {props.replies.map((r) => (
            <li key={r.index}>
              <span className="annot-meta">{[r.author, formatAnnotDate(r.date)].filter(Boolean).join(" · ")}</span>
              <span>{r.contents}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Rough size of the selection bar in CSS pixels, to keep it inside the page. */
const SEL_BAR_W = 190;
const SEL_BAR_H = 36;

function SelectionBar(props: {
  anchor: Rect;
  scale: number;
  /** Page size on screen, in CSS pixels. */
  pageW: number;
  pageH: number;
  onCopy: () => void;
  onHighlight: () => void;
}) {
  const a = props.anchor;
  const s = props.scale;
  // Below the end of the selection; above it when that would leave the page.
  const below = (a.y + a.height) * s + 6;
  const top = below + SEL_BAR_H > props.pageH ? Math.max(0, a.y * s - SEL_BAR_H - 6) : below;
  const left = Math.max(0, Math.min((a.x + a.width) * s - 4, props.pageW - SEL_BAR_W));
  return (
    <div
      className="text-sel-bar"
      role="toolbar"
      aria-label="Selected text"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button className="ghost" onClick={props.onCopy}>
        <Icon name="copy" size={14} /> Copy
      </button>
      <button className="ghost" onClick={props.onHighlight}>
        <Icon name="highlighter" size={14} /> Highlight
      </button>
    </div>
  );
}
