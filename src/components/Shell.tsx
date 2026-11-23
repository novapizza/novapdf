import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DocInfo } from "../state/workspace";
import type { ThemePref } from "../lib/theme";
import { Icon, type IconName } from "./Icon";

/** Top-level areas of the app, shown in the sidebar. */
export type Section = "library" | "read" | "grid" | "edit" | "sign" | "ocr" | "cloud" | "vault";

interface NavItem {
  key: Section;
  label: string;
  icon: IconName;
  /** Not built yet: shows an empty placeholder. */
  soon?: boolean;
}

const WORKSPACES: NavItem[] = [
  { key: "library", label: "Library & Recent", icon: "library" },
  { key: "read", label: "Document Workspace", icon: "fileText" },
  { key: "grid", label: "Page Organizer", icon: "grid" },
  { key: "edit", label: "Advanced Editor", icon: "edit" },
  { key: "sign", label: "Sign & Protect", icon: "shield", soon: true },
  { key: "ocr", label: "OCR & Export", icon: "scan", soon: true },
];
const STORAGE: NavItem[] = [
  { key: "cloud", label: "Cloud Drives", icon: "cloud", soon: true },
  { key: "vault", label: "Local Vault", icon: "lock", soon: true },
];

export const SECTION_INFO: Record<Section, { label: string; icon: IconName; soon?: boolean }> = Object.fromEntries(
  [...WORKSPACES, ...STORAGE].map((n) => [n.key, n]),
) as Record<Section, NavItem>;

const THEMES: { key: ThemePref; label: string; icon: IconName }[] = [
  { key: "system", label: "Match system", icon: "monitor" },
  { key: "light", label: "Light", icon: "sun" },
  { key: "dark", label: "Dark", icon: "moon" },
];

/** Hover time before a compact-sidebar tooltip appears. */
export const TIP_DELAY_MS = 1000;
/** Matches the narrow-window rule in App.css, where the sidebar is icons-only too. */
const NARROW_WINDOW = "(max-width: 1100px)";

export function Sidebar(props: {
  section: Section;
  onNavigate: (s: Section) => void;
  sanitize: boolean;
  onSanitize: (v: boolean) => void;
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
  collapsed: boolean;
  onCollapsed: (v: boolean) => void;
}) {
  // Icons-only sidebar: labels show as a tooltip after hovering for TIP_DELAY_MS.
  // Native `title` tooltips cannot be delayed, so this is drawn by hand, in a portal
  // because the sidebar clips its contents.
  const [tip, setTip] = useState<{ label: string; x: number; y: number } | null>(null);
  const hovered = useRef<HTMLElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const hideTip = () => {
    window.clearTimeout(timer.current);
    hovered.current = null;
    setTip(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onOver = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    if (el === hovered.current) return;
    hideTip();
    if (!el || !(props.collapsed || window.matchMedia(NARROW_WINDOW).matches)) return;
    hovered.current = el;
    timer.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      setTip({ label: el.dataset.tip!, x: r.right + 10, y: r.top + r.height / 2 });
    }, TIP_DELAY_MS);
  };

  const item = (n: NavItem) => (
    <button
      key={n.key}
      className={`nav-item${props.section === n.key ? " current" : ""}`}
      aria-current={props.section === n.key ? "page" : undefined}
      aria-label={n.label}
      data-tip={n.soon ? `${n.label} · Coming soon` : n.label}
      onClick={() => props.onNavigate(n.key)}
    >
      <Icon name={n.icon} size={18} />
      <span className="nav-label">{n.label}</span>
      {n.soon && <span className="soon-dot" title="Not available yet" />}
    </button>
  );
  return (
    <aside className={`sidebar${props.collapsed ? " collapsed" : ""}`} onMouseOver={onOver} onMouseLeave={hideTip} onMouseDown={hideTip}>
      {tip &&
        createPortal(
          <div className="side-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
            {tip.label}
          </div>,
          document.body,
        )}
      <div className="brand">
        <span className="brand-mark">
          <Icon name="book" size={18} />
        </span>
        <span className="brand-text">
          <span className="brand-name">NovaPDF</span>
        </span>
        <button
          className="ghost icon-btn sidebar-toggle"
          aria-expanded={!props.collapsed}
          aria-label={props.collapsed ? "Expand menu" : "Collapse menu"}
          title={props.collapsed ? undefined : "Collapse menu (Ctrl+B)"}
          data-tip={props.collapsed ? "Expand menu (Ctrl+B)" : undefined}
          onClick={() => props.onCollapsed(!props.collapsed)}
        >
          <Icon name="panelLeft" size={16} />
        </button>
      </div>
      <nav className="nav" aria-label="Workspaces">
        <div className="nav-heading">Workspaces</div>
        {WORKSPACES.map(item)}
        <div className="nav-heading">Storage Volumes</div>
        {STORAGE.map(item)}
      </nav>
      <div className="sidebar-foot">
        <div className="device-card">
          <span className="device-mark">
            <Icon name="lock" size={16} />
          </span>
          <span className="device-text">
            <span className="device-title">On this device</span>
            <span className="device-sub">Nothing leaves your computer</span>
          </span>
        </div>
        <label className="switch-row" title="On save, remove links that run JavaScript or launch files, and embedded media/attachments">
          <span>
            <span className="switch-title">Sanitize on save</span>
            <span className="switch-sub">Strip scripts, media &amp; attachments</span>
          </span>
          <input type="checkbox" className="switch" checked={props.sanitize} onChange={(e) => props.onSanitize(e.target.checked)} />
        </label>
        <div className="theme-row">
          <span className="switch-title">Theme</span>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.key}
                role="radio"
                aria-checked={props.theme === t.key}
                className={props.theme === t.key ? "active" : undefined}
                title={t.label}
                aria-label={t.label}
                onClick={() => props.onTheme(t.key)}
              >
                <Icon name={t.icon} size={14} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

/** Empty view for an area that is not built yet. */
export function ComingSoon(props: { section: Section }) {
  const info = SECTION_INFO[props.section];
  return (
    <div className="placeholder">
      <div className="placeholder-card">
        <span className="tile-icon big">
          <Icon name={info.icon} size={26} />
        </span>
        <span className="badge gold">Coming soon</span>
        <h1>{info.label}</h1>
        <p>This workspace is not available yet. It will appear here in a later version.</p>
      </div>
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
    { icon: "stamp", title: "Watermark", sub: "Stamp text on every page", run: hasDoc ? props.onWatermark : undefined },
    { icon: "eraser", title: "Remove watermarks", sub: "Find and strip stamps", run: hasDoc ? props.onClean : undefined },
    { icon: "compress", title: "Compress", sub: "Coming soon" },
    { icon: "scan", title: "Extract OCR", sub: "Coming soon" },
  ];

  return (
    <div className="library">
      <div className="library-inner">
        <header className="hero">
          <div>
            <div className="eyebrow">
              Library <span className="dot-sep" /> {hasDoc ? `${props.docs.length} open` : "Nothing open"}
            </div>
            <h1>Document Library &amp; Workstation</h1>
            <p>Read, edit text in place, organize and merge pages, and stamp or strip watermarks. Everything runs on this device.</p>
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

        <section>
          <div className="section-title">
            <h2>Open in workspace</h2>
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
                  <div className="eyebrow small">PDF document</div>
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

        <section>
          <div className="section-title">
            <h2>Recent</h2>
          </div>
          <EmptyNote icon="clock" title="No recent documents yet">
            Files you open will be listed here in a later version.
          </EmptyNote>
        </section>

        <section className="info-cards">
          <div className="info-card">
            <div className="info-head">
              <Icon name="lock" size={16} /> Private by design
            </div>
            <p>PDFs are parsed in a sandboxed engine on this computer. Nothing is uploaded.</p>
          </div>
          <div className="info-card">
            <div className="info-head">
              <Icon name="shield" size={16} /> Safe output
            </div>
            <p>Sanitize on save strips JavaScript actions, launch links, embedded media and attachments.</p>
          </div>
          <div className="info-card">
            <div className="info-head">
              <Icon name="layers" size={16} /> Non-destructive
            </div>
            <p>Edits stay in your workspace with full undo until you save a new file.</p>
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
