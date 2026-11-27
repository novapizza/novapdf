# Testing NovaQuire

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
| UI | 97.2% | 89.9% |
| Rust gated files | 83.4% | |

When coverage goes up, raise the numbers. Never lower them to make a change pass.

UI thresholds apply to each file, not to the average, so an untested function can't hide
inside a well-tested file. A new file with no tests at all fails the gate.

The Rust gate excludes these files:
- `main.rs`, `host.rs` and `sandbox.rs`: they need the running app, so the E2E suite covers them.
- `worker/mod.rs`: `tests/worker_process.rs` runs it end to end, but the sandboxed worker
  drops to Low integrity (macOS: Seatbelt) and can't write coverage data.

On macOS, `tests/worker_process.rs` also checks the worker sandbox: a probe re-runs the
test binary sandboxed and confirms writes, file reads, network and exec are blocked, and a
save must embed an installed TrueType font (so the font folders are still readable).
`host/tests.rs` checks that the memory watchdog kills a worker over the cap and that the
pool replaces it.
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

**Debug-build hooks** (all compiled out of release builds):
- `NOVAPDF_DEV_OPEN`: paths pre-granted as if they had been dropped on the window. Tests
  then emit the same `files-dropped` event the native drop handler emits, so files open
  through the real path.
- `NOVAPDF_DEV_SAVE_TO`: *Save as…* writes to this path instead of showing the native
  dialog. This lives in `save_with_dialog` in `commands.rs`.
- `NOVAPDF_DEV_PICK`: a text file of paths, one per line, that *Open* and *Merge* return
  instead of showing the native dialog. It is read on every call, so `app.pick([...])`
  sets the files for the next pick. This lives in `open_with_dialog` in `commands.rs`.
- `NOVAPDF_DEV_MULTI_INSTANCE`: turns off the one-app-at-a-time lock, so a test can open
  a second app to check a save. `launchApp` sets it unless the test passes
  `singleInstance: true` (see `e2e/window.spec.ts`). This lives in `single_instance` in `lib.rs`.

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

## Testing a rename update

A release that changes `productName` must be tested as a real auto-update from the last
released version before it ships (README, "Product name and updates"). Unit tests only check
that the names line up; on Windows the move between installs happens in the installer hook
(`src-tauri/windows/hooks.nsh`) and can only be seen by running it.

The test builds use a throwaway signing key and a local update server, so they never touch the
real update channel. They do use the real app identifier, so they share settings with an
installed copy on the same Windows account; restore it afterwards (last step).

1. Make a throwaway key: `npx tauri signer generate --ci -p test -w <dir>/test.key`.
2. Write a config overlay, `<dir>/old.conf.json`:
   ```json
   { "version": "0.2.1",
     "bundle": { "createUpdaterArtifacts": true, "targets": ["nsis"] },
     "plugins": { "updater": { "endpoints": ["http://127.0.0.1:8765/latest.json"],
                               "pubkey": "<contents of test.key.pub>",
                               "dangerousInsecureTransportProtocol": true } } }
   ```
   For each later build, copy it with a higher `version` and the `productName` to test.
3. Build with `TAURI_SIGNING_PRIVATE_KEY` (the key file's contents) and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=test` set:
   `npx tauri build --config <dir>/<overlay>.json`. Build the old version from the last
   released commit, the new ones from the branch.
4. Install the old build silently (`<setup>.exe /S`).
5. Put the new build's `*-setup.exe` and `.sig` in a folder, write its manifest with
   `TAG=v<version> RELEASE_BASE_URL=http://127.0.0.1:8765 node scripts/write-release-manifest.mjs <folder>`,
   and serve it: `python -m http.server 8765 --bind 127.0.0.1 --directory <folder>`.
6. Start the installed app, wait until the server log shows the setup download, then close
   the window normally. The update installs on exit.
7. Check, for the current Windows user:
   - Apps & features (`HKCU\...\Uninstall`) lists only the new name; the old install folder
     is gone.
   - Start menu and desktop shortcuts exist under the new name only and target the new
     folder; a taskbar pin still exists and targets the new folder. Pin the app before the
     first round and keep the pin through a rename and a rename back: a pin keeps the file
     name it was made with, so the rename back must find it by target, not by name.
   - `HKCU\Software\Classes\PDF document\shell\open\command` and
     `HKCU\Software\Classes\Applications\novapdf.exe\shell\open\command` point at the new
     folder; double-clicking a PDF opens the app.
   - Settings (theme, author name) are unchanged: `%LOCALAPPDATA%\io.novapdf.app` is kept.
   - The new app starts and can update again: repeat steps 5–7 towards the other name.
8. Restore: end on a build named like the copy you had installed, then install the official
   release over it with `<official setup>.exe /S`.

On macOS the updater replaces the app bundle in place, so check that an updated copy
starts, shows the new name in the menu bar and Dock, keeps its settings, and updates again.

## Known bugs pinned by tests

These tests are marked `it.fails` or `test.fail`. They pass while the bug exists and fail
once someone fixes it. When that happens, change the marker to `it` or `test`.

| Test | Bug |
|---|---|
| `src/components/Inspector.test.tsx`: "clearing Size reverts…" | Clearing the *Size* field and leaving it sets the text to 1 pt. `Number("")` is 0, which is then clamped to the minimum. |
| `e2e/watermark.spec.ts`: "finds watermarks tagged the way the PDF spec and Acrobat do" | `/Artifact /Subtype` is a name in the PDF spec (`/Watermark`). `has_watermark_mark` only reads it as a string, and `draw_watermark` writes it as the string `(Watermark)`. Tagged watermarks from other tools are not found, and NovaPDF's own tags are not spec-compliant. |
