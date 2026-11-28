import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";

import { api, errorMessage } from "./lib/api";
import type { OpenOutcome, PageEdits, RecentView, UpdateStatus, Watermark } from "./lib/types";
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
import {
  type AnnotStyle,
  DEFAULT_ANNOT_STYLE,
  READ_TOOLS,
  type ReadTool,
  SWATCHES,
  styleSlot,
} from "./components/AnnotationLayer";
import { WatermarkDialog } from "./components/WatermarkDialog";
import { CleanDialog, type ScanResult } from "./components/CleanDialog";
import { Toasts, type Toast } from "./components/Toasts";
import { PasswordDialog } from "./components/PasswordDialog";
import { Icon } from "./components/Icon";
import { useTheme } from "./lib/theme";
import { UPDATE_CHECK_INTERVAL_MS, useAutoUpdate } from "./lib/autoUpdate";
import { APP_NAME } from "./lib/brand";
import { Library, ModeSwitch, type Section, SettingsMenu, paperName } from "./components/Shell";
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
  const [readTool, setReadTool] = useState<ReadTool>("hand");
  const [annotStyle, setAnnotStyle] = useState<AnnotStyle>(DEFAULT_ANNOT_STYLE);
  const docMode = section === "read" || section === "edit" ? section : null;
  const [thumbWidth, setThumbWidth] = useState(170);
  const [sanitize, setSanitize] = useState(true);
  /** Recently opened files, from Rust; `null` until loaded. */
  const [recent, setRecent] = useState<RecentView | null>(null);
  const [theme, setTheme] = useTheme();
  /** Find in document: 0 while closed, otherwise a number that changes on each request. */
  const [findRequest, setFindRequest] = useState(0);
  const [fonts, setFonts] = useState<string[]>(["Helvetica", "Times", "Courier"]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** A file drag is over the window: show the drop overlay. */
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  /** Files waiting for a password, in the order they were opened. */
  const [locked, setLocked] = useState<{ id: number; fileName: string; mode: "tabs" | "merge" }[]>([]);
  const [unlock, setUnlock] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const notify = useCallback((message: string, kind: "info" | "error" = "info") => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, message, kind }]);
    // Errors stay until dismissed: they often say what to do next.
    if (kind === "info") setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  useEffect(() => {
    api.listFonts().then(setFonts).catch(() => {});
  }, []);

  /** The list is a convenience: if it cannot be read, the Library simply has none. */
  const refreshRecent = useCallback(() => {
    api.listRecent().then(setRecent, () => {});
  }, []);
  useEffect(refreshRecent, [refreshRecent]);
  /** Remove, clear and on/off hand back the new list; a failure is reported. */
  const changeRecent = (change: Promise<RecentView>) =>
    change.then(setRecent, (e) => notify(errorMessage(e), "error"));

  // ---------- updates ----------
  // Released builds check at launch and every few hours. With automatic updates on
  // (the default) a found version downloads in the background and installs when
  // the app quits. Off, the user installs it from the command palette.
  const [autoUpdate, setAutoUpdate] = useAutoUpdate();
  const autoUpdateRef = useRef(autoUpdate);
  autoUpdateRef.current = autoUpdate;
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  /** What was last announced, so a periodic check does not repeat it. */
  const announced = useRef<string | null>(null);

  /** Folds in a check result. `quiet` keeps a failed background download silent. */
  const takeUpdate = useCallback(
    async (found: UpdateStatus, quiet: boolean) => {
      if (!found.available) {
        setUpdate(null);
        return;
      }
      let s = found;
      if (autoUpdateRef.current && !s.downloaded) {
        try {
          await api.downloadUpdate();
          s = { ...s, downloaded: true };
        } catch (err) {
          if (!quiet) notify(`Couldn't download ${APP_NAME} ${s.version}: ${errorMessage(err)}`, "error");
        }
      }
      setUpdate(s);
      const key = `${s.version}:${s.downloaded}`;
      if (announced.current === key) return;
      announced.current = key;
      notify(
        s.downloaded
          ? `${APP_NAME} ${s.version} will install when you quit. To install it now, choose "Restart to install" in the command palette.`
          : `${APP_NAME} ${s.version} is available. Install it from the command palette.`,
      );
    },
    [notify],
  );

  // A failed or unconfigured background check stays quiet; unconfigured builds stop checking.
  useEffect(() => {
    const check = () =>
      api
        .checkUpdate()
        .then((s) => {
          if (!s.configured) clearInterval(timer);
          return takeUpdate(s, true);
        })
        .catch(() => {});
    const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
    void check();
    return () => clearInterval(timer);
  }, [takeUpdate]);

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
      // Protected files wait for their password; the rest open now.
      const waiting = outcomes.filter((o) => o.locked != null && !o.error);
      if (waiting.length) setLocked((q) => [...q, ...waiting.map((o) => ({ id: o.locked!, fileName: o.fileName, mode }))]);
      const opened: DocInfo[] = outcomes.flatMap((o) => (o.document ? [o.document] : []));
      // Rust has put opened files on the recent list, and taken off any that were gone.
      refreshRecent();
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
    [notify, refreshRecent],
  );

  /** Sends the password for the first waiting file. A wrong one keeps the dialog open. */
  const submitPassword = async (password: string) => {
    const file = locked[0];
    if (!file) return;
    setUnlock({ busy: true, error: null });
    try {
      const outcome = await api.unlockFile(file.id, password);
      if (outcome.locked != null && !outcome.document) {
        setUnlock({ busy: false, error: outcome.error ?? "Wrong password. Try again." });
        return;
      }
      setLocked((q) => q.slice(1));
      setUnlock({ busy: false, error: null });
      addOutcomes([outcome], file.mode);
    } catch (e) {
      setLocked((q) => q.slice(1));
      setUnlock({ busy: false, error: null });
      notify(`${file.fileName}: ${errorMessage(e)}`, "error");
    }
  };
  const cancelPassword = () => {
    const file = locked[0];
    if (!file) return;
    api.discardLocked(file.id).catch(() => {});
    setLocked((q) => q.slice(1));
    setUnlock({ busy: false, error: null });
  };

  const openRecent = async (id: number) => {
    try {
      setBusy("Opening…");
      addOutcomes([await api.openRecent(id)], "tabs");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

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
        const ok = await ask(`${what}. Quit anyway?`, { title: APP_NAME, kind: "warning" });
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
    if (isDirty(t) && !(await ask(`${t.title} has unsaved changes. Close it anyway?`, { title: APP_NAME, kind: "warning" })))
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

  const checkForUpdates = async () => {
    let s: UpdateStatus;
    try {
      s = await api.checkUpdate();
    } catch (err) {
      notify(`Couldn't check for updates: ${errorMessage(err)}`, "error");
      return;
    }
    if (!s.configured) notify(`This build can't update itself. Download new versions from the ${APP_NAME} website.`);
    else if (!s.available) notify(`${APP_NAME} is up to date (version ${s.currentVersion}).`);
    announced.current = null; // a check the user asked for always says what it found
    await takeUpdate(s, false);
  };

  const toggleAutoUpdate = async () => {
    const on = !autoUpdate;
    setAutoUpdate(on);
    autoUpdateRef.current = on;
    if (on) {
      notify(`Automatic updates are on. New versions download in the background and install when ${APP_NAME} quits.`);
      if (update && !update.downloaded) await takeUpdate(update, false);
    } else {
      notify("Automatic updates are off. Check for updates from the command palette.");
      if (update?.downloaded) {
        await api.discardUpdate().catch(() => {});
        setUpdate({ ...update, downloaded: false });
        announced.current = null;
      }
    }
  };

  /** Installing restarts the app, so unsaved work is confirmed first, as on quit. */
  const installUpdate = async () => {
    if (busy) return;
    const unsaved = stateRef.current.tabs.filter(isDirty).length;
    if (unsaved) {
      const what = unsaved === 1 ? "You have unsaved changes" : `${unsaved} documents have unsaved changes`;
      if (!(await ask(`${what}. ${APP_NAME} restarts to install the update. Continue?`, { title: APP_NAME, kind: "warning" })))
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
        notify(saved.protected ? `Saved ${saved.path}. It opens with the same password.` : `Saved ${saved.path}`);
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
      // A dialog (including the password prompt) has the keyboard to itself.
      if (dialog || locked.length) return;
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
      } else if (mod && e.key.toLowerCase() === "f") {
        // Always taken, so the WebView's own find box never opens.
        e.preventDefault();
        openFind();
      } else if (mod && e.key === "Tab") {
        e.preventDefault();
        const next = neighbourTab(tabState, e.shiftKey ? -1 : 1);
        if (next) tabsDispatch({ type: "activate", id: next });
      } else if (typing || target.isContentEditable) {
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

  const openWatermark = () => setDialog({ kind: "watermark" });
  const openClean = () => setDialog({ kind: "clean", text: "", docIds: null });
  /** Find works on the text of the file, so it lives in the read view. */
  const openFind = () => {
    if (!hasDoc) return;
    if (section !== "read") navigate("read");
    setFindRequest((n) => n + 1);
  };
  const inGrid = section === "grid" && hasDoc;
  const ifDoc = (f: () => void) => (hasDoc ? f : undefined);
  const commands: Command[] = [
    { id: "open", title: "Open PDF", description: "Open one or more PDF files, each in its own tab", icon: "folderOpen", tag: "Action", shortcut: "Ctrl O", run: () => openFiles("tabs") },
    { id: "add", title: hasDoc ? "Merge PDFs into this document" : "Merge PDFs", description: hasDoc ? "Append pages from more files to the current tab" : "Combine several files into one new tab", icon: "merge", tag: "Action", shortcut: "Ctrl ⇧ O", run: () => openFiles("merge") },
    { id: "close", title: "Close tab", description: "Close the current document", icon: "x", tag: "Action", shortcut: "Ctrl W", run: tabId ? () => closeTab(tabId) : undefined },
    { id: "next-tab", title: "Next tab", description: "Switch to the next open document", icon: "chevronRight", tag: "View", shortcut: "Ctrl Tab", run: tabState.tabs.length > 1 ? () => tabsDispatch({ type: "activate", id: neighbourTab(tabState, 1)! }) : undefined },
    { id: "save", title: "Save as new PDF", description: "Write the workspace to a new file", icon: "save", tag: "Action", shortcut: "Ctrl S", run: ifDoc(save) },
    { id: "wm", title: "Add or change the watermark", description: "Text on every page: typeface, size, angle and opacity", icon: "stamp", tag: "Tool", run: ifDoc(openWatermark) },
    { id: "clean", title: "Remove existing watermarks", description: "Scan for tagged watermarks, watermark annotations and matching text", icon: "eraser", tag: "Tool", run: ifDoc(openClean) },
    { id: "v-lib", title: "Go to the Library", description: "Home: open documents and quick actions", icon: "library", tag: "View", run: () => navigate("library") },
    { id: "v-read", title: "Read", description: "Read and comment on the document", icon: "fileText", tag: "View", run: ifDoc(() => navigate("read")) },
    { id: "v-grid", title: "Organize pages", description: "Reorder, rotate, delete and merge pages", icon: "grid", tag: "View", run: ifDoc(() => navigate("grid")) },
    { id: "v-edit", title: "Edit", description: "Change text in place and add text boxes", icon: "edit", tag: "View", run: ifDoc(() => navigate("edit")) },
    { id: "rot-r", title: "Rotate selected pages right", description: "Organize view · R", icon: "rotateRight", tag: "Action", run: inGrid && selectedIds.length ? () => rotateSelected(90) : undefined },
    { id: "rot-l", title: "Rotate selected pages left", description: "Organize view · Shift R", icon: "rotateLeft", tag: "Action", run: inGrid && selectedIds.length ? () => rotateSelected(-90) : undefined },
    { id: "del", title: "Delete selected pages", description: "Organize view · Del", icon: "trash", tag: "Action", run: inGrid && selectedIds.length ? deleteSelected : undefined },
    { id: "undo", title: "Undo", description: "Step back one change", icon: "undo", tag: "Action", shortcut: "Ctrl Z", run: history.past.length ? () => dispatch({ type: "undo" }) : undefined },
    { id: "redo", title: "Redo", description: "Step forward one change", icon: "redo", tag: "Action", shortcut: "Ctrl Y", run: history.future.length ? () => dispatch({ type: "redo" }) : undefined },
    { id: "sanitize", title: sanitize ? "Turn off sanitize on save" : "Turn on sanitize on save", description: "Strip scripts, launch links, media and attachments when saving", icon: "shield", tag: "Action", run: () => setSanitize(!sanitize) },
    { id: "find", title: "Find in document", description: "Search the text of the document", icon: "search", tag: "Action", shortcut: "Ctrl F", run: ifDoc(openFind) },
    { id: "t-light", title: "Use light theme", description: theme === "light" ? "Current theme" : "Switch the interface to light", icon: "sun", tag: "View", run: theme === "light" ? undefined : () => setTheme("light") },
    { id: "t-dark", title: "Use dark theme", description: theme === "dark" ? "Current theme" : "Switch the interface to dark", icon: "moon", tag: "View", run: theme === "dark" ? undefined : () => setTheme("dark") },
    { id: "t-system", title: "Match system theme", description: theme === "system" ? "Current theme" : "Follow the Windows light/dark setting", icon: "monitor", tag: "View", run: theme === "system" ? undefined : () => setTheme("system") },
    { id: "update-check", title: "Check for updates", description: `Look for a newer version of ${APP_NAME}`, icon: "download", tag: "Action", run: checkForUpdates },
    { id: "update-install", title: update?.downloaded ? `Restart to install ${APP_NAME} ${update.version}` : `Install ${APP_NAME} ${update?.version ?? "update"}`, description: update?.downloaded ? `Install the downloaded update now instead of when ${APP_NAME} quits` : `Download the update and restart ${APP_NAME}`, icon: "download", tag: "Action", run: update ? installUpdate : undefined },
    { id: "update-auto", title: autoUpdate ? "Turn off automatic updates" : "Turn on automatic updates", description: autoUpdate ? "Check for and install updates yourself from this palette" : `Download updates in the background and install them when ${APP_NAME} quits`, icon: "download", tag: "Action", run: toggleAutoUpdate },
  ];

  return (
    <div className="app">
      <div className="workspace">
        <header className="topbar">
          <button
            className={`brand-mark${section === "library" ? " current" : ""}`}
            onClick={() => navigate("library")}
            aria-label="Library"
            aria-current={section === "library" ? "page" : undefined}
            title={`${APP_NAME} library: open documents and quick actions`}
          >
            <Icon name="book" size={16} />
          </button>
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
          {tab && <ModeSwitch section={section} onNavigate={navigate} />}
          <div className="spacer" />
          <button className="search-box" onClick={() => setDialog({ kind: "palette" })} title="Run a command by name (Ctrl+K)">
            <Icon name="zap" size={16} />
            <span>Commands</span>
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
          <SettingsMenu
            sanitize={sanitize}
            onSanitize={setSanitize}
            recentEnabled={recent?.enabled ?? true}
            onRecentEnabled={(on) => changeRecent(api.setRecentEnabled(on))}
            theme={theme}
            onTheme={setTheme}
          />
          <button className="secondary" onClick={() => openFiles("tabs")} title="Open PDF (Ctrl+O)">
            <Icon name="folderOpen" size={16} /> Open
          </button>
          <button className="primary" onClick={save} disabled={!hasDoc || !!busy} title="Save as (Ctrl+S)">
            <Icon name="save" size={16} /> Save as…
          </button>
        </header>

        {hasDoc && section === "read" && (
          <nav className="toolbar" aria-label="Reader tools">
            {READ_TOOLS.map((t, i) => (
              <Fragment key={t.key}>
                {i === 2 && <div className="sep" />}
                <button
                  className={`tool${readTool === t.key ? " active" : ""}`}
                  aria-pressed={readTool === t.key}
                  onClick={() => setReadTool(t.key)}
                  title={t.title}
                >
                  <Icon name={t.icon} /> {t.label}
                </button>
              </Fragment>
            ))}
            {(readTool === "highlight" || readTool === "note" || readTool === "ink") && (
              <span className="swatches" role="radiogroup" aria-label="Colour">
                {readTool === "ink" && (
                  <button
                    className={`tool small${annotStyle.marker ? " active" : ""}`}
                    aria-pressed={annotStyle.marker}
                    onClick={() => setAnnotStyle({ ...annotStyle, marker: !annotStyle.marker })}
                    title="Draw a wide, see-through marker line instead of a pen line"
                  >
                    Marker
                  </button>
                )}
                {SWATCHES.map((c) => {
                  const slot = styleSlot(readTool, annotStyle.marker);
                  const on = annotStyle[slot].join() === c.rgb.join();
                  return (
                    <button
                      key={c.name}
                      role="radio"
                      aria-checked={on}
                      aria-label={c.name}
                      title={c.name}
                      className={`swatch${on ? " on" : ""}`}
                      style={{ background: `rgb(${c.rgb.join(",")})` }}
                      onClick={() => setAnnotStyle({ ...annotStyle, [slot]: c.rgb })}
                    />
                  );
                })}
              </span>
            )}
            <div className="sep" />
            <button className={`tool${ws.watermark ? " active" : ""}`} onClick={openWatermark} title="Add or change the watermark">
              <Icon name="stamp" /> Watermark
            </button>
            <button className="tool" onClick={openClean} title="Find and remove watermarks already in the file">
              <Icon name="eraser" /> Remove watermarks
            </button>
            <div className="spacer" />
            <button className={`tool${findRequest ? " active" : ""}`} onClick={openFind} aria-pressed={findRequest > 0} title="Find in document (Ctrl+F)">
              <Icon name="search" /> Find
            </button>
          </nav>
        )}

        {inGrid && (
          <nav className="toolbar" aria-label="Selection tools">
            <button className="tool" onClick={() => rotateSelected(-90)} disabled={!selectedIds.length} title="Rotate left (Shift+R)">
              <Icon name="rotateLeft" /> Rotate −90°
            </button>
            <button className="tool" onClick={() => rotateSelected(90)} disabled={!selectedIds.length} title="Rotate right (R)">
              <Icon name="rotateRight" /> Rotate +90°
            </button>
            <button className="tool" onClick={editSelected} disabled={!selectedIds.length} title="Edit page (Enter)">
              <Icon name="edit" /> Edit page
            </button>
            <button className="tool danger" onClick={deleteSelected} disabled={!selectedIds.length} title="Delete pages (Del)">
              <Icon name="trash" /> Delete{selectedIds.length ? ` (${selectedIds.length})` : ""}
            </button>
            <div className="sep" />
            <button className="tool" onClick={() => setSelection(new Set())} disabled={!selectedIds.length} title="Clear the selection (Esc)">
              Deselect all
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
          {section === "library" ? (
            <Library
              docs={docsInUse}
              recent={recent}
              onOpenRecent={openRecent}
              onRemoveRecent={(id) => changeRecent(api.removeRecent(id))}
              onClearRecent={() => changeRecent(api.clearRecent())}
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
                  <Icon name="fileText" size={26} />
                </span>
                <h1>No pages to show</h1>
                <p>Open a PDF, or drop PDF files anywhere in this window.</p>
                <button className="primary big" onClick={() => openFiles("tabs")}>
                  <Icon name="folderOpen" /> Open PDF…
                </button>
              </div>
            </div>
          ) : docMode ? (
            <DocumentView
              key={tabId}
              readTool={readTool}
              annotStyle={annotStyle}
              onReadTool={setReadTool}
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
              findRequest={findRequest}
              onFindClose={() => setFindRequest(0)}
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
                  <p className="muted">Drag pages to reorder. Ctrl-click to add to the selection, Shift-click for a range.</p>
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
      {locked.length > 0 && (
        <PasswordDialog
          key={locked[0].id}
          fileName={locked[0].fileName}
          error={unlock.error}
          busy={unlock.busy}
          waiting={locked.length - 1}
          onSubmit={submitPassword}
          onCancel={cancelPassword}
        />
      )}
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
      {props.docs.get(tab.docId)?.protected && (
        <span className="tab-lock" title="Password-protected. A save keeps the password." aria-label="Password-protected">
          <Icon name="lock" size={12} />
        </span>
      )}
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
