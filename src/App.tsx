import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";

import { api, errorMessage } from "./lib/api";
import type { OpenOutcome, PageEdits, UpdateStatus, Watermark } from "./lib/types";
import { editsAreEmpty } from "./lib/types";
import {
  type Action,
  type DocInfo,
  type ParagraphLink,
  initialHistory,
  pagesFromDoc,
} from "./state/workspace";
import { type Tab, activeTab, initialTabs, isDirty, neighbourTab, referencedDocs, tabsReducer } from "./state/tabs";
import { PageGrid } from "./components/PageGrid";
import { DocumentView } from "./components/DocumentView";
import { WatermarkDialog } from "./components/WatermarkDialog";
import { CleanDialog, type ScanResult } from "./components/CleanDialog";
import { Toasts, type Toast } from "./components/Toasts";
import { Icon } from "./components/Icon";
import { useTheme } from "./lib/theme";
import { useSidebarCollapsed } from "./lib/sidebar";
import { ComingSoon, Library, type Section, SECTION_INFO, Sidebar, paperName } from "./components/Shell";
import { type Command, CommandPalette } from "./components/CommandPalette";
import "./App.css";

/** Read and Edit show the whole document as one scroll; Organize ("grid") is the page grid. */
type Dialog = null | { kind: "watermark" } | { kind: "clean"; text: string; docIds: number[] | null } | { kind: "palette" };

let toastId = 0;

export default function App() {
  const [tabState, tabsDispatch] = useReducer(tabsReducer, initialTabs);
  const tab = activeTab(tabState);
  const tabId = tab?.id ?? null;
  const history = tab?.history ?? initialHistory;
  const ws = history.present;
  const dirty = tab ? isDirty(tab) : false;
  /** Page shown in the document view (kept per tab, and when switching views). */
  const currentPageId = tab?.currentPageId ?? null;

  /** Applies a workspace action to the front tab. */
  const dispatch = useCallback(
    (action: Action) => tabId && tabsDispatch({ type: "edit", id: tabId, action }),
    [tabId],
  );
  const setCurrentPageId = useCallback(
    (pageId: string | null) => tabId && tabsDispatch({ type: "setCurrentPage", id: tabId, pageId }),
    [tabId],
  );

  /** Every open document, shared by the tabs (a merged file can appear in several). */
  const [docs, setDocs] = useState<Map<number, DocInfo>>(new Map());
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("library");
  const docMode = section === "read" || section === "edit" ? section : null;
  const [thumbWidth, setThumbWidth] = useState(170);
  const [sanitize, setSanitize] = useState(true);
  const [theme, setTheme] = useTheme();
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed();
  const [fonts, setFonts] = useState<string[]>(["Helvetica", "Times", "Courier"]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** A file drag is over the window: show the drop overlay. */
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  const notify = useCallback((message: string, kind: "info" | "error" = "info") => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 9000 : 4000);
  }, []);

  useEffect(() => {
    api.listFonts().then(setFonts).catch(() => {});
  }, []);

  // Released builds look for a newer version once at launch. Only a found update
  // is reported; a failed or unconfigured check stays quiet.
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    api
      .checkUpdate()
      .then((s) => {
        if (!s.available) return;
        setUpdate(s);
        notify(`NovaPDF ${s.version} is available. Install it from the command palette.`);
      })
      .catch(() => {});
  }, [notify]);

  // Keep refs for event handlers registered once.
  const stateRef = useRef({ ws, tabs: tabState.tabs, tabId, section });
  stateRef.current = { ws, tabs: tabState.tabs, tabId, section };
  const drops = useRef({ pending: 0, chain: Promise.resolve() });

  // Selection belongs to the tab in front: switching tabs clears it.
  useEffect(() => {
    setSelection(new Set());
    setAnchor(null);
  }, [tabId]);

  // ---------- opening ----------

  /** "tabs" opens each file in its own tab (or switches to it if it is already
   *  open); "merge" appends the files' pages to the front tab, or with no tab open,
   *  combines them into one new tab. Either way the result shows in the document view. */
  const addOutcomes = useCallback(
    (outcomes: OpenOutcome[], mode: "tabs" | "merge") => {
      for (const o of outcomes) if (o.error) notify(`${o.fileName}: ${o.error}`, "error");
      const opened: DocInfo[] = outcomes.flatMap((o) => (o.document ? [o.document] : []));
      if (opened.length === 0) return;
      setDocs((prev) => new Map([...prev, ...opened.map((d) => [d.docId, d] as const)]));
      const { tabs, tabId: front, section: from } = stateRef.current;
      const inDocument = from === "read" || from === "edit" || from === "grid";
      const count = (docs: DocInfo[]) => {
        const pages = docs.reduce((n, d) => n + d.pages.length, 0);
        return `${docs.length === 1 ? docs[0].fileName : `${docs.length} files`} (${pages} page${pages === 1 ? "" : "s"})`;
      };
      if (!inDocument) setSection("read");
      if (mode === "merge") {
        if (front) {
          const pages = opened.flatMap(pagesFromDoc);
          tabsDispatch({ type: "edit", id: front, action: { type: "append", pages } });
          // Coming from the Library: show where the merged pages start.
          if (!inDocument && pages[0]) tabsDispatch({ type: "setCurrentPage", id: front, pageId: pages[0].id });
        } else {
          tabsDispatch({ type: "openMerged", docs: opened });
        }
        notify(`Merged ${count(opened)}`);
        return;
      }
      const fresh = opened.filter((d) => !tabs.some((t) => t.docId === d.docId && !t.merged));
      for (const d of opened) tabsDispatch({ type: "open", doc: d });
      if (fresh.length) notify(`Opened ${count(fresh)}`);
      for (const d of opened) if (!fresh.includes(d)) notify(`${d.fileName} is already open`);
    },
    [notify],
  );

  const openFiles = async (mode: "tabs" | "merge") => {
    try {
      setBusy("Opening…");
      addOutcomes(await api.openWithDialog(), mode);
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    // Dropped files, and files the OS launched the app with, open in new tabs. Batches
    // that overlap (a second drop while the first is still opening) are applied in
    // arrival order, so tabs appear in that order.
    const openGranted = (paths: string[]) => {
      if (paths.length === 0) return;
      const d = drops.current;
      d.pending += 1;
      setBusy("Opening…");
      const opening = api.openDropped(paths);
      d.chain = d.chain.then(async () => {
        try {
          addOutcomes(await opening, "tabs");
        } catch (err) {
          notify(errorMessage(err), "error");
        } finally {
          d.pending -= 1;
          if (d.pending === 0) setBusy(null);
        }
      });
    };
    // Launch files wait in a queue on the Rust side, so none are lost before this
    // listener exists: take whatever is queued now, and again on each nudge.
    const takeLaunch = () =>
      api.takeLaunchFiles().then(openGranted, (err) => notify(errorMessage(err), "error"));
    const unDrop = listen<string[]>("files-dropped", (e) => openGranted(e.payload));
    const unHover = listen<boolean>("drag-hover", (e) => setDragging(e.payload));
    const unLaunch = listen("launch-files", takeLaunch);
    unLaunch.then(() => takeLaunch());
    return () => {
      unDrop.then((f) => f());
      unHover.then((f) => f());
      unLaunch.then((f) => f());
    };
  }, [addOutcomes, notify]);

  // Unsaved-changes guard on window close.
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested(async (event) => {
      const unsaved = stateRef.current.tabs.filter(isDirty).length;
      if (unsaved) {
        const what = unsaved === 1 ? "You have unsaved changes" : `${unsaved} documents have unsaved changes`;
        const ok = await ask(`${what}. Quit anyway?`, { title: "NovaPDF", kind: "warning" });
        if (!ok) event.preventDefault();
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // ---------- tabs ----------

  const closeTab = async (id: string) => {
    const t = stateRef.current.tabs.find((x) => x.id === id);
    if (!t) return;
    if (isDirty(t) && !(await ask(`${t.title} has unsaved changes. Close it anyway?`, { title: "NovaPDF", kind: "warning" })))
      return;
    const rest = stateRef.current.tabs.filter((x) => x.id !== id);
    tabsDispatch({ type: "close", id });
    if (rest.length === 0) setSection("library");
    // Free documents no other tab uses (not even through undo).
    const keep = referencedDocs(rest);
    const release = [...referencedDocs([t])].filter((d) => !keep.has(d));
    for (const d of release) api.closeDocument(d).catch(() => {});
    if (release.length)
      setDocs((prev) => {
        const next = new Map(prev);
        for (const d of release) next.delete(d);
        return next;
      });
  };

  /** Clicking a tab brings its document up, also from the Library or another section. */
  const activateTab = (id: string) => {
    tabsDispatch({ type: "activate", id });
    if (!docMode && section !== "grid") setSection("read");
  };

  // ---------- updates ----------

  const checkForUpdates = async () => {
    try {
      const s = await api.checkUpdate();
      setUpdate(s.available ? s : null);
      if (!s.configured) notify("This build can't update itself. Download new versions from the NovaPDF website.");
      else if (s.available) notify(`NovaPDF ${s.version} is available.`);
      else notify(`NovaPDF is up to date (version ${s.currentVersion}).`);
    } catch (err) {
      notify(`Couldn't check for updates: ${errorMessage(err)}`, "error");
    }
  };

  /** Installing restarts the app, so unsaved work is confirmed first, as on quit. */
  const installUpdate = async () => {
    if (busy) return;
    const unsaved = stateRef.current.tabs.filter(isDirty).length;
    if (unsaved) {
      const what = unsaved === 1 ? "You have unsaved changes" : `${unsaved} documents have unsaved changes`;
      if (!(await ask(`${what}. NovaPDF restarts to install the update. Continue?`, { title: "NovaPDF", kind: "warning" })))
        return;
    }
    try {
      setBusy("Installing update…");
      await api.installUpdate();
    } catch (err) {
      setUpdate(null);
      notify(`Couldn't install the update: ${errorMessage(err)}`, "error");
    } finally {
      setBusy(null);
    }
  };

  // ---------- saving ----------

  const save = async () => {
    if (!tab || ws.pages.length === 0 || busy) return;
    const savingTab = tab.id; // the user may switch tabs while the dialog is open
    const suggestedName = tab.title.replace(/\.pdf$/i, "") + "-edited.pdf";
    try {
      setBusy("Saving…");
      const saved = await api.saveWithDialog({
        pages: ws.pages.map((p) => ({
          docId: p.docId,
          pageIndex: p.pageIndex,
          rotation: p.rotation,
          edits: editsAreEmpty(p.edits) ? null : p.edits,
        })),
        watermark: ws.watermark,
        sanitize,
        suggestedName,
      });
      if (saved) {
        tabsDispatch({ type: "edit", id: savingTab, action: { type: "markSaved" } });
        notify(`Saved ${saved.path}`);
        for (const w of saved.warnings) notify(w, "error");
      }
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  // ---------- page operations ----------

  const selectedIds = useMemo(() => ws.pages.filter((p) => selection.has(p.id)).map((p) => p.id), [ws.pages, selection]);

  const onSelect = useCallback(
    (id: string, mode: "single" | "toggle" | "range") => {
      setSelection((prev) => {
        if (mode === "single") return new Set([id]);
        if (mode === "toggle") {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }
        const ids = stateRef.current.ws.pages.map((p) => p.id);
        const a = anchor ? ids.indexOf(anchor) : -1;
        const b = ids.indexOf(id);
        if (a < 0) return new Set([id]);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        return new Set(ids.slice(lo, hi + 1));
      });
      if (mode !== "range") setAnchor(id);
    },
    [anchor],
  );

  const deleteSelected = () => {
    if (selectedIds.length === 0) return;
    dispatch({ type: "delete", ids: selectedIds });
    setSelection(new Set());
  };
  const rotateSelected = (delta: 90 | -90) => selectedIds.length && dispatch({ type: "rotate", ids: selectedIds, delta });
  const openInDocument = (pageId: string | null, mode: "read" | "edit") => {
    if (pageId) setCurrentPageId(pageId);
    setSection(mode);
  };
  const editSelected = () => selectedIds.length && openInDocument(selectedIds[0], "edit");
  const showOrganize = () => {
    if (currentPageId) {
      setSelection(new Set([currentPageId]));
      setAnchor(currentPageId);
    }
    setSection("grid");
  };
  const navigate = (target: Section) => {
    if (target === section) return;
    if (target === "grid") return showOrganize();
    if ((target === "read" || target === "edit") && section === "grid")
      return openInDocument(selectedIds[0] ?? currentPageId, target);
    setSection(target);
  };
  const changeEdits = useCallback(
    (updates: { id: string; edits: PageEdits }[], links?: ParagraphLink[]) =>
      dispatch({ type: "setEdits", updates, links }),
    [dispatch],
  );

  const applyClean = (results: ScanResult[]) => {
    const updates: { id: string; edits: PageEdits }[] = [];
    let count = 0;
    for (const page of ws.pages) {
      const r = results.find((x) => x.docId === page.docId);
      const found = r?.scan.pages.find((p) => p.pageIndex === page.pageIndex);
      if (!found) continue;
      const objects = new Set([...page.edits.removedObjects, ...found.objects]);
      const annots = new Set([...page.edits.removedAnnots, ...found.annots]);
      count += found.objects.length + found.annots.length;
      updates.push({ id: page.id, edits: { ...page.edits, removedObjects: [...objects], removedAnnots: [...annots] } });
    }
    if (updates.length) dispatch({ type: "setEdits", updates });
    setDialog(null);
    notify(`Removed ${count} watermark item${count === 1 ? "" : "s"} from ${updates.length} page${updates.length === 1 ? "" : "s"}`);
  };

  // ---------- keyboard ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = !!target.closest("input, textarea, select");
      const mod = e.ctrlKey || e.metaKey;
      if (dialog) return;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog({ kind: "palette" });
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      } else if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openFiles(e.shiftKey ? "merge" : "tabs");
      } else if (mod && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (tabId) closeTab(tabId);
      } else if (mod && e.key === "Tab") {
        e.preventDefault();
        const next = neighbourTab(tabState, e.shiftKey ? -1 : 1);
        if (next) tabsDispatch({ type: "activate", id: next });
      } else if (typing || target.isContentEditable) {
        return;
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarCollapsed(!sidebarCollapsed);
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
      } else if (section === "grid" && hasDoc) {
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          deleteSelected();
        } else if (mod && e.key.toLowerCase() === "a") {
          e.preventDefault();
          setSelection(new Set(ws.pages.map((p) => p.id)));
        } else if (e.key === "Escape") {
          setSelection(new Set());
        } else if (e.key === "Enter") {
          editSelected();
        } else if (e.key.toLowerCase() === "r") {
          rotateSelected(e.shiftKey ? -90 : 90);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });


  // ---------- render ----------

  const hasDoc = ws.pages.length > 0;
  const currentIndex = currentPageId ? ws.pages.findIndex((p) => p.id === currentPageId) : -1;
  const previewPage =
    (docMode ? ws.pages[currentIndex] : ws.pages.find((p) => selection.has(p.id))) ?? ws.pages[0] ?? null;
  const docsInUse = useMemo(() => {
    const ids = new Set(ws.pages.map((p) => p.docId));
    return [...docs.values()].filter((d) => ids.has(d.docId));
  }, [docs, ws.pages]);
  const soon = !!SECTION_INFO[section].soon;

  const openWatermark = () => setDialog({ kind: "watermark" });
  const openClean = () => setDialog({ kind: "clean", text: "", docIds: null });
  const inGrid = section === "grid" && hasDoc;
  const pageNumbers = selectedIds.map((id) => ws.pages.findIndex((p) => p.id === id) + 1);

  const ifDoc = (f: () => void) => (hasDoc ? f : undefined);
  const commands: Command[] = [
    { id: "open", title: "Open PDF", description: "Open one or more PDF files, each in its own tab", icon: "folderOpen", tag: "Action", shortcut: "Ctrl O", run: () => openFiles("tabs") },
    { id: "add", title: hasDoc ? "Merge PDFs into this document" : "Merge PDFs", description: hasDoc ? "Append pages from more files to the current tab" : "Combine several files into one new tab", icon: "merge", tag: "Action", shortcut: "Ctrl ⇧ O", run: () => openFiles("merge") },
    { id: "close", title: "Close tab", description: "Close the current document", icon: "x", tag: "Action", shortcut: "Ctrl W", run: tabId ? () => closeTab(tabId) : undefined },
    { id: "next-tab", title: "Next tab", description: "Switch to the next open document", icon: "chevronRight", tag: "View", shortcut: "Ctrl Tab", run: tabState.tabs.length > 1 ? () => tabsDispatch({ type: "activate", id: neighbourTab(tabState, 1)! }) : undefined },
    { id: "save", title: "Save as new PDF", description: "Write the workspace to a new file", icon: "save", tag: "Action", shortcut: "Ctrl S", run: ifDoc(save) },
    { id: "wm", title: "Watermark Studio: add a text stamp", description: "Text, typeface, size, angle and opacity on every page", icon: "stamp", tag: "Tool", run: ifDoc(openWatermark) },
    { id: "clean", title: "Remove existing watermarks", description: "Scan for tagged stamps, watermark annotations and matching text", icon: "eraser", tag: "Tool", run: ifDoc(openClean) },
    { id: "v-lib", title: "Go to Library & Recent", description: "Home: open files and quick actions", icon: "library", tag: "View", run: () => navigate("library") },
    { id: "v-read", title: "Go to Document Workspace", description: "Read the whole document as one scroll", icon: "fileText", tag: "View", run: ifDoc(() => navigate("read")) },
    { id: "v-grid", title: "Go to Page Organizer", description: "Reorder, rotate, delete and merge pages", icon: "grid", tag: "View", run: ifDoc(() => navigate("grid")) },
    { id: "v-edit", title: "Go to Advanced Editor", description: "Edit text in place and add text boxes", icon: "edit", tag: "View", run: ifDoc(() => navigate("edit")) },
    { id: "rot-r", title: "Rotate selected pages right", description: "Page Organizer · R", icon: "rotateRight", tag: "Action", run: inGrid && selectedIds.length ? () => rotateSelected(90) : undefined },
    { id: "rot-l", title: "Rotate selected pages left", description: "Page Organizer · Shift R", icon: "rotateLeft", tag: "Action", run: inGrid && selectedIds.length ? () => rotateSelected(-90) : undefined },
    { id: "del", title: "Delete selected pages", description: "Page Organizer · Del", icon: "trash", tag: "Action", run: inGrid && selectedIds.length ? deleteSelected : undefined },
    { id: "undo", title: "Undo", description: "Step back one change", icon: "undo", tag: "Action", shortcut: "Ctrl Z", run: history.past.length ? () => dispatch({ type: "undo" }) : undefined },
    { id: "redo", title: "Redo", description: "Step forward one change", icon: "redo", tag: "Action", shortcut: "Ctrl Y", run: history.future.length ? () => dispatch({ type: "redo" }) : undefined },
    { id: "sanitize", title: sanitize ? "Turn off sanitize on save" : "Turn on sanitize on save", description: "Strip scripts, launch links, media and attachments when saving", icon: "shield", tag: "Action", run: () => setSanitize(!sanitize) },
    { id: "sidebar", title: sidebarCollapsed ? "Expand menu" : "Collapse menu", description: sidebarCollapsed ? "Show the full left menu" : "Shrink the left menu to icons for more room", icon: "panelLeft", tag: "View", shortcut: "Ctrl B", run: () => setSidebarCollapsed(!sidebarCollapsed) },
    { id: "t-light", title: "Use light theme", description: theme === "light" ? "Current theme" : "Switch the interface to light", icon: "sun", tag: "View", run: theme === "light" ? undefined : () => setTheme("light") },
    { id: "t-dark", title: "Use dark theme", description: theme === "dark" ? "Current theme" : "Switch the interface to dark", icon: "moon", tag: "View", run: theme === "dark" ? undefined : () => setTheme("dark") },
    { id: "t-system", title: "Match system theme", description: theme === "system" ? "Current theme" : "Follow the Windows light/dark setting", icon: "monitor", tag: "View", run: theme === "system" ? undefined : () => setTheme("system") },
    { id: "update-check", title: "Check for updates", description: "Look for a newer version of NovaPDF", icon: "download", tag: "Action", run: checkForUpdates },
    { id: "update-install", title: `Install NovaPDF ${update?.version ?? "update"}`, description: "Download the update and restart NovaPDF", icon: "download", tag: "Action", run: update ? installUpdate : undefined },
    { id: "s-hl", title: "Highlight text", description: "Not available yet", icon: "highlighter", tag: "Soon" },
    { id: "s-note", title: "Sticky note", description: "Not available yet", icon: "note", tag: "Soon" },
    { id: "s-ink", title: "Freehand ink", description: "Not available yet", icon: "ink", tag: "Soon" },
    { id: "s-redact", title: "Redact content", description: "Not available yet", icon: "redact", tag: "Soon" },
    { id: "s-form", title: "Form fields", description: "Not available yet", icon: "form", tag: "Soon" },
    { id: "s-sign", title: "Sign & protect", description: "Not available yet", icon: "shield", tag: "Soon" },
    { id: "s-ocr", title: "OCR & export", description: "Not available yet", icon: "scan", tag: "Soon" },
    { id: "s-compress", title: "Compress PDF", description: "Not available yet", icon: "compress", tag: "Soon" },
  ];

  return (
    <div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <Sidebar
        section={section}
        onNavigate={navigate}
        sanitize={sanitize}
        onSanitize={setSanitize}
        theme={theme}
        onTheme={setTheme}
        collapsed={sidebarCollapsed}
        onCollapsed={setSidebarCollapsed}
      />

      <div className="workspace">
        <header className="topbar">
          <div className="tabs">
            {tabState.tabs.length > 0 ? (
              <div className="tab-list" role="tablist" aria-label="Open documents">
                {tabState.tabs.map((t) => (
                  <DocTab
                    key={t.id}
                    tab={t}
                    docs={docs}
                    active={t.id === tabId}
                    onActivate={() => activateTab(t.id)}
                    onClose={() => closeTab(t.id)}
                  />
                ))}
              </div>
            ) : (
              <span className="doc-tab empty-tab">No document open</span>
            )}
            <button
              className="ghost icon-btn"
              onClick={() => openFiles("tabs")}
              title="Open PDF in a new tab (Ctrl+O)"
              aria-label="Open PDF in a new tab"
            >
              <Icon name="plus" />
            </button>
          </div>
          <div className="spacer" />
          <button className="search-box" onClick={() => setDialog({ kind: "palette" })} title="Search tools and actions (Ctrl+K)">
            <Icon name="search" size={16} />
            <span>Search tools and actions…</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div className="topbar-group">
            <button className="ghost icon-btn" onClick={() => dispatch({ type: "undo" })} disabled={history.past.length === 0} title="Undo (Ctrl+Z)" aria-label="Undo">
              <Icon name="undo" />
            </button>
            <button className="ghost icon-btn" onClick={() => dispatch({ type: "redo" })} disabled={history.future.length === 0} title="Redo (Ctrl+Y)" aria-label="Redo">
              <Icon name="redo" />
            </button>
          </div>
          <button className="secondary" onClick={() => openFiles("tabs")} title="Open PDF (Ctrl+O)">
            <Icon name="folderOpen" size={16} /> Open
          </button>
          <button className="primary" onClick={save} disabled={!hasDoc || !!busy} title="Save as (Ctrl+S)">
            <Icon name="save" size={16} /> Save as…
          </button>
        </header>

        {hasDoc && section === "read" && (
          <nav className="toolbar" aria-label="Reader tools">
            <button className="tool active" aria-pressed="true" title="Scroll and read">
              <Icon name="hand" /> Hand
            </button>
            <button className="tool" onClick={() => navigate("edit")} title="Select and edit text">
              <Icon name="pointer" /> Select
            </button>
            <div className="sep" />
            <button className="tool gold" disabled title="Coming soon">
              <Icon name="highlighter" /> Highlight
            </button>
            <button className="tool gold" disabled title="Coming soon">
              <Icon name="note" /> Note
            </button>
            <button className="tool gold" disabled title="Coming soon">
              <Icon name="ink" /> Ink
            </button>
            <div className="sep" />
            <button className="tool" onClick={() => navigate("edit")} title="Add or change text in the Advanced Editor">
              <Icon name="type" /> Add Text
            </button>
            <button className={`tool${ws.watermark ? " active" : ""}`} onClick={openWatermark} title="Watermark Studio">
              <Icon name="stamp" /> Stamp
            </button>
            <button className="tool" onClick={openClean} title="Remove existing watermarks">
              <Icon name="eraser" /> Remove stamps
            </button>
          </nav>
        )}

        {inGrid && (
          <nav className="toolbar" aria-label="Selection tools">
            <span className="group-label">Selection tools</span>
            <button className="tool" onClick={() => rotateSelected(-90)} disabled={!selectedIds.length} title="Rotate left (Shift+R)">
              <Icon name="rotateLeft" /> Rotate −90°
            </button>
            <button className="tool" onClick={() => rotateSelected(90)} disabled={!selectedIds.length} title="Rotate right (R)">
              <Icon name="rotateRight" /> Rotate +90°
            </button>
            <button className="tool" disabled title="Coming soon">
              <Icon name="copy" /> Duplicate
            </button>
            <button className="tool" disabled title="Coming soon">
              <Icon name="download" /> Extract to new PDF
            </button>
            <button className="tool" onClick={editSelected} disabled={!selectedIds.length} title="Edit page (Enter)">
              <Icon name="edit" /> Edit page
            </button>
            <button className="tool danger" onClick={deleteSelected} disabled={!selectedIds.length} title="Delete pages (Del)">
              <Icon name="trash" /> Delete{selectedIds.length ? ` (${selectedIds.length})` : ""}
            </button>
            <div className="spacer" />
            <label className="slider" title="Thumbnail size">
              <Icon name="grid" size={14} />
              <input type="range" min={110} max={320} value={thumbWidth} onChange={(e) => setThumbWidth(Number(e.target.value))} />
              <Icon name="grid" size={20} />
            </label>
          </nav>
        )}

        <main className="content">
          {soon ? (
            <ComingSoon section={section} />
          ) : section === "library" ? (
            <Library
              docs={docsInUse}
              pageCount={ws.pages.length}
              dirty={dirty}
              onOpen={() => openFiles("tabs")}
              onAdd={() => openFiles("merge")}
              onShow={navigate}
              onWatermark={openWatermark}
              onClean={openClean}
            />
          ) : !hasDoc ? (
            <div className="placeholder">
              <div className="placeholder-card">
                <span className="tile-icon big">
                  <Icon name={SECTION_INFO[section].icon} size={26} />
                </span>
                <h1>{SECTION_INFO[section].label}</h1>
                <p>Open a PDF to start. You can also drop PDF files anywhere in this window.</p>
                <button className="primary big" onClick={() => openFiles("tabs")}>
                  <Icon name="folderOpen" /> Open PDF…
                </button>
              </div>
            </div>
          ) : docMode ? (
            <DocumentView
              key={tabId}
              pages={ws.pages}
              docs={docs}
              links={ws.links}
              watermark={ws.watermark}
              fonts={fonts}
              mode={docMode}
              initialPageId={currentPageId}
              onCurrentPage={setCurrentPageId}
              onChangeEdits={changeEdits}
              onExitEdit={() => setSection("read")}
              onRemoveEverywhere={(text, docId) => setDialog({ kind: "clean", text, docIds: [docId] })}
              onWatermark={openWatermark}
              notify={notify}
            />
          ) : (
            <div className="organizer">
              <div className="organizer-head">
                <span className="tile-icon">
                  <Icon name="grid" />
                </span>
                <div className="organizer-title">
                  <h1>
                    <span className="name">{tab?.title ?? "Workspace"}</span>
                    <span className="chip">
                      {ws.pages.length} page{ws.pages.length === 1 ? "" : "s"}
                      {docsInUse.length > 1 ? ` · ${docsInUse.length} files` : ""}
                    </span>
                  </h1>
                  <p>
                    {selectedIds.length ? (
                      <>
                        <span className="dot gold" /> {selectedIds.length} page{selectedIds.length === 1 ? "" : "s"} selected
                        <span className="muted"> — ready for batch operations</span>
                      </>
                    ) : (
                      <span className="muted">Drag pages to reorder. Ctrl-click to add to the selection, Shift-click for a range.</span>
                    )}
                  </p>
                </div>
                <div className="spacer" />
                <div className="segmented" role="radiogroup" aria-label="Layout">
                  <button className="active" role="radio" aria-checked="true">
                    <Icon name="grid" size={15} /> Manual reorder
                  </button>
                  <button role="radio" aria-checked="false" disabled title="Coming soon">
                    <Icon name="book" size={15} /> Booklet flow
                  </button>
                </div>
              </div>
              <PageGrid
                key={tabId}
                pages={ws.pages}
                docs={docs}
                watermark={ws.watermark}
                selection={selection}
                thumbWidth={thumbWidth}
                onSelect={onSelect}
                onMove={(ids, overId) => dispatch({ type: "move", ids, overId })}
                onOpenEditor={(id) => openInDocument(id, "edit")}
              />
              {selectedIds.length > 0 && (
                <div className="selection-bar" role="region" aria-label="Selection">
                  <span className="dot primary" />
                  <span className="sel-count">
                    {selectedIds.length} page{selectedIds.length === 1 ? "" : "s"} selected
                  </span>
                  <span className="sel-meta">
                    Pages: {pageNumbers.length > 8 ? `${pageNumbers.slice(0, 8).join(", ")}…` : pageNumbers.join(", ")}
                  </span>
                  <div className="spacer" />
                  <button className="secondary" onClick={() => setSelection(new Set())}>
                    Deselect all
                  </button>
                  <button className="secondary" onClick={() => rotateSelected(90)}>
                    <Icon name="rotateRight" size={16} /> Rotate
                  </button>
                  <button className="primary" onClick={editSelected}>
                    <Icon name="edit" size={16} /> Edit page
                  </button>
                </div>
              )}
            </div>
          )}
        </main>

        <footer className="status">
          <span>
            {hasDoc && docMode && currentIndex >= 0 ? `Page ${currentIndex + 1} of ${ws.pages.length}` : `${ws.pages.length} page${ws.pages.length === 1 ? "" : "s"}`}
            {docsInUse.length > 1 ? ` · ${docsInUse.length} files` : ""}
          </span>
          {inGrid && <span>Selection: {selectedIds.length ? `${selectedIds.length} page${selectedIds.length === 1 ? "" : "s"}` : "none"}</span>}
          {hasDoc && previewPage && docMode && (
            <span>
              {(() => {
                const info = docs.get(previewPage.docId)?.pages[previewPage.pageIndex];
                return info ? paperName(info.width, info.height) : "";
              })()}
            </span>
          )}
          {ws.links.length > 0 && (
            <span title="Paragraphs edited across a page break">
              {ws.links.length} linked paragraph{ws.links.length === 1 ? "" : "s"}
            </span>
          )}
          {dirty && (
            <span className="dirty">
              <span className="dirty-dot" /> Unsaved changes
            </span>
          )}
          <div className="spacer" />
          {busy && (
            <span className="busy">
              <span className="spinner" /> {busy}
            </span>
          )}
          {sanitize && hasDoc && (
            <span className="secure" title="Risky actions, media and attachments are stripped on save">
              <Icon name="shield" size={12} /> Sanitize on
            </span>
          )}
          <span className="engine">PDFium · sandboxed</span>
        </footer>
      </div>

      {dialog?.kind === "watermark" && (
        <WatermarkDialog
          current={ws.watermark}
          fonts={fonts}
          previewPage={previewPage}
          pageCount={ws.pages.length}
          onClose={() => setDialog(null)}
          onApply={(w: Watermark | null) => {
            dispatch({ type: "setWatermark", watermark: w });
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "clean" && (
        <CleanDialog
          docs={dialog.docIds ? docsInUse.filter((d) => dialog.docIds!.includes(d.docId)) : docsInUse}
          initialText={dialog.text}
          onClose={() => setDialog(null)}
          onApply={applyClean}
        />
      )}
      {dialog?.kind === "palette" && <CommandPalette commands={commands} onClose={() => setDialog(null)} />}
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
      {dragging && (
        <div className="drop-overlay" role="status" aria-live="polite">
          <div className="drop-target">
            <span className="tile-icon big">
              <Icon name="upload" size={24} />
            </span>
            <b>Drop PDFs to open</b>
            <span>Each file opens in its own tab.</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** One tab in the top bar. Middle-click closes it, like a browser tab. */
function DocTab(props: {
  tab: Tab;
  docs: Map<number, DocInfo>;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const { tab, active } = props;
  const files = [...new Set(tab.history.present.pages.map((p) => p.docId))];
  const merged = files.filter((d) => d !== tab.docId).length;
  const tip = [tab.title, ...files.filter((d) => d !== tab.docId).map((d) => props.docs.get(d)?.fileName ?? "")]
    .filter(Boolean)
    .join("\n");
  return (
    <div
      className={`doc-tab${active ? " active" : ""}`}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      title={tip}
      onClick={props.onActivate}
      onAuxClick={(e) => e.button === 1 && props.onClose()}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && props.onActivate()}
    >
      <Icon name="fileText" size={16} />
      <span className="name">{tab.title}</span>
      {merged > 0 && <span className="count">+{merged}</span>}
      {isDirty(tab) && <span className="dirty-dot" title="Unsaved changes" />}
      <button
        className="tab-close"
        aria-label={`Close ${tab.title}`}
        title="Close (Ctrl+W)"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}
