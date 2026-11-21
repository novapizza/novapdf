import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";

import { api, errorMessage } from "./lib/api";
import type { OpenOutcome, PageEdits, Watermark } from "./lib/types";
import { editsAreEmpty } from "./lib/types";
import {
  type DocInfo,
  type ParagraphLink,
  initialHistory,
  pagesFromDoc,
  reducer,
} from "./state/workspace";
import { PageGrid } from "./components/PageGrid";
import { DocumentView } from "./components/DocumentView";
import { WatermarkDialog } from "./components/WatermarkDialog";
import { CleanDialog, type ScanResult } from "./components/CleanDialog";
import { Toasts, type Toast } from "./components/Toasts";
import { Icon } from "./components/Icon";
import { useTheme } from "./lib/theme";
import { ComingSoon, Library, type Section, SECTION_INFO, Sidebar, paperName } from "./components/Shell";
import { type Command, CommandPalette } from "./components/CommandPalette";
import "./App.css";

/** Read and Edit show the whole document as one scroll; Organize ("grid") is the page grid. */
type Dialog = null | { kind: "watermark" } | { kind: "clean"; text: string; docIds: number[] | null } | { kind: "palette" };

let toastId = 0;

export default function App() {
  const [history, dispatch] = useReducer(reducer, initialHistory);
  const ws = history.present;
  const dirty = history.present !== history.saved && ws.pages.length > 0;

  const [docs, setDocs] = useState<Map<number, DocInfo>>(new Map());
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("library");
  const docMode = section === "read" || section === "edit" ? section : null;
  /** Page shown in the document view (kept when switching views). */
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const [thumbWidth, setThumbWidth] = useState(170);
  const [sanitize, setSanitize] = useState(true);
  const [theme, setTheme] = useTheme();
  const [fonts, setFonts] = useState<string[]>(["Helvetica", "Times", "Courier"]);
  const [toasts, setToasts] = useState<Toast[]>([]);
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

  // Keep refs for event handlers registered once.
  const stateRef = useRef({ ws, dirty, docs });
  stateRef.current = { ws, dirty, docs };
  const drops = useRef({ pending: 0, startedEmpty: false, opened: false, chain: Promise.resolve() });

  // ---------- opening ----------

  const addOutcomes = useCallback(
    (outcomes: OpenOutcome[], mode: "replace" | "append") => {
      for (const o of outcomes) if (o.error) notify(`${o.fileName}: ${o.error}`, "error");
      const opened: DocInfo[] = outcomes.flatMap((o) => (o.document ? [o.document] : []));
      if (opened.length === 0) return;
      const items = opened.flatMap(pagesFromDoc);
      if (mode === "replace") {
        for (const id of stateRef.current.docs.keys()) api.closeDocument(id).catch(() => {});
        setDocs(new Map(opened.map((d) => [d.docId, d])));
        dispatch({ type: "reset", pages: items });
        setSelection(new Set());
        setCurrentPageId(items[0]?.id ?? null);
        setSection("read");
      } else {
        setDocs((prev) => new Map([...prev, ...opened.map((d) => [d.docId, d] as const)]));
        dispatch({ type: "append", pages: items });
      }
      const pages = items.length;
      notify(`Opened ${opened.length === 1 ? opened[0].fileName : `${opened.length} files`} (${pages} page${pages === 1 ? "" : "s"})`);
    },
    [notify],
  );

  const confirmDiscard = async () =>
    !stateRef.current.dirty ||
    (await ask("You have unsaved changes. Discard them?", { title: "NovaPDF", kind: "warning" }));

  const openFiles = async (mode: "replace" | "append") => {
    if (mode === "replace" && !(await confirmDiscard())) return;
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
    // Drops that overlap (a second drop while the first is still opening) form one
    // burst. Results are applied in drop order, and only the first document opened
    // into an empty workspace replaces it; everything after that appends. Deciding
    // this when each drop arrives would let a later drop "replace" an earlier one.
    const un = listen<string[]>("files-dropped", (e) => {
      const d = drops.current;
      if (d.pending === 0) {
        d.startedEmpty = stateRef.current.ws.pages.length === 0;
        d.opened = false;
      }
      d.pending += 1;
      setBusy("Opening…");
      const opening = api.openDropped(e.payload);
      d.chain = d.chain.then(async () => {
        try {
          const outcomes = await opening;
          const mode = d.startedEmpty && !d.opened ? "replace" : "append";
          if (outcomes.some((o) => o.document)) d.opened = true;
          addOutcomes(outcomes, mode);
        } catch (err) {
          notify(errorMessage(err), "error");
        } finally {
          d.pending -= 1;
          if (d.pending === 0) setBusy(null);
        }
      });
    });
    return () => {
      un.then((f) => f());
    };
  }, [addOutcomes, notify]);

  // Unsaved-changes guard on window close.
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested(async (event) => {
      if (stateRef.current.dirty) {
        const ok = await ask("You have unsaved changes. Quit anyway?", { title: "NovaPDF", kind: "warning" });
        if (!ok) event.preventDefault();
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // ---------- saving ----------

  const save = async () => {
    if (ws.pages.length === 0 || busy) return;
    const first = docs.get(ws.pages[0].docId)?.fileName ?? "document.pdf";
    const suggestedName = first.replace(/\.pdf$/i, "") + "-edited.pdf";
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
        dispatch({ type: "markSaved" });
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
    [],
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
        openFiles(e.shiftKey ? "append" : "replace");
      } else if (typing) {
        return;
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
  const firstDoc = docsInUse[0];
  const soon = !!SECTION_INFO[section].soon;

  const openWatermark = () => setDialog({ kind: "watermark" });
  const openClean = () => setDialog({ kind: "clean", text: "", docIds: null });
  const inGrid = section === "grid" && hasDoc;
  const pageNumbers = selectedIds.map((id) => ws.pages.findIndex((p) => p.id === id) + 1);

  const ifDoc = (f: () => void) => (hasDoc ? f : undefined);
  const commands: Command[] = [
    { id: "open", title: "Open PDF", description: "Replace the workspace with one or more PDF files", icon: "folderOpen", tag: "Action", shortcut: "Ctrl O", run: () => openFiles("replace") },
    { id: "add", title: "Add PDFs to merge", description: "Append pages from more files to this workspace", icon: "merge", tag: "Action", shortcut: "Ctrl ⇧ O", run: ifDoc(() => openFiles("append")) },
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
    { id: "t-light", title: "Use light theme", description: theme === "light" ? "Current theme" : "Switch the interface to light", icon: "sun", tag: "View", run: theme === "light" ? undefined : () => setTheme("light") },
    { id: "t-dark", title: "Use dark theme", description: theme === "dark" ? "Current theme" : "Switch the interface to dark", icon: "moon", tag: "View", run: theme === "dark" ? undefined : () => setTheme("dark") },
    { id: "t-system", title: "Match system theme", description: theme === "system" ? "Current theme" : "Follow the Windows light/dark setting", icon: "monitor", tag: "View", run: theme === "system" ? undefined : () => setTheme("system") },
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
    <div className="app">
      <Sidebar section={section} onNavigate={navigate} sanitize={sanitize} onSanitize={setSanitize} theme={theme} onTheme={setTheme} />

      <div className="workspace">
        <header className="topbar">
          <div className="tabs">
            {firstDoc ? (
              <div className="doc-tab" title={docsInUse.map((d) => d.fileName).join("\n")}>
                <Icon name="fileText" size={16} />
                <span className="name">{firstDoc.fileName}</span>
                {docsInUse.length > 1 && <span className="count">+{docsInUse.length - 1}</span>}
                {dirty && <span className="dirty-dot" title="Unsaved changes" />}
              </div>
            ) : (
              <span className="doc-tab empty-tab">No document open</span>
            )}
            <button
              className="ghost icon-btn"
              onClick={() => openFiles(hasDoc ? "append" : "replace")}
              title={hasDoc ? "Add PDFs to merge (Ctrl+Shift+O)" : "Open PDF (Ctrl+O)"}
              aria-label={hasDoc ? "Add PDFs" : "Open PDF"}
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
          <button className="secondary" onClick={() => openFiles("replace")} title="Open PDF (Ctrl+O)">
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
              onOpen={() => openFiles("replace")}
              onAdd={() => openFiles("append")}
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
                <button className="primary big" onClick={() => openFiles("replace")}>
                  <Icon name="folderOpen" /> Open PDF…
                </button>
              </div>
            </div>
          ) : docMode ? (
            <DocumentView
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
                    <span className="name">{firstDoc?.fileName ?? "Workspace"}</span>
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
    </div>
  );
}
