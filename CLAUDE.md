# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

NovaPDF is a desktop PDF editor built with Tauri 2, Rust and native PDFium (via `pdfium-render`), with a React 19 + TypeScript UI. [README.md](README.md) covers features, the security model and known limitations. [TESTING.md](TESTING.md) covers the test layers, coverage gates and where tests go. Read both before making non-trivial changes.

Priorities: performance and security come first. PDF input is treated as hostile.

## Commands

```bash
npm install                  # also runs scripts/fetch-pdfium.mjs → src-tauri/pdfium/
npm run tauri dev            # run the app (Vite on fixed port 1420)
npm run tauri build
npm run typecheck

npm test                     # Vitest, UI unit/integration (jsdom, Tauri faked)
npm run test:coverage        # Vitest + per-file coverage gate
npm run test:rust            # cargo test (unit + real-PDFium pipeline + worker process)
npm run coverage:rust        # cargo-llvm-cov gate (needs cargo-llvm-cov installed)
npm run test:e2e             # Playwright over CDP into the real WebView2 app (Windows only)
npm run test:all             # typecheck → UI gate → Rust gate → E2E
```

Single tests:

```bash
npx vitest run src/lib/pageText.test.ts -t "test name"
cargo test --manifest-path src-tauri/Cargo.toml <name_filter>
npm run test:e2e -- e2e/edit.spec.ts -g "test name"   # extra args pass through to Playwright
E2E_SKIP_BUILD=1 npm run test:e2e                      # skip the cargo build step
```

Always run E2E through `npm run test:e2e`, never `npx playwright test`. The wrapper upper-cases the drive letter. Without it, Playwright on Windows fails with "did not expect test.use()".

Debugging text extraction: `NOVAPDF_INSPECT=file.pdf cargo test --manifest-path src-tauri/Cargo.toml --test inspect -- --ignored --nocapture`

PDFium is pinned in `scripts/fetch-pdfium.mjs` to the build that the `pdfium_8125` feature of `pdfium-render` targets. Bump both together. To re-download: `npm run setup:pdfium -- --force`.

## Architecture

There are three tiers. One executable is both the app and the worker: `main.rs` checks for `--pdf-worker` and branches into `worker::main()`.

1. **React UI** (`src/`) has no file-system access. Tauri capabilities exclude fs and dialog open/save, and the CSP is strict. All backend calls go through `src/lib/api.ts` (`invoke`). Page images come back as bytes and are shown as `blob:` URLs, cached in `lib/renderCache.ts`.
2. **Rust host** (`src-tauri/src/`):
   - `commands.rs` holds the Tauri commands. Native open/save dialogs run here. Dropped files become one-time path grants before the UI hears about them.
   - `host.rs` runs the worker pool and keeps document bytes in RAM. It also handles per-request timeouts (render 30 s, extract 30 s, save 300 s), restarts crashed workers, recycles thumbnail workers after `RECYCLE_AFTER_RENDERS`, and stops idle workers that hold documents (`trim_idle`, driven by a timer in `lib.rs`). Any worker can be killed at any time, so workers must hold no state that can't be rebuilt from the host's bytes.
   - `shared.rs`: on Windows the document bytes live once in an anonymous section. Each worker gets a map-read-only handle via `Request::OpenShared`, instead of the bytes going in an `Open` payload. Other platforms, or a failed section, fall back to `Open`.
   - `sandbox.rs` is Windows-only: Job Object (3 GB memory cap, no child processes), Low integrity, and process mitigations.
   - `protocol.rs` defines the framed stdin/stdout IPC types and the edit model, and validates both.
3. **PDF worker** (`src-tauri/src/worker/`) is the only place untrusted PDF bytes are parsed:
   - `pdf.rs` wraps PDFium
   - `extract.rs` groups text into lines and then paragraphs
   - `edit.rs` handles layout, text objects, watermark, sanitize and save
   - `content.rs` handles page-object and content handling
   - `fonts.rs` picks fonts: standard-14 if the text is WinAnsi and the family matches, otherwise an installed TrueType font embedded in full

   The worker never touches the file system for documents.

Key invariants:

- **Edits are data.** Per-page edits are `{ removedObjects, removedAnnots, blocks }` (see `protocol.rs` and `src/lib/types.ts`). Source documents are never mutated. Render copies the page into a scratch document and applies the edits. Save builds a fresh document page by page, so unchanged pages are copied untouched, and doc-level JS, OpenAction, embedded files and XFA are never carried over.
- **Undo/redo is pure UI state.** The workspace (page list, rotation, edits, watermark, paragraph links) lives in the `src/state/workspace.ts` reducer, which keeps past/present/future history. `App.tsx` wires commands, shortcuts and drop events onto it.
- **Memory is a product requirement** (1000-page documents must stay light). The render cache in `src/lib/renderCache.ts` has separate budgets for thumbnails and page views. Thumbnails share one IntersectionObserver (`useVisible` in `PageGrid.tsx`). Keep off-screen `<img>` elements mounted: measured, unmounting them raised WebView memory, because Chromium already discards off-screen decoded bitmaps.
- **Worker 0 is interactive** (view, extract, save). The other workers render thumbnails, so thumbnail floods never block editing. Workers load documents lazily from host-held bytes, so a replacement worker can pick up where a crashed one left off.
- **Bounded inputs everywhere:** 512 MB file limit with a `%PDF-` header check, bounded IPC frames, render size caps, and validated geometry and text lengths. Worker output is checked (PNG/JPEG magic bytes, saves start with `%PDF-`). Keep new requests and responses within these limits.
- Saves are atomic: the file is written to a temp file and then renamed over the target.

Debug-only hooks, compiled out of release builds:

- `NOVAPDF_DEV_OPEN="a.pdf;b.pdf"` pre-grants files.
- The main window is created hidden and shown on page load, with a 3 s fallback (`lib.rs`), to avoid a white flash at startup.
- `NOVAPDF_DEV_SAVE_TO` makes *Save as…* skip the native dialog (see `save_with_dialog` in `commands.rs`).

E2E tests depend on both.

## Testing conventions

These rules are enforced by gates. TESTING.md has the details.

- Coverage thresholds are **per file** and work as a ratchet. Never lower them; raise them when coverage goes up.
  - UI thresholds are in `vitest.config.ts`. `src/lib/**` and `src/state/**` need about 98% lines and functions.
  - The Rust threshold is `--fail-under-lines` in `package.json`.
  - A new untested file fails the gate.
- Rust tests go in a sibling `foo/tests.rs`, declared with `#[cfg(test)] mod tests;` at the end of `foo.rs`. Never put them inline: llvm-cov would count test code as covered lines.
- Anything that needs real PDFium in-process goes as a new section inside the **single** test in `src-tauri/tests/pipeline.rs`, because PDFium binds once per process. Worker request handling is tested in `src-tauri/tests/worker_process.rs`.
- UI tests use the fake backend in `src/test/tauri.ts` (`tauriMock.handle/emit/calls`). Any unhandled command throws. Test data builders are in `src/test/fixtures.ts`.
- User-facing flows (a new tool, dialog or save option) also need an `e2e/*.spec.ts` test. Use the `app` fixture from `e2e/app.ts`. To verify a save, call `launchApp()` for a second instance and open the saved file in it.
- Known bugs are pinned with `it.fails` / `test.fail` (listed in TESTING.md). When you fix one, flip the marker to `it` / `test`.
