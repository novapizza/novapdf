export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
}

export function Toasts(props: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {props.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => props.onDismiss(t.id)}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
