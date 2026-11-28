import { useEffect, useRef } from "react";
import { Icon } from "./Icon";

/** Ctrl+F: the find box over the page in read view. */
export function FindBar(props: {
  query: string;
  onQuery: (q: string) => void;
  /** Matches found so far, and which one is shown (0-based). */
  count: number;
  index: number;
  searching: boolean;
  /** The search stopped at its limit; there may be more matches. */
  capped: boolean;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /** Changes each time find is asked for, so the box takes the focus again. */
  request: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [props.request]);

  const status = !props.query.trim()
    ? ""
    : props.count > 0
      ? `${props.index + 1} of ${props.count}${props.capped ? "+" : ""}`
      : props.searching
        ? "Searching…"
        : "No results";

  return (
    <div className="find-bar" role="search" aria-label="Find in document">
      <Icon name="search" size={16} />
      <input
        ref={input}
        value={props.query}
        onChange={(e) => props.onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) props.onPrev();
            else props.onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            props.onClose();
          }
        }}
        placeholder="Find in document"
        aria-label="Find in document"
        spellCheck={false}
      />
      <span className="find-status" aria-live="polite">
        {status}
      </span>
      <button className="ghost icon-btn" onClick={props.onPrev} disabled={props.count === 0} title="Previous match (Shift+Enter)" aria-label="Previous match">
        <Icon name="chevronLeft" size={16} />
      </button>
      <button className="ghost icon-btn" onClick={props.onNext} disabled={props.count === 0} title="Next match (Enter)" aria-label="Next match">
        <Icon name="chevronRight" size={16} />
      </button>
      <button className="ghost icon-btn" onClick={props.onClose} title="Close (Esc)" aria-label="Close find">
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}
