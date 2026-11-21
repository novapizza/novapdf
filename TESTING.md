# Testing NovaPDF

Three layers. Each one gates on coverage or behaviour, so when you add code the test run
tells you what is missing.

| Layer | Tool | What it checks | Command |
|---|---|---|---|
| UI unit + integration | Vitest + Testing Library (jsdom, Tauri faked) | `src/**`: logic, components, whole-app flows | `npm run test:coverage` |
| Rust unit + pipeline | `cargo test` + cargo-llvm-cov | `src-tauri/**`: validation, geometry, text extraction, layout, real PDFium pipeline, worker process | `npm run coverage:rust` |
| End-to-end | Playwright over CDP into WebView2 | The real app: Rust host, sandboxed PDFium workers, UI, saved files | `npm run test:e2e` |

`npm run test:all` runs typecheck, both coverage gates and E2E, in that order.

## When you add or change a function

1. Write the code.
2. Run the gate for that side:
   - UI: `npm run test:coverage`
   - Rust: `npm run coverage:rust`
3. If you left something untested, the run fails and names the file and metric:
   ```
   ERROR: Coverage for functions (66.66%) does not meet "src/lib/**" threshold (98%) for .../src/lib/pageText.ts
   ```
4. Open the report to see the exact red lines:
   - UI: `coverage/index.html`
   - Rust: `npm run coverage:rust:html`, then `src-tauri/target/llvm-cov/html/index.html`
5. Add tests in the right place (table below) until the run passes.
6. If the change is a user-facing flow (a new tool, dialog, save option), also add an E2E test in `e2e/`.

### Where tests go

| You changed | Put the test in |
|---|---|
| `src/lib/x.ts`, `src/state/x.ts` | `x.test.ts` next to it. Pure logic: aim for every branch. |
| `src/components/X.tsx` | `X.test.tsx` next to it |
| `src/App.tsx` (wiring, shortcuts, commands) | `src/App.test.tsx` |
| `src-tauri/src/foo.rs` | `src-tauri/src/foo/tests.rs`, declared as `#[cfg(test)] mod tests;` at the end of `foo.rs` |
| Anything that needs real PDFium in-process | a new section inside the single test in `src-tauri/tests/pipeline.rs` (PDFium binds once per process) |
| Worker request handling (`worker/mod.rs`) | `src-tauri/tests/worker_process.rs` |
| A flow across UI + Rust + PDFium, or saved output | `e2e/*.spec.ts` |

Rust tests live in sibling `tests.rs` files on purpose. If they were inline, cargo-llvm-cov
would count the test code as covered lines and overstate each file's coverage.

### Thresholds (a ratchet)

| Scope | Lines | Statements | Functions | Branches |
|---|---|---|---|---|
| Every UI file (per file) | 85 | 80 | 65 | 74 |
| Each file in `src/lib/**` | 98 | 98 | 98 | 90 |
| Each file in `src/state/**` | 98 | 95 | 98 | 90 |
| Rust, total of gated files | 80 | | | |

The UI thresholds are in `vitest.config.ts`. The Rust threshold is `--fail-under-lines` in
`package.json`. Each is set a little below what the suite reaches today:

| Suite | Lines | Branches |
|---|---|---|
| UI | 94.8% | 86.8% |
| Rust gated files | 83.4% | |

When coverage goes up, raise the numbers. Never lower them to make a change pass.

UI thresholds apply to each file, not to the average, so an untested function can't hide
inside a well-tested file. A new file with no tests at all fails the gate.

The Rust gate excludes these files:
- `main.rs`, `host.rs` and `sandbox.rs`: they need the running app, so the E2E suite covers them.
- `worker/mod.rs`: `tests/worker_process.rs` runs it end to end, but the sandboxed worker
  drops to Low integrity and can't write coverage data.
- `tests.rs` files.

## Test helpers

**`src/test/tauri.ts`** is a fake Tauri backend for UI tests.

```ts
tauriMock.handle("extract_page", (args) => pageText());  // answer a command
tauriMock.emit("files-dropped", ["a.pdf"]);              // fire a backend event
tauriMock.ask.mockResolvedValue(false);                  // answer the native confirm
await tauriMock.requestClose();                          // user closes the window
expect(tauriMock.calls("save_with_dialog")).toHaveLength(1);
```

- Any command without a handler throws, so an unexpected backend call fails the test.
- Handlers are reset after each test.

**`src/test/fixtures.ts`** has builders for test data: `doc`, `page`, `block`,
`paragraph`, `pageText`, `opened`.

**`src/components/DocumentView.test.tsx`** has a harness that runs the editor against the
real workspace reducer, so edits round-trip the way they do in the app.

**`src/test/setup.ts`** fills in what jsdom lacks:
- `matchMedia`, `ResizeObserver` and `IntersectionObserver`
- canvas text measurement, at a fixed 0.5 em per character
- object URLs and pointer capture

## E2E details

Requirements:
- Windows with the WebView2 runtime.
- Rust and Node, as in the README.
- Port 1420 free, or the Vite dev server already running there. Playwright starts it if needed.

**What `npm run test:e2e` does**
1. Runs `cargo build`. Set `E2E_SKIP_BUILD=1` to skip it.
2. Writes the fixture PDFs from `e2e/fixtures/make-pdfs.mjs` (hand-written PDFs, no dependencies).
3. For each test, launches `src-tauri/target/debug/novapdf.exe` with a fresh WebView2
   profile and connects Playwright to it over the DevTools protocol.

**Debug-build hooks** (both are compiled out of release builds):
- `NOVAPDF_DEV_OPEN`: paths pre-granted as if they had been dropped on the window. Tests
  then emit the same `files-dropped` event the native drop handler emits, so files open
  through the real path.
- `NOVAPDF_DEV_SAVE_TO`: *Save as…* writes to this path instead of showing the native
  dialog. This lives in `save_with_dialog` in `commands.rs`.

**Writing a test:** use the `app` fixture from `e2e/app.ts`.
- Grant files with `test.use({ appOptions: { grants: [...], saveTo } })`.
- To check saved output, call `launchApp()` for a second instance and open the saved file
  in it. The save round-trip tests in `e2e/edit.spec.ts` do this.

**Output locations:**
- Fixtures, profiles and saved PDFs go in `%TEMP%\novapdf-e2e`. Keeping them out of the
  repo stops Vite from reloading the app mid-test.
- The HTML report and failure traces go in `e2e/.out/`.

Run E2E through `npm run test:e2e`, not `npx playwright test`. The script normalises the
drive letter. Without it, Playwright on Windows fails with "did not expect test.use()"
when the shell's working directory starts with a lower-case `c:\`.

## Known bugs pinned by tests

These tests are marked `it.fails` or `test.fail`. They pass while the bug exists and fail
once someone fixes it. When that happens, change the marker to `it` or `test`.

| Test | Bug |
|---|---|
| `src/components/Inspector.test.tsx`: "clearing Size reverts…" | Clearing the *Size* field and leaving it sets the text to 1 pt. `Number("")` is 0, which is then clamped to the minimum. |
| `e2e/open.spec.ts`: "a second drop while the first file is still opening…" | The `files-dropped` handler in `App.tsx` decides replace-vs-append when the drop arrives. A second drop while the first file is still opening also replaces, and the first document is silently discarded. |
| `e2e/watermark.spec.ts`: "finds watermarks tagged the way the PDF spec and Acrobat do" | `/Artifact /Subtype` is a name in the PDF spec (`/Watermark`). `has_watermark_mark` only reads it as a string, and `draw_watermark` writes it as the string `(Watermark)`. Tagged watermarks from other tools are not found, and NovaPDF's own tags are not spec-compliant. |
