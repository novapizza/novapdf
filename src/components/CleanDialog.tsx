import { useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { DocId, WatermarkScan } from "../lib/types";
import type { DocInfo } from "../state/workspace";
import { Icon } from "./Icon";

export interface ScanResult {
  docId: DocId;
  scan: WatermarkScan;
}

/** Finds existing watermarks (tagged artifacts, watermark annotations, and
 *  optionally text matching a phrase) and removes them as page edits. */
export function CleanDialog(props: {
  docs: DocInfo[];
  initialText: string;
  onApply: (results: ScanResult[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(props.initialText);
  const [results, setResults] = useState<ScanResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = async () => {
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const out: ScanResult[] = [];
      for (const d of props.docs) {
        out.push({ docId: d.docId, scan: await api.findWatermarks(d.docId, text.trim() || null) });
      }
      setResults(out);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const totals = results?.reduce(
    (acc, r) => ({
      marked: acc.marked + r.scan.markedObjects,
      annots: acc.annots + r.scan.annotations,
      text: acc.text + r.scan.matchingText,
      pages: acc.pages + r.scan.pages.length,
    }),
    { marked: 0, annots: 0, text: 0, pages: 0 },
  );
  const found = totals ? totals.marked + totals.annots + totals.text : 0;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-label="Remove watermarks">
        <header className="studio-head">
          <span className="tile-icon danger">
            <Icon name="eraser" />
          </span>
          <div>
            <h2>Remove watermarks</h2>
            <p>
              Finds content tagged as a watermark and watermark annotations. To also catch untagged watermarks, enter
              their text. Matching fragments are only removed when they are rotated or transparent, so body text stays.
            </p>
          </div>
        </header>
        <label className="field">
          <span>Watermark text (optional)</span>
          <input
            value={text}
            maxLength={500}
            placeholder="e.g. CONFIDENTIAL"
            onChange={(e) => {
              setText(e.target.value);
              setResults(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && !busy && scan()}
            autoFocus
          />
        </label>
        {error && <p className="notice error">{error}</p>}
        {totals && (
          <div className="scan-summary">
            {found === 0 ? (
              <p>No watermarks found.</p>
            ) : (
              <p>
                Found <b>{found}</b> item{found === 1 ? "" : "s"} on <b>{totals.pages}</b> page
                {totals.pages === 1 ? "" : "s"}: {totals.marked} tagged, {totals.annots} annotation
                {totals.annots === 1 ? "" : "s"}, {totals.text} matching text.
              </p>
            )}
          </div>
        )}
        <div className="modal-actions">
          <div className="spacer" />
          <button className="secondary" onClick={props.onClose}>Close</button>
          {results && found > 0 ? (
            <button className="primary" onClick={() => props.onApply(results)}>
              Remove {found}
            </button>
          ) : (
            <button className="primary" onClick={scan} disabled={busy}>
              {busy ? "Scanning…" : "Scan"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
