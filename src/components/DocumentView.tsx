import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { api, errorMessage } from "../lib/api";
import { estimateBlockBox } from "../lib/fontCss";
import {
  type Split,
  createLink,
  findLinkForBlock,
  linkUpdates,
  normalizeText,
  paragraphWidth,
  roomBelow,
  roomBelowBox,
  splitLink,
} from "../lib/links";
import { loadPageText } from "../lib/pageText";
import type { PageEdits, PageInfo, Paragraph, TextBlock, Watermark } from "../lib/types";
import { EMPTY_EDITS, editsAreEmpty } from "../lib/types";
import { type DocInfo, type PageItem, type ParagraphLink, displaySize } from "../state/workspace";
import { Inspector, LinkEditor } from "./Inspector";
import { Icon } from "./Icon";
import { type Editing, PageSurface, type Selection, type SurfaceActions } from "./PageSurface";
import { thumbRequest, useThumbnail, useVisible } from "./PageGrid";
import { EmptyNote } from "./Shell";

const PAD = 24;
const GAP = 16;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const round2 = (n: number) => Math.round(n * 100) / 100;
let blockCounter = 0;
const newBlockId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++blockCounter}`;

export interface DocumentViewProps {
  pages: PageItem[];
  docs: Map<number, DocInfo>;
  links: ParagraphLink[];
  watermark: Watermark | null;
  fonts: string[];
  mode: "read" | "edit";
  /** Page to show first. */
  initialPageId: string | null;
  onCurrentPage: (id: string) => void;
  onChangeEdits: (updates: { id: string; edits: PageEdits }[], links?: ParagraphLink[]) => void;
  onExitEdit: () => void;
  onRemoveEverywhere: (text: string, docId: number) => void;
  /** Opens the Watermark Studio. */
  onWatermark: () => void;
  notify: (message: string, kind?: "info" | "error") => void;
}

interface LinkDraft {
  link: ParagraphLink;
  isNew: boolean;
  text: string;
  split: Split | null;
  /** The text `split` was computed for. */
  splitFor: string | null;
  busy: boolean;
  error: string | null;
}

const FALLBACK_SIZE: PageInfo = { width: 612, height: 792 };

export function DocumentView(props: DocumentViewProps) {
  const { pages, docs, mode, links } = props;
  const editMode = mode === "edit";

  const scrollRef = useRef<HTMLDivElement>(null);
  const [vw, setVw] = useState(900);
  const [vh, setVh] = useState(700);
  const [scrollTop, setScrollTop] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<"select" | "text">("select");
  const [sel, setSel] = useState<{ pageId: string; sel: Selection } | null>(null);
  const [editing, setEditing] = useState<{ pageId: string; e: Editing } | null>(null);
  const [pick, setPick] = useState<{ fromPageId: string; para: Paragraph; dir: 1 | -1 } | null>(null);
  const [draft, setDraft] = useState<LinkDraft | null>(null);
  const [showStrip, setShowStrip] = useState(true);

  // ---------- geometry ----------

  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const measure = () => {
      setVw(el.clientWidth);
      setVh(el.clientHeight);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    el.focus({ preventScroll: true });
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    const sizes: PageInfo[] = new Array(pages.length);
    let maxW = 1;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const info = docs.get(p.docId)?.pages[p.pageIndex] ?? FALLBACK_SIZE;
      sizes[i] = editMode ? info : displaySize(info, p.rotation);
      if (sizes[i].width > maxW) maxW = sizes[i].width;
    }
    const scale = Math.max(0.05, ((vw - 2 * PAD) * zoom) / maxW);
    const tops: number[] = new Array(pages.length);
    const heights: number[] = new Array(pages.length);
    let y = PAD;
    for (let i = 0; i < pages.length; i++) {
      tops[i] = y;
      heights[i] = Math.round(sizes[i].height * scale);
      y += heights[i] + GAP;
    }
    const contentW = Math.max(vw, Math.round(maxW * scale) + 2 * PAD);
    return { sizes, scale, tops, heights, total: y - GAP + PAD, contentW };
  }, [pages, docs, editMode, vw, zoom]);

  const pageAt = (y: number) => pageAtIn(geo, y);
  const live = useRef({ geo, pages });
  live.current = { geo, pages };

  const indexById = useMemo(() => new Map(pages.map((p, i) => [p.id, i])), [pages]);
  const currentIndex = pages.length ? pageAt(scrollTop + vh * 0.3) : 0;

  // Keep the page under the top of the viewport in place when the layout changes
  // (zoom, window size, mode switch, pages added or removed).
  const anchor = useRef<{ id: string | null; index: number; frac: number }>({
    id: props.initialPageId,
    index: 0,
    frac: 0,
  });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || pages.length === 0) return;
    const a = anchor.current;
    let i = a.id != null ? indexById.get(a.id) ?? -1 : -1;
    if (i < 0) i = Math.min(a.index, pages.length - 1);
    const target = Math.max(0, geo.tops[i] + a.frac * geo.heights[i] - (a.frac === 0 ? PAD / 2 : 0));
    el.scrollTop = target;
    setScrollTop(el.scrollTop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo.scale, editMode, pages.length]);

  const scrollFrame = useRef(0);
  const onScroll = () => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const el = scrollRef.current;
      const { geo: g, pages: ps } = live.current;
      if (!el || ps.length === 0) return;
      const st = el.scrollTop;
      setScrollTop(st);
      const i = pageAtIn(g, st);
      anchor.current = { id: ps[i].id, index: i, frac: (st - g.tops[i]) / Math.max(1, g.heights[i]) };
    });
  };

  const scrollToIndex = (i: number, offset = PAD / 2) => {
    const el = scrollRef.current;
    if (!el || i < 0 || i >= pages.length) return;
    el.scrollTop = Math.max(0, geo.tops[i] - offset);
  };

  const onCurrentPage = props.onCurrentPage;
  const currentId = pages[currentIndex]?.id;
  useEffect(() => {
    if (currentId) onCurrentPage(currentId);
  }, [currentId, onCurrentPage]);

  // Ctrl + wheel zooms (needs a non-passive listener to stop the browser zoom).
  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, round2(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ---------- helpers ----------

  const pageById = (id: string) => {
    const i = indexById.get(id);
    return i == null ? undefined : pages[i];
  };
  const latest = useRef({ pages, links });
  latest.current = { pages, links };

  const setPageEdits = (pageId: string, edits: PageEdits) => props.onChangeEdits([{ id: pageId, edits }]);

  // ---------- inline editing ----------

  const startEditParagraph = (pageId: string, p: Paragraph) => {
    setSel({ pageId, sel: { kind: "para", para: p } });
    setEditing({
      pageId,
      e: {
        paragraph: p,
        isNew: true,
        draft: {
          id: newBlockId("para"),
          x: round2(p.bounds.x),
          baseline: round2(p.firstBaseline),
          width: p.wrap ? paragraphWidth(p) : null,
          text: p.text,
          font: p.font,
          size: round2(p.size),
          color: p.color,
          lineHeight: round2(p.lineHeight),
          align: p.align,
          indent: round2(p.indent ?? 0),
          hScale: p.hScale ?? 1,
        },
      },
    });
  };

  // ---------- line budget while editing ----------
  //
  // Lines the text may use before it runs into the content below: the lines it had,
  // plus any empty space under it. Shown under the editor so added text never
  // silently overlaps the next paragraph.

  const measureLines = (d: TextBlock) =>
    api
      .layoutText({
        text: normalizeText(d.text),
        font: d.font,
        size: d.size,
        width: d.width,
        indent: d.indent ?? 0,
        hScale: d.hScale ?? 1,
      })
      .then((r) => r.lineStarts.length);

  const editingId = editing ? `${editing.pageId}/${editing.e.draft.id}` : null;
  useEffect(() => {
    if (!editing) return;
    const { pageId, e } = editing;
    const page = pageById(pageId);
    if (!page || (e.isNew && !e.paragraph)) return; // a new text box has no budget
    let alive = true;
    (async () => {
      const text = await loadPageText(page.docId, page.pageIndex);
      const d = e.draft;
      const step = d.size * d.lineHeight;
      if (e.paragraph) return e.paragraph.lineCount + roomBelow(e.paragraph, text, page.edits, step, d.size);
      const lines = await measureLines(d);
      const box = estimateBlockBox(d);
      const lastBaseline = d.baseline + (lines - 1) * step;
      return (
        lines +
        roomBelowBox({ x: d.x, width: box.width, lastBaseline }, text, page.edits, step, d.size, {
          blocks: new Set([d.id]),
        })
      );
    })().then(
      (capacity) =>
        alive &&
        setEditing((cur) =>
          cur && `${cur.pageId}/${cur.e.draft.id}` === editingId
            ? { ...cur, e: { ...cur.e, budget: { lines: cur.e.budget?.lines ?? null, capacity } } }
            : cur,
        ),
      () => {},
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  const draftLayoutKey = editing ? layoutKey(editing.e.draft) : null;
  useEffect(() => {
    if (!editing || !draftLayoutKey) return;
    const d = editing.e.draft;
    let alive = true;
    const t = setTimeout(() => {
      measureLines(d).then(
        (lines) =>
          alive &&
          setEditing((cur) =>
            cur && cur.e.draft.id === d.id
              ? { ...cur, e: { ...cur.e, budget: { capacity: cur.e.budget?.capacity ?? null, lines } } }
              : cur,
          ),
        () => {},
      );
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftLayoutKey]);

  /** Narrows the glyphs slightly (down to 85%) so the text fits its line budget. */
  const fitDraft = async () => {
    const cur = editing;
    const capacity = cur?.e.budget?.capacity;
    if (!cur || capacity == null) return;
    const d = cur.e.draft;
    const MIN = 0.85;
    const fits = async (h: number) => (await measureLines({ ...d, hScale: h })) <= capacity;
    try {
      if (!(await fits(MIN))) {
        props.notify("Even with narrower letters this text is too long for the space. Shorten it, or let it overlap.", "error");
        return;
      }
      let lo = MIN;
      let hi = d.hScale ?? 1;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        if (await fits(mid)) lo = mid;
        else hi = mid;
      }
      const hScale = Math.floor(lo * 1000) / 1000;
      setEditing((c) => (c && c.e.draft.id === d.id ? { ...c, e: { ...c.e, draft: { ...c.e.draft, hScale } } } : c));
    } catch (e) {
      props.notify(errorMessage(e), "error");
    }
  };

  const startEditBlock = (pageId: string, b: TextBlock) => {
    const found = findLinkForBlock(links, b.id);
    if (found) return openDraft(found.link, false);
    setSel({ pageId, sel: { kind: "block", id: b.id } });
    setEditing({ pageId, e: { draft: { ...b }, paragraph: null, isNew: false } });
  };

  const finishEditing = (cancel: boolean) => {
    if (!editing) return;
    const { pageId, e } = editing;
    setEditing(null);
    const page = pageById(pageId);
    if (cancel || !page) return;
    const { draft: d, paragraph, isNew } = e;
    const edits = page.edits;
    const empty = d.text.trim() === "";
    if (paragraph) {
      if (d.text === paragraph.text) return; // unchanged: keep the original text
      setPageEdits(pageId, {
        ...edits,
        removedObjects: [...edits.removedObjects, ...paragraph.objectIndices],
        blocks: empty ? edits.blocks : [...edits.blocks, d],
      });
      setSel(empty ? null : { pageId, sel: { kind: "block", id: d.id } });
    } else if (isNew) {
      if (empty) return;
      setPageEdits(pageId, { ...edits, blocks: [...edits.blocks, d] });
      setSel({ pageId, sel: { kind: "block", id: d.id } });
    } else {
      setPageEdits(pageId, {
        ...edits,
        blocks: empty ? edits.blocks.filter((b) => b.id !== d.id) : edits.blocks.map((b) => (b.id === d.id ? d : b)),
      });
      if (empty) setSel(null);
    }
  };

  // ---------- block changes (Inspector, dragging) ----------

  function layoutKey(b: TextBlock) {
    return JSON.stringify([b.text, b.size, b.lineHeight, b.width, b.font, b.indent ?? 0, b.hScale ?? 1]);
  }


  const updateBlock = (pageId: string, block: TextBlock) => {
    const page = pageById(pageId);
    if (!page) return;
    const replaced: PageEdits = {
      ...page.edits,
      blocks: page.edits.blocks.map((x) => (x.id === block.id ? block : x)),
    };
    const found = findLinkForBlock(links, block.id);
    if (!found) return setPageEdits(pageId, replaced);

    const { link, side } = found;
    const old = page.edits.blocks.find((x) => x.id === block.id);
    const newSide = {
      ...link[side],
      x: block.x,
      baseline: block.baseline,
      width: block.width ?? link[side].width,
      indent: side === "a" ? block.indent ?? 0 : 0,
    };

    if (old && layoutKey(old) === layoutKey(block)) {
      // Position, colour or alignment: no re-flow needed, mirror onto the other half.
      const style = { ...link.style, color: block.color, align: block.align };
      const next: ParagraphLink = { ...link, style, [side]: newSide };
      const other = side === "a" ? next.b : next.a;
      const otherPage = pageById(other.pageId);
      const updates = [{ id: pageId, edits: replaced }];
      if (otherPage) {
        updates.push({
          id: otherPage.id,
          edits: {
            ...otherPage.edits,
            blocks: otherPage.edits.blocks.map((x) =>
              x.id === other.blockId ? { ...x, color: block.color, align: block.align } : x,
            ),
          },
        });
      }
      props.onChangeEdits(updates, links.map((l) => (l.id === link.id ? next : l)));
      return;
    }

    // Font, size, spacing or width changed: re-flow the whole paragraph.
    const style = {
      font: block.font,
      size: block.size,
      color: block.color,
      lineHeight: block.lineHeight,
      align: block.align,
      hScale: block.hScale ?? 1,
    };
    const next: ParagraphLink = { ...link, style, [side]: newSide };
    splitLink(next.text, style, next.a, next.b).then(
      (split) => {
        if (split.overflow > 0) {
          const pb = (indexById.get(next.b.pageId) ?? 0) + 1;
          props.notify(
            `That change does not fit: ${split.overflow} line${split.overflow === 1 ? "" : "s"} would run past the free space on page ${pb}.`,
            "error",
          );
          return;
        }
        const cur = latest.current;
        props.onChangeEdits(
          linkUpdates(cur.pages, next, split),
          cur.links.map((l) => (l.id === link.id ? next : l)),
        );
      },
      (e) => props.notify(errorMessage(e), "error"),
    );
  };

  const deleteSelection = () => {
    if (!sel) return;
    const page = pageById(sel.pageId);
    if (!page) return;
    const s = sel.sel;
    const edits = page.edits;
    if (s.kind === "block") {
      const found = findLinkForBlock(links, s.id);
      if (found) {
        // Deleting half a linked paragraph would leave the text inconsistent: remove both halves.
        const { link } = found;
        const updates = [link.a, link.b].flatMap((side) => {
          const pg = pageById(side.pageId);
          return pg ? [{ id: pg.id, edits: { ...pg.edits, blocks: pg.edits.blocks.filter((b) => b.id !== side.blockId) } }] : [];
        });
        props.onChangeEdits(updates, links.filter((l) => l.id !== link.id));
      } else {
        setPageEdits(page.id, { ...edits, blocks: edits.blocks.filter((b) => b.id !== s.id) });
      }
    } else if (s.kind === "para") {
      setPageEdits(page.id, { ...edits, removedObjects: [...edits.removedObjects, ...s.para.objectIndices] });
    } else {
      setPageEdits(page.id, { ...edits, removedObjects: [...edits.removedObjects, s.loose.objectIndex] });
    }
    setSel(null);
  };

  const unlink = (link: ParagraphLink) => props.onChangeEdits([], links.filter((l) => l.id !== link.id));

  // ---------- linking paragraphs across a page break ----------

  const startPick = (dir: 1 | -1) => {
    if (!sel || sel.sel.kind !== "para") return;
    const i = indexById.get(sel.pageId);
    if (i == null || !pages[i + dir]) return;
    setEditing(null);
    setTool("select");
    setPick({ fromPageId: sel.pageId, para: sel.sel.para, dir });
    // Show the page break between the two pages.
    const boundary = dir === 1 ? geo.tops[i + 1] : geo.tops[i];
    const el = scrollRef.current;
    if (el) el.scrollTop = Math.max(0, boundary - el.clientHeight / 2);
  };

  const pickTargetId = useMemo(() => {
    if (!pick) return null;
    const i = indexById.get(pick.fromPageId);
    return i == null ? null : pages[i + pick.dir]?.id ?? null;
  }, [pick, indexById, pages]);

  const completePick = async (targetPageId: string, target: Paragraph) => {
    if (!pick) return;
    const from = pageById(pick.fromPageId);
    const to = pageById(targetPageId);
    if (!from || !to) return setPick(null);
    const [pageA, paraA, pageB, paraB] =
      pick.dir === 1 ? [from, pick.para, to, target] : [to, target, from, pick.para];
    setPick(null);
    try {
      const textB = await loadPageText(pageB.docId, pageB.pageIndex);
      openDraft(createLink(pageA, paraA, pageB, paraB, textB), true);
    } catch (e) {
      props.notify(errorMessage(e), "error");
    }
  };

  const openDraft = (link: ParagraphLink, isNew: boolean) => {
    setEditing(null);
    setSel(null);
    setPick(null);
    setDraft({ link, isNew, text: link.text, split: null, splitFor: null, busy: true, error: null });
  };

  // Re-measure the split shortly after typing stops.
  const draftLink = draft?.link;
  const draftText = draft?.text;
  useEffect(() => {
    if (!draftLink || draftText == null) return;
    let alive = true;
    const t = setTimeout(() => {
      splitLink(draftText, draftLink.style, draftLink.a, draftLink.b).then(
        (split) =>
          alive &&
          setDraft((d) =>
            d && d.link.id === draftLink.id && d.text === draftText
              ? { ...d, split, splitFor: draftText, busy: false, error: null }
              : d,
          ),
        (e) => alive && setDraft((d) => (d ? { ...d, busy: false, error: errorMessage(e) } : d)),
      );
    }, 160);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [draftLink, draftText]);

  const applyDraft = async () => {
    const d = draft;
    if (!d) return;
    let split = d.split;
    if (!split || d.splitFor !== d.text) {
      try {
        split = await splitLink(d.text, d.link.style, d.link.a, d.link.b);
      } catch (e) {
        setDraft({ ...d, error: errorMessage(e) });
        return;
      }
    }
    if (split.overflow > 0) {
      setDraft({ ...d, split, splitFor: d.text, busy: false });
      return;
    }
    const link: ParagraphLink = { ...d.link, text: normalizeText(d.text).trim() };
    const cur = latest.current;
    const others = cur.links.filter((l) => l.id !== link.id);
    props.onChangeEdits(linkUpdates(cur.pages, link, split), link.text ? [...others, link] : others);
    setDraft(null);
    if (split.partA) setSel({ pageId: link.a.pageId, sel: { kind: "block", id: link.a.blockId } });
  };

  // Live preview of a linked edit on both pages (rendered by PDFium, not committed).
  const preview = useMemo(() => {
    if (!draft?.split) return null;
    const map = new Map<string, PageEdits>();
    for (const u of linkUpdates(pages, draft.link, draft.split)) map.set(u.id, u.edits);
    return map;
  }, [draft?.split, draft?.link, pages]);

  const linkedByPage = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (pageId: string, blockId: string) => {
      let s = map.get(pageId);
      if (!s) map.set(pageId, (s = new Set()));
      s.add(blockId);
    };
    for (const l of draftLink ? [...links, draftLink] : links) {
      add(l.a.pageId, l.a.blockId);
      add(l.b.pageId, l.b.blockId);
    }
    return map;
  }, [links, draftLink]);

  // Leaving edit mode: finish what is open.
  useEffect(() => {
    if (editMode) return;
    handlers.current.finishEditing(false);
    setDraft(null);
    setPick(null);
    setSel(null);
    setTool("select");
  }, [editMode]);

  // ---------- page callbacks (one stable object, so pages can be memoised) ----------

  const h = {
    select(pageId: string, s: Selection | null) {
      if (pick) setPick(null);
      setSel(s ? { pageId, sel: s } : null);
    },
    clickParagraph(pageId: string, para: Paragraph) {
      if (pick) {
        if (pageId === pickTargetId) void completePick(pageId, para);
        else setPick(null);
        return;
      }
      startEditParagraph(pageId, para);
    },
    editBlock: startEditBlock,
    clickEmpty(pageId: string, pt: { x: number; y: number }) {
      if (pick) return setPick(null);
      if (tool === "text") {
        setEditing({
          pageId,
          e: {
            paragraph: null,
            isNew: true,
            draft: {
              id: newBlockId("text"),
              x: round2(pt.x),
              baseline: round2(pt.y + 12 * 0.8),
              width: null,
              text: "",
              font: { family: "Helvetica", bold: false, italic: false },
              size: 12,
              color: [0, 0, 0],
              lineHeight: 1.2,
              align: "left",
            },
          },
        });
        setTool("select");
        return;
      }
      setSel(null);
    },
    moveBlock(pageId: string, b: TextBlock, dx: number, dy: number) {
      updateBlock(pageId, { ...b, x: round2(b.x + dx), baseline: round2(b.baseline + dy) });
    },
    changeDraft(d: TextBlock) {
      setEditing((cur) => (cur ? { ...cur, e: { ...cur.e, draft: d } } : cur));
    },
    finishEditing,
    fitDraft() {
      void fitDraft();
    },
    error(message: string) {
      props.notify(message, "error");
    },
  };
  const handlers = useRef(h);
  handlers.current = h;
  const actions = useMemo<SurfaceActions>(
    () => ({
      select: (a, b) => handlers.current.select(a, b),
      clickParagraph: (a, b) => handlers.current.clickParagraph(a, b),
      editBlock: (a, b) => handlers.current.editBlock(a, b),
      clickEmpty: (a, b) => handlers.current.clickEmpty(a, b),
      moveBlock: (a, b, c, d) => handlers.current.moveBlock(a, b, c, d),
      changeDraft: (d) => handlers.current.changeDraft(d),
      finishEditing: (c) => handlers.current.finishEditing(c),
      fitDraft: () => handlers.current.fitDraft(),
      error: (m) => handlers.current.error(m),
    }),
    [],
  );

  // ---------- keyboard ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (draft || editing) return;
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select") || document.querySelector(".modal-backdrop")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setZoom((z) => Math.min(MAX_ZOOM, round2(z * 1.2)));
        return;
      }
      if (mod && e.key === "-") {
        e.preventDefault();
        setZoom((z) => Math.max(MIN_ZOOM, round2(z / 1.2)));
        return;
      }
      if (mod && e.key === "0") {
        e.preventDefault();
        setZoom(1);
        return;
      }
      if (mod || e.altKey || !editMode) return;
      if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        e.preventDefault();
        deleteSelection();
      } else if (e.key === "Escape") {
        if (pick) setPick(null);
        else if (sel) setSel(null);
        else if (tool !== "select") setTool("select");
        else props.onExitEdit();
      } else if (e.key === "t" || e.key === "T") {
        setTool("text");
      } else if (e.key === "v" || e.key === "V") {
        setTool("select");
      } else if (e.key === "Enter" && sel?.sel.kind === "block") {
        const id = sel.sel.id;
        const b = pageById(sel.pageId)?.edits.blocks.find((x) => x.id === id);
        if (b) startEditBlock(sel.pageId, b);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------- render ----------

  const over = vh * 0.75;
  const mounted = new Set<number>();
  if (pages.length) {
    for (let i = pageAt(scrollTop - over); i < pages.length && geo.tops[i] <= scrollTop + vh + over; i++) mounted.add(i);
  }
  // Pages with open work stay mounted even when scrolled away.
  for (const id of [editing?.pageId, draft?.link.a.pageId, draft?.link.b.pageId, pickTargetId]) {
    const i = id ? indexById.get(id) : undefined;
    if (i != null) mounted.add(i);
  }

  const selPage = sel ? pageById(sel.pageId) : undefined;
  const focusPage = selPage ?? pages[currentIndex];
  const selBlock =
    sel?.sel.kind === "block" ? selPage?.edits.blocks.find((b) => b.id === (sel.sel as { id: string }).id) ?? null : null;
  const selLink = selBlock ? findLinkForBlock(links, selBlock.id) : null;
  const numberOf = (id: string) => (indexById.get(id) ?? -1) + 1;
  const selIndex = sel ? indexById.get(sel.pageId) ?? -1 : -1;

  return (
    <div className={`docview${editMode ? "" : " no-bar"}`}>
      {editMode && (
        <div className="editor-bar">
          <div className="tile-tools" role="radiogroup" aria-label="Edit tool">
            <button
              role="radio"
              aria-checked={tool === "select"}
              className={`tile-tool${tool === "select" ? " active" : ""}`}
              onClick={() => setTool("select")}
              title="Select and edit (V)"
            >
              <Icon name="pointer" /> Select &amp; Edit
            </button>
            <button
              role="radio"
              aria-checked={tool === "text"}
              className={`tile-tool${tool === "text" ? " active" : ""}`}
              onClick={() => setTool("text")}
              title="Add a text box (T)"
            >
              <Icon name="type" /> Add Text
            </button>
            <button className="tile-tool" disabled title="Coming soon">
              <Icon name="image" /> Insert Object
            </button>
            <button className="tile-tool" disabled title="Coming soon">
              <Icon name="redact" /> Redact
            </button>
            <button className={`tile-tool${props.watermark ? " on" : ""}`} onClick={props.onWatermark} title="Watermark Studio">
              <Icon name="stamp" /> Watermark Studio
            </button>
            <button className="tile-tool" disabled title="Coming soon">
              <Icon name="form" /> Form Fields
            </button>
          </div>
          <div className="spacer" />
          <span className="mode-pill">
            <span className="dot" /> Interactive edit mode
          </span>
          <span className="hint">
            <kbd>V</kbd> select · <kbd>T</kbd> text · <kbd>Esc</kbd> exit
          </span>
        </div>
      )}

      <div className={`doc-body${editMode ? " with-inspector" : ""}${showStrip ? " with-strip" : ""}`}>
        {showStrip && (
          <Filmstrip
            pages={pages}
            docs={docs}
            watermark={props.watermark}
            current={currentIndex}
            editMode={editMode}
            onJump={(i) => scrollToIndex(i)}
          />
        )}
        <div className="doc-main">
        <div className="reading-pill" role="toolbar" aria-label="Page and zoom">
          <button
            className={`ghost icon-btn${showStrip ? " active" : ""}`}
            onClick={() => setShowStrip((v) => !v)}
            title={showStrip ? "Hide page thumbnails" : "Show page thumbnails"}
            aria-label="Toggle page thumbnails"
            aria-pressed={showStrip}
          >
            <Icon name="panelLeft" />
          </button>
          <div className="sep" />
          <button className="ghost icon-btn" onClick={() => scrollToIndex(currentIndex - 1)} disabled={currentIndex <= 0} title="Previous page" aria-label="Previous page">
            <Icon name="chevronLeft" />
          </button>
          <PageJump current={currentIndex + 1} count={pages.length} onJump={(n) => scrollToIndex(n - 1)} />
          <button className="ghost icon-btn" onClick={() => scrollToIndex(currentIndex + 1)} disabled={currentIndex >= pages.length - 1} title="Next page" aria-label="Next page">
            <Icon name="chevronRight" />
          </button>
          <div className="sep" />
          <button className="ghost icon-btn" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, round2(z / 1.2)))} title="Zoom out (Ctrl+−)" aria-label="Zoom out">
            <Icon name="minus" />
          </button>
          <span className="zoom">{Math.round(zoom * 100)}%</span>
          <button className="ghost icon-btn" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, round2(z * 1.2)))} title="Zoom in (Ctrl++)" aria-label="Zoom in">
            <Icon name="plus" />
          </button>
          <div className="sep" />
          <button className="ghost icon-btn" onClick={() => setZoom(1)} title="Fit width (Ctrl+0)" aria-label="Fit width">
            <Icon name="fitWidth" />
          </button>
        </div>
        <div className="doc-scroll" ref={scrollRef} tabIndex={0} onScroll={onScroll}>
          <div className="doc-canvas" style={{ height: geo.total, width: geo.contentW }}>
            {[...mounted].map((i) => {
              const page = pages[i];
              const size = geo.sizes[i];
              const w = Math.round(size.width * geo.scale);
              return (
                <PageSurface
                  key={page.id}
                  page={page}
                  number={i + 1}
                  width={size.width}
                  height={size.height}
                  top={geo.tops[i]}
                  left={Math.max(PAD, Math.round((geo.contentW - w) / 2))}
                  scale={geo.scale}
                  mode={mode}
                  tool={tool}
                  watermark={props.watermark}
                  edits={preview?.get(page.id) ?? page.edits}
                  selection={sel?.pageId === page.id ? sel.sel : null}
                  editing={editing?.pageId === page.id ? editing.e : null}
                  linkedBlocks={linkedByPage.get(page.id) ?? null}
                  pickTarget={pickTargetId === page.id}
                  locked={!!draft}
                  actions={actions}
                />
              );
            })}
          </div>
          {pick && pickTargetId && (
            <div className="pick-banner">
              Click the paragraph on page {numberOf(pickTargetId)} where this text{" "}
              {pick.dir === 1 ? "continues" : "starts"}.
              <button onClick={() => setPick(null)}>Cancel</button>
            </div>
          )}
        </div>
        </div>

        {editMode &&
          (draft ? (
            <LinkEditor
              pageA={numberOf(draft.link.a.pageId)}
              pageB={numberOf(draft.link.b.pageId)}
              text={draft.text}
              split={draft.splitFor === draft.text ? draft.split : null}
              capacityA={draft.link.a.capacity}
              capacityB={draft.link.b.capacity}
              busy={draft.busy}
              error={draft.error}
              isNew={draft.isNew}
              onChange={(text) => setDraft({ ...draft, text, busy: true })}
              onDone={() => void applyDraft()}
              onCancel={() => setDraft(null)}
            />
          ) : (
            <Inspector
              fonts={props.fonts}
              pageNumber={focusPage ? numberOf(focusPage.id) : null}
              block={selBlock}
              linked={
                selLink ? { pageA: numberOf(selLink.link.a.pageId), pageB: numberOf(selLink.link.b.pageId) } : null
              }
              paragraph={sel?.sel.kind === "para" ? sel.sel.para : null}
              loose={sel?.sel.kind === "loose" ? sel.sel.loose : null}
              hasEdits={!!focusPage && !editsAreEmpty(focusPage.edits)}
              onUpdateBlock={(b) => sel && updateBlock(sel.pageId, b)}
              onEditBlock={() => sel && selBlock && startEditBlock(sel.pageId, selBlock)}
              onEditParagraph={() => sel?.sel.kind === "para" && startEditParagraph(sel.pageId, sel.sel.para)}
              onDelete={deleteSelection}
              onUnlink={() => selLink && unlink(selLink.link)}
              onLinkNext={sel?.sel.kind === "para" && pages[selIndex + 1] ? () => startPick(1) : null}
              onLinkPrev={sel?.sel.kind === "para" && selIndex > 0 ? () => startPick(-1) : null}
              onRemoveEverywhere={() =>
                sel?.sel.kind === "loose" && selPage && props.onRemoveEverywhere(sel.sel.loose.text, selPage.docId)
              }
              onRestorePage={() => {
                if (!focusPage) return;
                setPageEdits(focusPage.id, EMPTY_EDITS);
                setSel(null);
              }}
            />
          ))}
      </div>
    </div>
  );
}

/** First page whose bottom edge is at or below `y`. */
function pageAtIn(g: { tops: number[]; heights: number[] }, y: number): number {
  let lo = 0;
  let hi = g.tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (g.tops[mid] + g.heights[mid] < y) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo);
}

function PageJump(props: { current: number; count: number; onJump: (n: number) => void }) {
  const [text, setText] = useState(String(props.current));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(props.current));
  }, [props.current, focused]);
  const go = () => {
    const n = Math.round(Number(text));
    if (Number.isFinite(n) && n >= 1 && n <= props.count) props.onJump(n);
    else setText(String(props.current));
  };
  return (
    <span className="page-indicator">
      <input
        className="page-input"
        value={text}
        inputMode="numeric"
        aria-label="Page number"
        onFocus={(e) => {
          setFocused(true);
          e.target.select();
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            go();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setText(String(props.current));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <span>/ {props.count}</span>
    </span>
  );
}

const STRIP_W = 148;

/** Left pane: page thumbnails, plus outline and marks tabs (not built yet). */
function Filmstrip(props: {
  pages: PageItem[];
  docs: Map<number, DocInfo>;
  watermark: Watermark | null;
  current: number;
  editMode: boolean;
  onJump: (index: number) => void;
}) {
  const [tab, setTab] = useState<"pages" | "outline" | "marks">("pages");
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the current page's thumbnail in view.
  useEffect(() => {
    const box = listRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-index="${props.current}"]`);
    if (!box || !el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top - 12;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 12;
  }, [props.current, tab]);

  return (
    <aside className="filmstrip" aria-label="Pages">
      <div className="segmented strip-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "pages"} className={tab === "pages" ? "active" : ""} onClick={() => setTab("pages")}>
          Pages <span className="tab-count">{props.pages.length}</span>
        </button>
        <button role="tab" aria-selected={tab === "outline"} className={tab === "outline" ? "active" : ""} onClick={() => setTab("outline")}>
          Outline
        </button>
        <button role="tab" aria-selected={tab === "marks"} className={tab === "marks" ? "active" : ""} onClick={() => setTab("marks")}>
          Marks
        </button>
      </div>
      {tab === "pages" ? (
        <div className="film-list" ref={listRef}>
          {props.pages.map((page, i) => (
            <FilmThumb
              key={page.id}
              page={page}
              index={i}
              doc={props.docs.get(page.docId)}
              watermark={props.watermark}
              active={i === props.current}
              onJump={props.onJump}
            />
          ))}
        </div>
      ) : (
        <div className="film-list">
          {tab === "outline" ? (
            <EmptyNote icon="bookmark" title="Outline not available yet">
              Bookmarks and sections will show here.
            </EmptyNote>
          ) : (
            <EmptyNote icon="note" title="No marks yet">
              Highlights, notes and ink are coming in a later version.
            </EmptyNote>
          )}
        </div>
      )}
      <div className="strip-foot">
        <Icon name={props.editMode ? "edit" : "lock"} size={14} />
        {props.editMode ? "Editing" : "Read-only mode"}
      </div>
    </aside>
  );
}

const FilmThumb = memo(function FilmThumb(p: {
  page: PageItem;
  index: number;
  doc: DocInfo | undefined;
  watermark: Watermark | null;
  active: boolean;
  onJump: (index: number) => void;
}) {
  const [ref, visible] = useVisible<HTMLButtonElement>();
  const info = p.doc?.pages[p.page.pageIndex] ?? FALLBACK_SIZE;
  const size = displaySize(info, p.page.rotation);
  const height = Math.round((STRIP_W * size.height) / size.width);
  const { url, error } = useThumbnail(thumbRequest(p.page, STRIP_W, p.watermark), visible);
  const edited = !editsAreEmpty(p.page.edits);
  return (
    <button
      ref={ref}
      data-index={p.index}
      className={`film-thumb${p.active ? " active" : ""}`}
      onClick={() => p.onJump(p.index)}
      aria-label={`Go to page ${p.index + 1}`}
      aria-current={p.active ? "page" : undefined}
    >
      <span className="film-img" style={{ height }}>
        {url ? <img src={url} alt="" draggable={false} /> : <span className={`thumb-placeholder${error ? " error" : ""}`} />}
        {p.active && <span className="film-active">Active</span>}
        {edited && <span className="film-edited" title="This page has edits" />}
        <span className="film-num">p. {p.index + 1}</span>
      </span>
    </button>
  );
});
