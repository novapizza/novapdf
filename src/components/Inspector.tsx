import { useEffect, useRef, useState } from "react";
import type { Align, LooseText, Paragraph, TextBlock } from "../lib/types";
import type { Split } from "../lib/links";
import { Icon, type IconName } from "./Icon";

const ALIGN_ICON: Record<Align, IconName> = {
  left: "alignLeft",
  center: "alignCenter",
  right: "alignRight",
  justify: "alignJustify",
};

interface Props {
  fonts: string[];
  /** Page number the selection is on, if any. */
  pageNumber: number | null;
  block: TextBlock | null;
  /** Set when the selected block is half of a paragraph linked across pages. */
  linked: { pageA: number; pageB: number } | null;
  paragraph: Paragraph | null;
  loose: LooseText | null;
  hasEdits: boolean;
  onUpdateBlock: (b: TextBlock) => void;
  onEditBlock: () => void;
  onEditParagraph: () => void;
  onDelete: () => void;
  onUnlink: () => void;
  /** Start linking the selected paragraph with one on the next / previous page. */
  onLinkNext: (() => void) | null;
  onLinkPrev: (() => void) | null;
  onRemoveEverywhere: () => void;
  onRestorePage: () => void;
}

const toHex = (c: [number, number, number]) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16) || 0,
  parseInt(h.slice(3, 5), 16) || 0,
  parseInt(h.slice(5, 7), 16) || 0,
];

/** Number field that commits on blur/Enter, so typing does not flood undo history. */
function NumberField(props: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  step?: number;
  placeholder?: string;
  onCommit: (v: number | null) => void;
}) {
  const [text, setText] = useState(props.value == null ? "" : String(props.value));
  useEffect(() => setText(props.value == null ? "" : String(props.value)), [props.value]);
  const commit = () => {
    if (text.trim() === "" && props.placeholder) return props.onCommit(null);
    const n = Number(text);
    if (!Number.isFinite(n)) return setText(props.value == null ? "" : String(props.value));
    const v = Math.min(props.max, Math.max(props.min, n));
    if (v !== props.value) props.onCommit(v);
    else setText(String(v));
  };
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        value={text}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        placeholder={props.placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

export function Inspector(p: Props) {
  if (p.block) {
    const b = p.block;
    const set = (patch: Partial<TextBlock>) => p.onUpdateBlock({ ...b, ...patch });
    const fonts = p.fonts.includes(b.font.family) ? p.fonts : [b.font.family, ...p.fonts];
    return (
      <aside className="inspector">
        <h3>{p.linked ? `Linked paragraph · pages ${p.linked.pageA}–${p.linked.pageB}` : "Text box"}</h3>
        {p.linked && (
          <p className="notice small">
            This paragraph continues across two pages. Text and style changes apply to both halves and re-flow
            between them.
          </p>
        )}
        <label className="field">
          <span>Font</span>
          <select value={b.font.family} onChange={(e) => set({ font: { ...b.font, family: e.target.value } })}>
            {fonts.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <NumberField label="Size" value={b.size} min={1} max={500} step={0.5} onCommit={(v) => v && set({ size: v })} />
          <label className="field">
            <span>Color</span>
            <input type="color" value={toHex(b.color)} onChange={(e) => set({ color: fromHex(e.target.value) })} />
          </label>
        </div>
        <div className="row toggles">
          <button className={b.font.bold ? "active" : ""} onClick={() => set({ font: { ...b.font, bold: !b.font.bold } })} title="Bold" aria-label="Bold" aria-pressed={b.font.bold}>
            <Icon name="bold" size={14} />
          </button>
          <button className={b.font.italic ? "active" : ""} onClick={() => set({ font: { ...b.font, italic: !b.font.italic } })} title="Italic" aria-label="Italic" aria-pressed={b.font.italic}>
            <Icon name="italic" size={14} />
          </button>
          <div className="sep" />
          {(["left", "center", "right", "justify"] as Align[]).map((a) => (
            <button key={a} className={b.align === a ? "active" : ""} onClick={() => set({ align: a })} title={`Align ${a}`} aria-label={`Align ${a}`} aria-pressed={b.align === a}>
              <Icon name={ALIGN_ICON[a]} size={14} />
            </button>
          ))}
        </div>
        <div className="row">
          <NumberField label="Line height" value={b.lineHeight} min={0.5} max={5} step={0.05} onCommit={(v) => v && set({ lineHeight: v })} />
          <NumberField
            label="Wrap width (pt)"
            value={b.width == null ? null : Math.round(b.width)}
            min={10}
            max={5000}
            placeholder="none"
            onCommit={(v) => set({ width: v })}
          />
        </div>
        <div className="row">
          <NumberField
            label="First-line indent"
            value={Math.round((b.indent ?? 0) * 10) / 10}
            min={0}
            max={500}
            step={0.5}
            onCommit={(v) => v != null && set({ indent: v })}
          />
          <NumberField
            label="Letter width %"
            value={Math.round((b.hScale ?? 1) * 1000) / 10}
            min={50}
            max={200}
            step={0.5}
            onCommit={(v) => v != null && set({ hScale: v / 100 })}
          />
        </div>
        <div className="row">
          <NumberField label="X (pt)" value={Math.round(b.x * 10) / 10} min={-5000} max={5000} step={0.5} onCommit={(v) => v != null && set({ x: v })} />
          <NumberField label="Baseline (pt)" value={Math.round(b.baseline * 10) / 10} min={-5000} max={5000} step={0.5} onCommit={(v) => v != null && set({ baseline: v })} />
        </div>
        <div className="actions">
          <button onClick={p.onEditBlock}>Edit text</button>
          {p.linked && <button onClick={p.onUnlink} title="Keep both halves as separate text boxes">Unlink</button>}
          <button className="danger" onClick={p.onDelete}>{p.linked ? "Delete paragraph" : "Delete"}</button>
        </div>
        <p className="muted small">Drag the box to move it. The page preview is the real PDF output.</p>
      </aside>
    );
  }

  if (p.paragraph) {
    const para = p.paragraph;
    return (
      <aside className="inspector">
        <h3>Paragraph</h3>
        <p className="quote">{para.text.length > 300 ? para.text.slice(0, 300) + "…" : para.text}</p>
        <dl className="facts">
          <dt>PDF font</dt>
          <dd>{para.sourceFont || "unknown"}</dd>
          <dt>Edits use</dt>
          <dd>
            {para.font.family}
            {para.font.bold ? " Bold" : ""}
            {para.font.italic ? " Italic" : ""} · {para.size.toFixed(1)} pt
          </dd>
        </dl>
        {para.mixedStyles && <p className="notice">This paragraph mixes fonts, sizes or colours. Editing it applies one style.</p>}
        <div className="actions">
          <button onClick={p.onEditParagraph}>Edit text</button>
          <button className="danger" onClick={p.onDelete}>Delete</button>
        </div>
        <h4>Runs across a page break?</h4>
        <div className="actions">
          <button onClick={p.onLinkNext ?? undefined} disabled={!p.onLinkNext} title="Pick where it continues on the next page">
            Continues on next page…
          </button>
          <button onClick={p.onLinkPrev ?? undefined} disabled={!p.onLinkPrev} title="Pick where it starts on the previous page">
            Continued from previous…
          </button>
        </div>
      </aside>
    );
  }

  if (p.loose) {
    const l = p.loose;
    return (
      <aside className="inspector">
        <h3>{l.watermarkMark ? "Watermark" : "Text object"}</h3>
        <p className="quote">{l.text || "(no text)"}</p>
        <ul className="tags">
          {l.watermarkMark && <li>tagged as watermark</li>}
          {l.rotated && <li>rotated</li>}
          {l.transparent && <li>transparent</li>}
        </ul>
        <div className="actions">
          <button className="danger" onClick={p.onDelete}>Delete here</button>
          {l.text && <button onClick={p.onRemoveEverywhere}>Remove on all pages…</button>}
        </div>
      </aside>
    );
  }

  return (
    <aside className="inspector">
      <h3>Edit</h3>
      <ul className="help">
        <li>Click a paragraph to edit its text.</li>
        <li>
          Choose <b>Add text</b> (T), then click the page to place a text box.
        </li>
        <li>Rotated or watermark text shows as a dashed box: select it to delete it.</li>
        <li>
          A paragraph split by a page break can be edited as one: select it, then choose <b>Continues on next page</b>.
        </li>
        <li>
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> or clicking away finishes editing; <kbd>Esc</kbd> cancels.
        </li>
      </ul>
      {p.hasEdits && (
        <div className="actions">
          <button className="danger" onClick={p.onRestorePage}>
            Restore page {p.pageNumber ?? ""} to original
          </button>
        </div>
      )}
    </aside>
  );
}

/** Side panel for editing a paragraph that runs across two pages. */
export function LinkEditor(props: {
  pageA: number;
  pageB: number;
  text: string;
  split: Split | null;
  capacityA: number;
  capacityB: number;
  busy: boolean;
  error: string | null;
  isNew: boolean;
  onChange: (text: string) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  const s = props.split;
  const overflow = s?.overflow ?? 0;
  return (
    <aside className="inspector link-editor">
      <h3>
        Paragraph across pages {props.pageA}–{props.pageB}
      </h3>
      <p className="muted small">
        Edit it as one paragraph. Page {props.pageA} keeps its {props.capacityA} line{props.capacityA === 1 ? "" : "s"};
        the rest flows to page {props.pageB}. The pages show a live preview.
      </p>
      <textarea
        ref={ref}
        className="link-text"
        value={props.text}
        spellCheck
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            props.onCancel();
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            props.onDone();
          }
          e.stopPropagation();
        }}
      />
      <div className="flow-meter">
        <span>
          Page {props.pageA}: {s ? s.linesA : "…"} / {props.capacityA} lines
        </span>
        <span className={overflow ? "over" : ""}>
          Page {props.pageB}: {s ? s.linesB : "…"} / {props.capacityB} lines
        </span>
        {props.busy && <span className="spinner" aria-label="Measuring" />}
      </div>
      {overflow > 0 && (
        <p className="notice error">
          {overflow} line{overflow === 1 ? "" : "s"} too long: there is no free space left on page {props.pageB}. Shorten
          the text, or cancel.
        </p>
      )}
      {props.error && <p className="notice error">{props.error}</p>}
      <div className="actions">
        <button className="primary" onClick={props.onDone} disabled={overflow > 0 || props.busy || !s}>
          {props.isNew ? "Link and apply" : "Apply"}
        </button>
        <button onClick={props.onCancel}>Cancel</button>
      </div>
      <p className="muted small">
        <kbd>Ctrl</kbd>+<kbd>Enter</kbd> applies, <kbd>Esc</kbd> cancels.
      </p>
    </aside>
  );
}
