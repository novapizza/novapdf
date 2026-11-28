import { type ReactNode, useEffect, useRef, useState } from "react";
import type { DocInfo } from "../state/workspace";
import type { RecentView } from "../lib/types";
import { whenOpened } from "../lib/recent";
import type { ThemePref } from "../lib/theme";
import { Icon, type IconName } from "./Icon";

/** What the window shows: the Library (home), or one of three views of the document in front. */
export type Section = "library" | "read" | "grid" | "edit";
export type DocMode = Exclude<Section, "library">;

const MODES: { key: DocMode; label: string; title: string }[] = [
  { key: "read", label: "Read", title: "Read and comment" },
  { key: "grid", label: "Organize", title: "Reorder, rotate and delete pages" },
  { key: "edit", label: "Edit", title: "Change text and add text boxes" },
];

/** Read | Organize | Edit: the three views of the open document. None is checked in the Library. */
export function ModeSwitch(props: { section: Section; onNavigate: (s: Section) => void }) {
  return (
    <div className="segmented mode-switch" role="radiogroup" aria-label="View">
      {MODES.map((m) => (
        <button
          key={m.key}
          role="radio"
          aria-checked={props.section === m.key}
          className={props.section === m.key ? "active" : undefined}
          title={m.title}
          onClick={() => props.onNavigate(m.key)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

const THEMES: { key: ThemePref; label: string }[] = [
  { key: "system", label: "System" },
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
];

/** The settings button in the top bar and its popover: sanitize on save, and the theme. */
export function SettingsMenu(props: {
  sanitize: boolean;
  onSanitize: (v: boolean) => void;
  /** Whether opened files are remembered in the Library's recent list. */
  recentEnabled: boolean;
  onRecentEnabled: (v: boolean) => void;
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Open: a click outside or Esc closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="settings" ref={box}>
      <button
        className={`ghost icon-btn${open ? " active" : ""}`}
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Settings"
        onClick={() => setOpen(!open)}
      >
        <Icon name="sliders" />
      </button>
      {open && (
        <div className="settings-pop" role="dialog" aria-label="Settings">
          <label className="settings-row" title="On save, remove links that run JavaScript or launch files, and embedded media and attachments">
            <span>
              <span className="settings-title">Sanitize on save</span>
              <span className="settings-sub">Remove scripts, media and attachments</span>
            </span>
            <input
              type="checkbox"
              className="switch"
              aria-label="Sanitize on save"
              checked={props.sanitize}
              onChange={(e) => props.onSanitize(e.target.checked)}
            />
          </label>
          <label className="settings-row" title="Keep a list of files you opened in the Library. Turning it off also clears the list.">
            <span>
              <span className="settings-title">Remember recent files</span>
              <span className="settings-sub">Shown in the Library. Off clears the list</span>
            </span>
            <input
              type="checkbox"
              className="switch"
              aria-label="Remember recent files"
              checked={props.recentEnabled}
              onChange={(e) => props.onRecentEnabled(e.target.checked)}
            />
          </label>
          <div className="settings-row">
            <span className="settings-title">Theme</span>
            <div className="segmented" role="radiogroup" aria-label="Theme">
              {THEMES.map((t) => (
                <button
                  key={t.key}
                  role="radio"
                  aria-checked={props.theme === t.key}
                  className={props.theme === t.key ? "active" : undefined}
                  onClick={() => props.onTheme(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <p className="settings-note">Files are processed on this computer. Nothing is uploaded.</p>
        </div>
      )}
    </div>
  );
}

/** Empty state used inside a pane (no data yet / not built). */
export function EmptyNote(props: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty-note">
      <Icon name={props.icon} size={20} />
      <b>{props.title}</b>
      {props.children && <span>{props.children}</span>}
    </div>
  );
}

interface QuickAction {
  icon: IconName;
  title: string;
  sub: string;
  run?: () => void;
}

export function Library(props: {
  docs: DocInfo[];
  /** The recent files list; `null` until it has loaded. */
  recent: RecentView | null;
  onOpenRecent: (id: number) => void;
  onRemoveRecent: (id: number) => void;
  onClearRecent: () => void;
  pageCount: number;
  dirty: boolean;
  onOpen: () => void;
  onAdd: () => void;
  onShow: (s: Section) => void;
  onWatermark: () => void;
  onClean: () => void;
}) {
  const hasDoc = props.docs.length > 0;
  const actions: QuickAction[] = [
    { icon: "merge", title: "Merge PDFs", sub: "Combine files into one document", run: props.onAdd },
    { icon: "stamp", title: "Add watermark", sub: "Put text on every page", run: hasDoc ? props.onWatermark : undefined },
    { icon: "eraser", title: "Remove watermarks", sub: "Find and remove existing ones", run: hasDoc ? props.onClean : undefined },
  ];

  return (
    <div className="library">
      <div className="library-inner">
        <header className="hero">
          <div>
            <h1>Library</h1>
            <p>{hasDoc ? `${props.docs.length} open` : "Nothing open"}</p>
          </div>
          <div className="hero-actions">
            <button className="primary big" onClick={props.onOpen}>
              <Icon name="folderOpen" /> Open PDF…
            </button>
            <span className="hint">
              <kbd>Ctrl</kbd> <kbd>O</kbd> open · <kbd>Ctrl</kbd> <kbd>K</kbd> commands
            </span>
          </div>
        </header>

        <section>
          <div className="section-title">
            <h2>Open documents</h2>
            {hasDoc && (
              <span className="muted">
                {props.pageCount} page{props.pageCount === 1 ? "" : "s"} from {props.docs.length} file
                {props.docs.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {hasDoc ? (
            <div className="doc-cards">
              {props.docs.map((d) => (
                <article key={d.docId} className="doc-card">
                  <div className="doc-card-top">
                    <span className="tile-icon">
                      <Icon name="fileText" size={18} />
                    </span>
                    {props.dirty && <span className="badge gold">Unsaved</span>}
                  </div>
                  <h3 title={d.fileName}>{d.fileName}</h3>
                  <div className="chips">
                    <span className="chip">
                      {d.pages.length} page{d.pages.length === 1 ? "" : "s"}
                    </span>
                    {d.pages[0] && <span className="chip">{paperName(d.pages[0].width, d.pages[0].height)}</span>}
                  </div>
                  <div className="doc-card-foot">
                    <button className="tertiary" onClick={() => props.onShow("grid")}>
                      Organize
                    </button>
                    <button className="secondary" onClick={() => props.onShow("read")}>
                      Open
                    </button>
                  </div>
                </article>
              ))}
              <button className="doc-card add" onClick={props.onAdd}>
                <span className="tile-icon">
                  <Icon name="plus" size={18} />
                </span>
                <b>Append PDFs</b>
                <span>Add pages from more files</span>
              </button>
            </div>
          ) : (
            <button className="dropzone" onClick={props.onOpen}>
              <span className="tile-icon big">
                <Icon name="upload" size={24} />
              </span>
              <b>Open a PDF to start</b>
              <span>Click to choose files, or drop PDFs anywhere in this window.</span>
            </button>
          )}
        </section>

        {props.recent?.enabled && (
          <section aria-labelledby="recent-heading">
            <div className="section-title">
              <h2 id="recent-heading">Recent</h2>
              <div className="spacer" />
              {props.recent.items.length > 0 && (
                <button className="link" onClick={props.onClearRecent}>
                  Clear list
                </button>
              )}
            </div>
            {props.recent.items.length > 0 ? (
              <ul className="recent-list">
                {props.recent.items.map((r) => (
                  <li key={r.id} className="recent-row">
                    <button className="recent-open" onClick={() => props.onOpenRecent(r.id)} title={`Open ${r.fileName}`}>
                      <Icon name="fileText" size={18} />
                      <span className="recent-name">{r.fileName}</span>
                      <span className="recent-folder" title={r.folder}>
                        {r.folder}
                      </span>
                      <span className="recent-when">{whenOpened(r.openedAt)}</span>
                    </button>
                    <button
                      className="ghost icon-btn recent-remove"
                      onClick={() => props.onRemoveRecent(r.id)}
                      aria-label={`Remove ${r.fileName} from the list`}
                      title="Remove from the list"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyNote icon="clock" title="No recent files">
                Files you open will be listed here.
              </EmptyNote>
            )}
          </section>
        )}

        <section>
          <div className="section-label">
            <span>Quick actions</span>
          </div>
          <div className="quick-grid">
            {actions.map((a) => (
              <button key={a.title} className="quick-card" onClick={a.run} disabled={!a.run}>
                <span className="tile-icon">
                  <Icon name={a.icon} size={18} />
                </span>
                {a.run && <Icon name="arrowRight" size={14} className="quick-arrow" />}
                <b>{a.title}</b>
                <span>{a.sub}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/** "A4 Portrait", "Letter Landscape", or the size in points. */
export function paperName(w: number, h: number): string {
  const [a, b] = w < h ? [w, h] : [h, w];
  const near = (x: number, y: number) => Math.abs(x - y) < 4;
  const name =
    near(a, 595) && near(b, 842)
      ? "A4"
      : near(a, 612) && near(b, 792)
        ? "Letter"
        : near(a, 612) && near(b, 1008)
          ? "Legal"
          : near(a, 420) && near(b, 595)
            ? "A5"
            : near(a, 842) && near(b, 1191)
              ? "A3"
              : `${Math.round(w)}×${Math.round(h)} pt`;
  return `${name} ${w > h ? "Landscape" : "Portrait"}`;
}
