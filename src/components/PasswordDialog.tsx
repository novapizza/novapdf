import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

/** Asks for the password of a protected PDF. The password goes to Rust and is not kept here. */
export function PasswordDialog(props: {
  fileName: string;
  /** Why the last try failed ("Wrong password. Try again."), or null. */
  error: string | null;
  busy: boolean;
  /** Further files waiting for a password after this one. */
  waiting: number;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // A failed try, or the next file: start over with an empty box.
  useEffect(() => {
    setPassword("");
    input.current?.focus();
  }, [props.error, props.fileName]);

  const submit = () => {
    if (password && !props.busy) props.onSubmit(password);
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal password-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            props.onCancel();
          }
        }}
      >
        <div className="studio-head">
          <span className="tile-icon">
            <Icon name="lock" />
          </span>
          <div>
            <h2 id="password-title">Enter password</h2>
            <p>
              <b>{props.fileName}</b> is protected with a password.
            </p>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="field">
            <span>Password</span>
            <input
              ref={input}
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={props.error ? true : undefined}
              aria-describedby={props.error ? "password-error" : undefined}
              disabled={props.busy}
            />
          </label>
          {props.error && (
            <p className="notice error" id="password-error" role="alert">
              {props.error}
            </p>
          )}
          <label className="check">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password
          </label>
          <div className="modal-actions">
            {props.waiting > 0 && (
              <span className="muted small">
                {props.waiting} more file{props.waiting === 1 ? "" : "s"} waiting
              </span>
            )}
            <div className="spacer" />
            <button type="button" className="ghost" onClick={props.onCancel} disabled={props.busy}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!password || props.busy}>
              {props.busy ? <span className="spinner" aria-label="Opening" /> : <Icon name="lock" size={15} />} Open
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
