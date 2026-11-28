import { Icon } from "./Icon";

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
}

export function Toasts(props: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {props.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === "error" ? "alert" : undefined} onClick={() => props.onDismiss(t.id)}>
          <span className="toast-text">{t.message}</span>
          {/* The click on the toast itself dismisses too; the button is for the keyboard. */}
          <button className="ghost icon-btn toast-close" aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
