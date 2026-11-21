import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

export interface Command {
  id: string;
  title: string;
  description: string;
  icon: IconName;
  tag: "Action" | "Tool" | "View" | "Soon";
  shortcut?: string;
  /** Missing when the command cannot run right now (no document, not built yet). */
  run?: () => void;
}

/** Ctrl+K: search tools and actions by name. */
export function CommandPalette(props: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? props.commands.filter((c) => (c.title + " " + c.description).toLowerCase().includes(q))
      : props.commands;
    // Runnable commands first, keeping the given order otherwise.
    return [...list.filter((c) => c.run), ...list.filter((c) => !c.run)];
  }, [props.commands, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (c: Command | undefined) => {
    if (!c?.run) return;
    props.onClose();
    c.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(matches.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(matches[active]);
    } else if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
      e.preventDefault();
      props.onClose();
    }
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette" onKeyDown={onKey}>
        <div className="palette-search">
          <Icon name="search" size={20} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools and actions…"
            aria-label="Search commands"
            autoFocus
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-head">
          <span>Commands &amp; studio tools ({matches.length})</span>
        </div>
        <div className="palette-list" ref={listRef} role="listbox">
          {matches.length === 0 && <div className="palette-empty">No matching commands.</div>}
          {matches.map((c, i) => (
            <div
              key={c.id}
              data-index={i}
              role="option"
              aria-selected={i === active}
              aria-disabled={!c.run}
              className={`palette-item${i === active ? " active" : ""}${c.run ? "" : " disabled"}`}
              onMouseMove={() => setActive(i)}
              onClick={() => run(c)}
            >
              <span className={`palette-icon tag-${c.tag.toLowerCase()}`}>
                <Icon name={c.icon} size={18} />
              </span>
              <span className="palette-text">
                <span className="palette-title">
                  <span>
                    <Highlight text={c.title} query={query} />
                  </span>
                  <span className="palette-tag">{c.tag}</span>
                </span>
                <span className="palette-desc">{c.description}</span>
              </span>
              {i === active && c.run ? (
                <span className="palette-return">
                  Return <Icon name="enter" size={13} />
                </span>
              ) : c.shortcut ? (
                <kbd>{c.shortcut}</kbd>
              ) : null}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>↵</kbd> Select
          </span>
          <span>
            <kbd>Esc</kbd> Dismiss
          </span>
        </div>
      </div>
    </div>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}
