import { useEffect, useMemo, useState } from "react";

import { errorMessage } from "../lib/api";
import {
  cachedOutline,
  currentEntry,
  entryTargets,
  hasChildren,
  initiallyCollapsed,
  loadOutline,
  pagePositions,
  visibleRows,
} from "../lib/outline";
import type { DocId, Outline } from "../lib/types";
import type { DocInfo, PageItem } from "../state/workspace";
import { Icon } from "./Icon";
import { EmptyNote } from "./Shell";

type Loaded = { outline: Outline } | { error: string };

/**
 * The Outline tab: the bookmarks of each document in the tab, as a tree. Each entry
 * goes to its page where that page is now in the tab (pages may have been moved or
 * removed since the file was opened).
 */
export function OutlinePanel(props: {
  pages: PageItem[];
  docs: Map<number, DocInfo>;
  /** Index of the page being read. */
  current: number;
  /** Goes to a page of the tab; `y` is where on the page, in display space. */
  onJump: (index: number, y: number | null) => void;
}) {
  const { pages } = props;
  const docIds = useMemo(() => [...new Set(pages.map((p) => p.docId))], [pages]);
  const key = docIds.join(",");
  const [loaded, setLoaded] = useState<Map<DocId, Loaded>>(() => {
    const m = new Map<DocId, Loaded>();
    for (const id of docIds) {
      const o = cachedOutline(id);
      if (o) m.set(id, { outline: o });
    }
    return m;
  });

  useEffect(() => {
    let alive = true;
    for (const id of docIds) {
      if (loaded.has(id)) continue;
      loadOutline(id).then(
        (outline) => alive && setLoaded((m) => new Map(m).set(id, { outline })),
        (e) => alive && setLoaded((m) => new Map(m).set(id, { error: errorMessage(e) })),
      );
    }
    return () => {
      alive = false;
    };
    // Only new documents need loading; `loaded` already holds the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const positions = useMemo(() => pagePositions(pages), [pages]);
  const pending = docIds.filter((id) => !loaded.has(id));
  const withEntries = docIds.filter((id) => {
    const l = loaded.get(id);
    return l && ("error" in l || l.outline.items.length > 0);
  });

  if (withEntries.length === 0) {
    return pending.length > 0 ? (
      <div className="marks-status" role="status">
        <span className="spinner" /> Reading the outline…
      </div>
    ) : (
      <EmptyNote icon="bookmark" title="No outline">
        This document has no bookmarks.
      </EmptyNote>
    );
  }

  return (
    <div className="outline">
      {withEntries.map((id) => (
        <DocOutline
          key={id}
          docId={id}
          title={docIds.length > 1 ? props.docs.get(id)?.fileName ?? "Document" : null}
          loaded={loaded.get(id)!}
          positions={positions}
          current={props.current}
          onJump={props.onJump}
        />
      ))}
      {pending.length > 0 && (
        <div className="marks-status" role="status">
          <span className="spinner" /> Reading the outline…
        </div>
      )}
    </div>
  );
}

function DocOutline(p: {
  docId: DocId;
  /** Shown when the tab holds pages of more than one file. */
  title: string | null;
  loaded: Loaded;
  positions: Map<string, number>;
  current: number;
  onJump: (index: number, y: number | null) => void;
}) {
  const items = "outline" in p.loaded ? p.loaded.outline.items : [];
  const [collapsed, setCollapsed] = useState(() => initiallyCollapsed(items));
  const targets = useMemo(() => entryTargets(p.docId, items, p.positions), [p.docId, items, p.positions]);
  const rows = useMemo(() => visibleRows(items, collapsed), [items, collapsed]);
  const shown = useMemo(() => new Set(rows), [rows]);
  const active = currentEntry(items, targets, p.current, shown);

  const toggle = (i: number) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(i)) next.add(i);
      return next;
    });

  return (
    <section className="outline-doc" aria-label={p.title ? `Outline of ${p.title}` : "Outline"}>
      {p.title && <div className="marks-page">{p.title}</div>}
      {"error" in p.loaded ? (
        <div className="notice error">The outline could not be read: {p.loaded.error}</div>
      ) : (
        <>
          <ul className="outline-list" role="tree" aria-label={p.title ? `Bookmarks of ${p.title}` : "Bookmarks"}>
            {rows.map((i) => {
              const it = items[i];
              const target = targets[i];
              const parent = hasChildren(items, i);
              const open = parent && !collapsed.has(i);
              const why =
                it.pageIndex == null
                  ? "This bookmark does not go to a page in this file"
                  : target == null
                    ? "This page was removed from the document"
                    : undefined;
              return (
                <li
                  key={i}
                  role="treeitem"
                  aria-level={it.depth + 1}
                  aria-expanded={parent ? open : undefined}
                  aria-selected={i === active}
                  className={`outline-row${i === active ? " active" : ""}`}
                  style={{ paddingLeft: Math.min(it.depth, 12) * 14 }}
                >
                  {parent ? (
                    <button
                      className="outline-toggle ghost icon-btn"
                      onClick={() => toggle(i)}
                      aria-label={`${open ? "Collapse" : "Expand"} ${it.title || "bookmark"}`}
                    >
                      <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
                    </button>
                  ) : (
                    <span className="outline-toggle" />
                  )}
                  <button
                    className="outline-item"
                    disabled={target == null}
                    title={why ?? it.title}
                    onClick={() => target != null && p.onJump(target, it.y)}
                  >
                    <span className="outline-title">{it.title || "Untitled"}</span>
                    {target != null && <span className="outline-page">{target + 1}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {p.loaded.outline.truncated && (
            <div className="marks-status">Some bookmarks are not shown (the outline is too large or damaged).</div>
          )}
        </>
      )}
    </section>
  );
}
