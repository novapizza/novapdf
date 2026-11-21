import { useEffect, useState } from "react";
import { errorMessage } from "../lib/api";
import { requestRender } from "../lib/renderCache";
import type { Watermark } from "../lib/types";
import { editsAreEmpty } from "../lib/types";
import type { PageItem } from "../state/workspace";
import { Icon } from "./Icon";

const DEFAULT: Watermark = {
  text: "CONFIDENTIAL",
  font: { family: "Helvetica", bold: true, italic: false },
  size: 64,
  color: [186, 26, 26],
  opacity: 0.25,
  angle: 45,
};

const PRESETS = ["CONFIDENTIAL", "DRAFT", "DO NOT COPY", "INTERNAL USE", "PREVIEW ONLY"];

/** Pigment palette (Alexandria primary, error, slate, archival gold, outline). */
const PIGMENTS: { name: string; rgb: [number, number, number] }[] = [
  { name: "Archive blue", rgb: [9, 76, 178] },
  { name: "Signal red", rgb: [186, 26, 26] },
  { name: "Slate", rgb: [66, 71, 75] },
  { name: "Archival gold", rgb: [109, 94, 0] },
  { name: "Graphite", rgb: [115, 119, 132] },
];

const toHex = (c: [number, number, number]) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16) || 0,
  parseInt(h.slice(3, 5), 16) || 0,
  parseInt(h.slice(5, 7), 16) || 0,
];
const sameColor = (a: [number, number, number], b: [number, number, number]) =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

export function WatermarkDialog(props: {
  current: Watermark | null;
  fonts: string[];
  previewPage: PageItem | null;
  pageCount: number;
  onApply: (w: Watermark | null) => void;
  onClose: () => void;
}) {
  const [wm, setWm] = useState<Watermark>(props.current ?? DEFAULT);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = wm.text.trim().length > 0 && wm.text.length <= 500;

  useEffect(() => {
    const page = props.previewPage;
    if (!page || !valid) return;
    let alive = true;
    const t = setTimeout(() => {
      requestRender({
        docId: page.docId,
        pageIndex: page.pageIndex,
        width: 420,
        format: "jpeg",
        rotation: page.rotation,
        edits: editsAreEmpty(page.edits) ? null : page.edits,
        watermark: wm,
        priority: "view",
      }).then(
        (u) => alive && (setPreview(u), setError(null)),
        (e) => alive && setError(errorMessage(e)),
      );
    }, 180);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(wm), props.previewPage, valid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const set = (patch: Partial<Watermark>) => setWm({ ...wm, ...patch });
  const fonts = props.fonts.includes(wm.font.family) ? props.fonts : [wm.font.family, ...props.fonts];
  const custom = !PIGMENTS.some((p) => sameColor(p.rgb, wm.color));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal studio" role="dialog" aria-label="Watermark Studio">
        <header className="studio-head">
          <span className="tile-icon">
            <Icon name="shield" />
          </span>
          <div>
            <h2>Watermark Studio</h2>
            <p>A vector text stamp drawn on every page. Tagged as a PDF watermark, so it can be removed later.</p>
          </div>
          <div className="spacer" />
          <button className="ghost icon-btn" onClick={props.onClose} aria-label="Close" title="Close (Esc)">
            <Icon name="x" />
          </button>
        </header>

        <div className="studio-body">
          <div className="studio-form">
            <section>
              <div className="studio-label">
                <span>Stamp inscription</span>
                <button className="link" onClick={() => set({ text: "" })}>
                  Clear
                </button>
              </div>
              <input
                className="inscription"
                value={wm.text}
                maxLength={500}
                onChange={(e) => set({ text: e.target.value })}
                placeholder="Watermark text"
                autoFocus
              />
              <div className="preset-chips">
                {PRESETS.map((t) => (
                  <button key={t} className={`preset${wm.text === t ? " active" : ""}`} onClick={() => set({ text: t })}>
                    {t}
                  </button>
                ))}
              </div>
            </section>

            <section>
              <div className="studio-label">
                <span>Layout topology</span>
              </div>
              <div className="topology">
                <button className="topo active" aria-pressed="true">
                  <Icon name="diagonal" /> Centered stamp
                </button>
                <button className="topo" disabled title="Coming soon">
                  <Icon name="grid" /> Tile matrix
                </button>
                <button className="topo" disabled title="Coming soon">
                  <Icon name="perimeter" /> Perimeter seal
                </button>
              </div>
            </section>

            <section className="studio-pair">
              <label className="field">
                <span>Typeface</span>
                <select value={wm.font.family} onChange={(e) => set({ font: { ...wm.font, family: e.target.value } })}>
                  {fonts.map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </label>
              <div className="row toggles">
                <button
                  className={wm.font.bold ? "active" : ""}
                  onClick={() => set({ font: { ...wm.font, bold: !wm.font.bold } })}
                  aria-pressed={wm.font.bold}
                  aria-label="Bold"
                  title="Bold"
                >
                  <Icon name="bold" size={15} />
                </button>
                <button
                  className={wm.font.italic ? "active" : ""}
                  onClick={() => set({ font: { ...wm.font, italic: !wm.font.italic } })}
                  aria-pressed={wm.font.italic}
                  aria-label="Italic"
                  title="Italic"
                >
                  <Icon name="italic" size={15} />
                </button>
              </div>
            </section>

            <section className="studio-sliders">
              <Slider label="Stamp size" value={wm.size} unit="pt" min={8} max={200} onChange={(v) => set({ size: v })} />
              <Slider label="Rotation angle" value={wm.angle} unit="°" min={-90} max={90} onChange={(v) => set({ angle: v })} />
              <Slider
                label="Ink density / opacity"
                value={Math.round(wm.opacity * 100)}
                unit="%"
                min={5}
                max={100}
                onChange={(v) => set({ opacity: v / 100 })}
              />
            </section>

            <section>
              <div className="studio-label">
                <span>Pigment palette</span>
              </div>
              <div className="swatches">
                {PIGMENTS.map((p) => (
                  <button
                    key={p.name}
                    className={`swatch${sameColor(p.rgb, wm.color) ? " active" : ""}`}
                    style={{ background: toHex(p.rgb) }}
                    onClick={() => set({ color: p.rgb })}
                    title={p.name}
                    aria-label={p.name}
                    aria-pressed={sameColor(p.rgb, wm.color)}
                  >
                    {sameColor(p.rgb, wm.color) && <Icon name="check" size={14} />}
                  </button>
                ))}
                <label className={`swatch custom${custom ? " active" : ""}`} title="Custom colour">
                  <input type="color" value={toHex(wm.color)} onChange={(e) => set({ color: fromHex(e.target.value) })} aria-label="Custom colour" />
                  <Icon name="plus" size={14} />
                </label>
              </div>
            </section>
          </div>

          <div className="studio-preview">
            <div className="studio-label">
              <span>Live viewport</span>
              <span className="mono">{props.previewPage ? `PDFium · 420 px` : ""}</span>
            </div>
            <div className="preview">
              {preview ? <img src={preview} alt="Watermark preview" /> : <div className="thumb-placeholder" />}
              {error && <p className="notice error">{error}</p>}
            </div>
            <div className="studio-scope">
              <Icon name="layers" size={14} />
              Scope: all pages (1–{props.pageCount})
            </div>
          </div>
        </div>

        <div className="modal-actions">
          {props.current && (
            <button className="danger" onClick={() => props.onApply(null)}>
              <Icon name="trash" size={15} /> Remove watermark
            </button>
          )}
          <div className="spacer" />
          <button className="secondary" onClick={props.onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!valid} onClick={() => props.onApply(wm)}>
            <Icon name="stamp" size={16} /> Apply to all pages
          </button>
        </div>
      </div>
    </div>
  );
}

function Slider(props: { label: string; value: number; unit: string; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="studio-slider">
      <span className="studio-slider-head">
        <span>{props.label}</span>
        <span className="value">
          {props.value}
          {props.unit}
        </span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ "--fill": `${((props.value - props.min) / (props.max - props.min)) * 100}%` } as React.CSSProperties}
      />
    </label>
  );
}
