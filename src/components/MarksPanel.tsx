import { useEffect, useMemo, useState } from "react";

import {
  annotBounds,
  cachedPageAnnots,
  formatAnnotDate,
  kindLabel,
  scanDocument,
  visibleAnnots,
} from "../lib/annotations";
import { errorMessage } from "../lib/api";
import type { Rect } from "../lib/types";
import type { DocInfo, PageItem } from "../state/workspace";
import type { AnnotRef } from "./AnnotationLayer";
import { Icon, type IconName } from "./Icon";
import { EmptyNote } from "./Shell";

interface Item {
  key: string;
  pageNumber: number;
  pageId: string;
  ref: AnnotRef;
  rect: Rect;
  kind: string;
  author: string;
  date: string;
  text: string;
  replies: number;
  /** Made in this session, not saved yet. */
  unsaved: boolean;
}

const ICONS: Record<string, IconName> = { Text: "note", note: "note", Highlight: "highlighter", highlight: "highlighter", Ink: "ink", ink: "ink" };

/**
 * The Marks tab: every comment in the open document (the file's and the ones made in
 * this session), grouped by page. Comments in the file are found with a background
 * scan, so a long document fills in as it goes.
 */
export function MarksPanel(props: {
  pages: PageItem[];
  docs: Map<number, DocInfo>;
  author: string;
  onAuthor: (name: string) => void;
  onOpen: (pageId: string, ref: AnnotRef, rect: Rect) => void;
}) {
  const { pages, docs } = props;
  const [filter, setFilter] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);

  const docIds = useMemo(() => [...new Set(pages.map((p) => p.docId))].join(","), [pages]);
  useEffect(() => {
    const ctrl = new AbortController();
    const ids = docIds ? docIds.split(",").map(Number) : [];
    const counts = ids.map((id) => docs.get(id)?.pages.length ?? 0);
    const total = counts.reduce((a, b) => a + b, 0);
    setProgress({ done: 0, total });
    setError(null);
    (async () => {
      let before = 0;
      for (let i = 0; i < ids.length; i++) {
        const base = before;
        await scanDocument(ids[i], counts[i], (n) => setProgress({ done: base + n, total }), ctrl.signal);
        before += counts[i];
      }
    })().catch((e) => !ctrl.signal.aborted && setError(errorMessage(e)));
    return () => ctrl.abort();
    // The page count of a document never changes, so the ids are enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docIds]);

  const items = useMemo(() => {
    const out: Item[] = [];
    let hidden = 0;
    pages.forEach((page, i) => {
      const listed = cachedPageAnnots(page.docId, page.pageIndex);
      hidden += listed?.more ?? 0;
      const file = visibleAnnots(listed?.annots ?? [], page.edits);
      for (const a of file) {
        if (a.inReplyTo != null) continue;
        out.push({
          key: `${page.id}/f${a.index}`,
          pageNumber: i + 1,
          pageId: page.id,
          ref: { kind: "file", index: a.index },
          rect: a.rect,
          kind: a.subtype,
          author: a.author,
          date: a.date,
          text: a.contents,
          replies: file.filter((r) => r.inReplyTo === a.index).length,
          unsaved: false,
        });
      }
      for (const a of page.edits.annotations ?? []) {
        out.push({
          key: `${page.id}/n${a.id}`,
          pageNumber: i + 1,
          pageId: page.id,
          ref: { kind: "new", id: a.id },
          rect: annotBounds(a),
          kind: a.kind,
          author: a.author,
          date: a.date,
          text: a.contents,
          replies: 0,
          unsaved: true,
        });
      }
    });
    return { list: out, hidden };
    // `progress` changes as the scan fills the cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, progress]);

  const q = filter.trim().toLowerCase();
  const shown = q
    ? items.list.filter((it) => it.text.toLowerCase().includes(q) || it.author.toLowerCase().includes(q))
    : items.list;
  const scanning = progress.done < progress.total && !error;

  return (
    <div className="marks">
      <label className="marks-author">
        <span>Your name on new comments</span>
        <input
          value={props.author}
          maxLength={256}
          placeholder="Not set"
          onChange={(e) => props.onAuthor(e.target.value)}
        />
      </label>
      <input
        className="marks-filter"
        type="search"
        placeholder="Filter by text or author"
        aria-label="Filter comments"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {scanning && (
        <div className="marks-status" role="status">
          <span className="spinner" /> Looking for comments… {progress.done} / {progress.total} pages
        </div>
      )}
      {error && <div className="notice error">Comments could not be read: {error}</div>}
      {items.hidden > 0 && (
        <div className="marks-status">
          {items.hidden} more comment{items.hidden === 1 ? "" : "s"} not shown (too many on one page)
        </div>
      )}
      {shown.length === 0 && !scanning ? (
        <EmptyNote icon="note" title={q ? "No matching comments" : "No comments yet"}>
          {q ? "Try other words." : "Use Highlight, Note or Ink in the toolbar to add one."}
        </EmptyNote>
      ) : (
        <ul className="marks-list" aria-label="Comments">
          {shown.map((it, i) => (
            <li key={it.key}>
              {(i === 0 || shown[i - 1].pageNumber !== it.pageNumber) && (
                <div className="marks-page">Page {it.pageNumber}</div>
              )}
              <button className="mark-item" onClick={() => props.onOpen(it.pageId, it.ref, it.rect)}>
                <Icon name={ICONS[it.kind] ?? "note"} size={14} />
                <span className="mark-body">
                  <span className="mark-head">
                    <b>{kindLabel(it.kind)}</b>
                    {it.author && <span>{it.author}</span>}
                    {it.unsaved && <span className="mark-unsaved">unsaved</span>}
                  </span>
                  {it.text && <span className="mark-text">{it.text}</span>}
                  <span className="mark-meta">
                    {formatAnnotDate(it.date)}
                    {it.replies > 0 && ` · ${it.replies} repl${it.replies === 1 ? "y" : "ies"}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
