// A fake Tauri backend for unit tests.
//
//   tauriMock.handle("extract_page", (args) => pageText);   // answer a command
//   tauriMock.emit("files-dropped", ["a.pdf"]);               // fire a backend event
//   tauriMock.ask.mockResolvedValue(false);                   // answer the native confirm
//   expect(tauriMock.calls("save_with_dialog")).toHaveLength(1);
//
// Commands without a handler reject, so a test fails loudly when the UI calls
// something it did not expect.
import { vi } from "vitest";

type Handler = (args: Record<string, unknown>) => unknown;

// State lives on globalThis so every copy of this module (vi.resetModules() re-runs
// mock factories) talks to the same fake backend.
interface Shared {
  handlers: Map<string, Handler>;
  listeners: Map<string, Set<(e: { payload: unknown }) => void>>;
  closeHandlers: Set<(e: { preventDefault: () => void }) => unknown>;
  invoke: ReturnType<typeof vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>>;
  ask: ReturnType<typeof vi.fn<(message: string, opts?: unknown) => Promise<boolean>>>;
}
const g = globalThis as unknown as { __novapdfTauriMock?: Shared };
const shared: Shared = (g.__novapdfTauriMock ??= (() => {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    listeners: new Map(),
    closeHandlers: new Set(),
    invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
      const h = handlers.get(cmd);
      if (!h) throw new Error(`Unexpected Tauri command in test: ${cmd}`);
      return h(args);
    }),
    ask: vi.fn(async () => true),
  };
})());
const { handlers, listeners, closeHandlers, invoke } = shared;

export const tauriMock = {
  invoke,
  ask: shared.ask,
  handle(cmd: string, h: Handler) {
    handlers.set(cmd, h);
  },
  calls(cmd: string): Record<string, unknown>[] {
    return invoke.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1] ?? {});
  },
  emit(event: string, payload: unknown) {
    for (const l of listeners.get(event) ?? []) l({ payload });
  },
  /** Simulates the user closing the window; returns whether the close was prevented. */
  async requestClose(): Promise<boolean> {
    let prevented = false;
    for (const h of closeHandlers) await h({ preventDefault: () => (prevented = true) });
    return prevented;
  },
  reset() {
    handlers.clear();
    listeners.clear();
    closeHandlers.clear();
    invoke.mockClear();
    tauriMock.ask.mockReset();
    tauriMock.ask.mockResolvedValue(true);
  },
};

export const coreModule = { invoke };

export const eventModule = {
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(cb);
    return () => listeners.get(event)?.delete(cb);
  }),
};

export const windowModule = {
  getCurrentWindow: () => ({
    onCloseRequested: async (cb: (e: { preventDefault: () => void }) => unknown) => {
      closeHandlers.add(cb);
      return () => closeHandlers.delete(cb);
    },
  }),
};

export const dialogModule = {
  ask: (message: string, opts?: unknown) => tauriMock.ask(message, opts),
};
