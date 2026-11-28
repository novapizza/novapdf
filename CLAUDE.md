# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

NovaQuire (formerly NovaPDF) is a desktop PDF editor built with Tauri 2, Rust and native PDFium (via `pdfium-render`), with a React 19 + TypeScript UI. [README.md](README.md) covers features, the security model and known limitations. [TESTING.md](TESTING.md) covers the test layers, coverage gates and where tests go. Read both before making non-trivial changes.

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

PDFium is pinned in `scripts/fetch-pdfium.mjs` to the build that the `pdfium_8125` feature of `pdfium-render` targets. Bump both together, and update the pinned SHA-256 of each archive in the same script (downloads that do not match fail). To re-download: `npm run setup:pdfium -- --force`.

## Architecture

There are three tiers. One executable is both the app and the worker: `main.rs` checks for `--pdf-worker` and branches into `worker::main()`.

1. **React UI** (`src/`) has no file-system access. Tauri capabilities exclude fs and dialog open/save, and the CSP is strict. All backend calls go through `src/lib/api.ts` (`invoke`). Page images come back as bytes and are shown as `blob:` URLs, cached in `lib/renderCache.ts`. Page-view renders go through a ranked, cancelable lane there (2 in flight), so the page the reader lands on renders before its neighbours and pages scrolled past are dropped.
2. **Rust host** (`src-tauri/src/`):
   - `commands.rs` holds the Tauri commands. Native open/save dialogs run here. Dropped files become one-time path grants before the UI hears about them.
   - `host.rs` runs the worker pool and keeps document bytes in RAM. It also handles per-request timeouts (render 30 s, extract 30 s, save 300 s), restarts crashed workers, recycles thumbnail workers after `RECYCLE_AFTER_RENDERS`, and stops idle workers that hold documents (`trim_idle`, driven by a timer in `lib.rs`). Any worker can be killed at any time, so workers must hold no state that can't be rebuilt from the host's bytes.
   - `shared.rs`: on Windows the document bytes live once in an anonymous section. Each worker gets a map-read-only handle via `Request::OpenShared`, instead of the bytes going in an `Open` payload. Other platforms, or a failed section, fall back to `Open`.
   - `sandbox.rs`: on Windows, Job Object (3 GB memory cap, no child processes), Low integrity, and process mitigations. On macOS (`sandbox/mac.rs`), a Seatbelt profile that only allows reading font folders, plus the host-side memory watchdog (`enforce_memory_limit`, polled from `lib.rs`). Anything new the worker reads after start-up must be allowed in that profile, or it fails silently on macOS.
   - Password-protected files: the worker reports `protocol::NEEDS_PASSWORD`; `commands.rs` then holds the file under a one-time id (`Locked`) and the UI sends the password with that id (`unlock_file`). `host.rs` keeps each document's password in memory while it is open, so any worker can load it again. Saves of protected documents are encrypted with AES-256 in the worker (`worker/encrypt.rs`, lopdf) using a key the host makes; PDFium cannot encrypt.
   - `recent.rs` keeps the recent files list, stored as JSON in the app's data folder. The UI gets names and ids, never paths, and opens an entry with `open_recent(id)`; only files that opened successfully are recorded. A missing file is taken off the list when opened.
   - `protocol.rs` defines the framed stdin/stdout IPC types and the edit model, and validates both.
3. **PDF worker** (`src-tauri/src/worker/`) is the only place untrusted PDF bytes are parsed:
   - `pdf.rs` wraps PDFium
   - `extract.rs` groups text into lines and then paragraphs
   - `edit.rs` handles layout, text objects, watermark, sanitize and save
   - `content.rs` handles page-object and content handling
   - `fonts.rs` picks fonts: standard-14 if the text is WinAnsi and the family matches, otherwise an installed TrueType font embedded in full
   - `annots.rs` handles comments (annotations): lists the ones in a file, returns character boxes for text selection, changes existing ones in place and creates new ones (notes, highlights, ink)
   - `outline.rs` lists the bookmarks, flat in document order with a depth each. The walk is iterative and bounded (entries, depth, loops), and loads at most `MAX_POSITIONED_PAGES` pages to place bookmarks on their page

   The worker never touches the file system for documents.

Key invariants:

- **Edits are data.** Per-page edits are `{ removedObjects, removedAnnots, blocks, changedAnnots, annotations }` (see `protocol.rs` and `src/lib/types.ts`). Source documents are never mutated. Render copies the page into a scratch document and applies the edits. Save builds a fresh document page by page, so unchanged pages are copied untouched, and doc-level JS, OpenAction, embedded files and XFA are never carried over.
- **Undo/redo is pure UI state.** The workspace (page list, rotation, edits, watermark, paragraph links) lives in the `src/state/workspace.ts` reducer, which keeps past/present/future history. Each document tab holds its own history (`src/state/tabs.ts`). Open and drop add tabs; only *Merge* appends pages to the current tab (with no tab open, it combines the picked files into one new tab, marked `merged` so reopening one of those files still gets its own tab). The `docs` map in `App.tsx` is shared across tabs, and closing a tab frees only documents that no remaining tab references, including through undo. The host de-duplicates by canonical path plus size and mtime (`OpenFiles` in `commands.rs`), so reopening an unchanged file returns the same `docId`. `App.tsx` wires commands, shortcuts and drop events onto it.
- **Memory is a product requirement** (1000-page documents must stay light). The render cache in `src/lib/renderCache.ts` has separate budgets for thumbnails and page views. Thumbnails share one IntersectionObserver (`useVisible` in `PageGrid.tsx`). Keep off-screen `<img>` elements mounted: measured, unmounting them raised WebView memory, because Chromium already discards off-screen decoded bitmaps.
- **Worker 0 is interactive** (view, extract, save). The other workers render thumbnails, so thumbnail floods never block editing. Workers load documents lazily from host-held bytes, so a replacement worker can pick up where a crashed one left off.
- **Bounded inputs everywhere:** 512 MB file limit with a `%PDF-` header check, bounded IPC frames, render size caps, and validated geometry and text lengths. Worker output is checked (PNG/JPEG magic bytes, saves start with `%PDF-`). Keep new requests and responses within these limits.
- Saves are atomic: the file is written to a temp file and then renamed over the target.
- **Comments are created in read view only.** Edit mode is for content edits; it shows new comments dimmed and never creates them. Comments live in `/Annots`, so comment-only edits must never set `changed` in `build` (the content stream stays byte-for-byte). Page-view renders leave out new and changed comments (`viewEdits` in `types.ts`) and the overlay (`AnnotationLayer.tsx`) draws them, so typing into a note never re-renders the page; a note in the file that was moved (`changedAnnots[].at`) is left out of the page render too and drawn by the overlay. Thumbnails and saves use the full edits. The worker rejects comments that are not on the page. Comment geometry is in the same display space as `TextBlock`; in read view the overlay is turned with the page, so map pointer positions with `toUnrotated` (`lib/textSelect.ts`). `changedAnnots` run before `removedAnnots`, because their indices refer to the original page.
- **The product name is display-only; installs depend on the internal names.** The app shipped as NovaPDF and is now NovaQuire. Only what users see uses the product name: `productName` in `tauri.conf.json`, `APP_NAME` in `src/lib/brand.ts` (a test keeps the two equal), the window title (read from `productName`), and release names. Never rename these, or auto-update breaks for existing installs: the app identifier `io.novapdf.app` (settings and WebView data, macOS bundle id, single-instance lock), the `novapdf` crate and program file (macOS restarts into it after an in-place update; both names' installs share it), the `novapdf.*` localStorage keys, and the updater endpoint and key (CI secrets). On Windows an install is keyed by product name, so `src-tauri/windows/hooks.nsh` retires the other name's install after installing; README "Product name and updates" has the release and rollback steps.

Debug-only hooks, compiled out of release builds:

- `NOVAPDF_DEV_OPEN="a.pdf;b.pdf"` pre-grants files.
- The main window is created hidden and shown on page load, with a 3 s fallback (`lib.rs`), to avoid a white flash at startup.
- `NOVAPDF_DEV_SAVE_TO` makes *Save as…* skip the native dialog (see `save_with_dialog` in `commands.rs`).
- `NOVAPDF_DEV_PICK=list.txt` makes *Open*/*Merge* return the paths in that file instead of showing the native dialog (see `open_with_dialog`).
- `NOVAPDF_DEV_DATA_DIR` puts the recent files list (`recent.json`) in that folder instead of the app's data folder (`recent_file` in `lib.rs`). `launchApp` gives each launch its own unless `dataDir` is passed, so tests never touch the developer's list.
- `NOVAPDF_DEV_MULTI_INSTANCE=1` turns off the single-instance lock (`single_instance` in `lib.rs`), so a test can open a second app to check a save. `launchApp` sets it unless `singleInstance: true`.

E2E tests depend on these.

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
