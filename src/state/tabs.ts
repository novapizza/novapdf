import type { DocId } from "../lib/types";
import { type Action, type DocInfo, type History, initialHistory, pagesFromDoc, reducer } from "./workspace";

/** One open document tab. Each tab has its own pages and its own undo history. */
export interface Tab {
  id: string;
  /** The file this tab was opened from (the first one, for a merge). Opening it
   *  again switches to this tab, unless the tab is a merge of several files. */
  docId: DocId;
  /** Made by merging several files: it does not stand for any one of them. */
  merged?: boolean;
  title: string;
  history: History;
  /** Page shown in the document view, kept while other tabs are in front. */
  currentPageId: string | null;
}

export interface Tabs {
  tabs: Tab[];
  active: string | null;
}

export type TabsAction =
  | { type: "open"; doc: DocInfo }
  /** One new tab holding the pages of all `docs`, in order. */
  | { type: "openMerged"; docs: DocInfo[] }
  | { type: "activate"; id: string }
  | { type: "close"; id: string }
  | { type: "edit"; id: string; action: Action }
  | { type: "setCurrentPage"; id: string; pageId: string | null };

export const initialTabs: Tabs = { tabs: [], active: null };

let counter = 0;
function newTabId(): string {
  counter += 1;
  return `t${counter}`;
}

function update(s: Tabs, id: string, f: (t: Tab) => Tab): Tabs {
  let changed = false;
  const tabs = s.tabs.map((t) => {
    if (t.id !== id) return t;
    const next = f(t);
    changed ||= next !== t;
    return next;
  });
  return changed ? { ...s, tabs } : s;
}

function addTab(s: Tabs, docs: DocInfo[]): Tabs {
  const pages = docs.flatMap(pagesFromDoc);
  const tab: Tab = {
    id: newTabId(),
    docId: docs[0].docId,
    title: docs[0].fileName,
    history: reducer(initialHistory, { type: "reset", pages }),
    currentPageId: pages[0]?.id ?? null,
  };
  if (docs.length > 1) tab.merged = true;
  return { tabs: [...s.tabs, tab], active: tab.id };
}

export function tabsReducer(s: Tabs, a: TabsAction): Tabs {
  switch (a.type) {
    case "open": {
      // A file that is already open in a tab switches to that tab.
      const existing = s.tabs.find((t) => t.docId === a.doc.docId && !t.merged);
      if (existing) return existing.id === s.active ? s : { ...s, active: existing.id };
      return addTab(s, [a.doc]);
    }
    case "openMerged":
      return a.docs.length ? addTab(s, a.docs) : s;
    case "activate":
      return s.active !== a.id && s.tabs.some((t) => t.id === a.id) ? { ...s, active: a.id } : s;
    case "close": {
      const i = s.tabs.findIndex((t) => t.id === a.id);
      if (i < 0) return s;
      const tabs = s.tabs.filter((t) => t.id !== a.id);
      // Closing the front tab brings forward its right neighbour, else its left one.
      const active = s.active === a.id ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : s.active;
      return { tabs, active };
    }
    case "edit":
      return update(s, a.id, (t) => {
        const history = reducer(t.history, a.action);
        return history === t.history ? t : { ...t, history };
      });
    case "setCurrentPage":
      return update(s, a.id, (t) => (t.currentPageId === a.pageId ? t : { ...t, currentPageId: a.pageId }));
  }
}

export function activeTab(s: Tabs): Tab | null {
  return s.tabs.find((t) => t.id === s.active) ?? null;
}

export function isDirty(t: Tab): boolean {
  return t.history.present !== t.history.saved && t.history.present.pages.length > 0;
}

/** The tab after (or before, with `step` -1) the active one, wrapping around. */
export function neighbourTab(s: Tabs, step: 1 | -1): string | null {
  if (s.tabs.length === 0) return null;
  const i = s.tabs.findIndex((t) => t.id === s.active);
  return s.tabs[(i + step + s.tabs.length) % s.tabs.length].id;
}

/** Every document the given tabs still need, including through undo and redo. */
export function referencedDocs(tabs: Tab[]): Set<DocId> {
  const ids = new Set<DocId>();
  for (const t of tabs) {
    ids.add(t.docId);
    const { past, present, future, saved } = t.history;
    for (const ws of [...past, present, ...future, saved]) for (const p of ws.pages) ids.add(p.docId);
  }
  return ids;
}
