# NovaQuire

Desktop PDF editor: organise pages (reorder, rotate, delete, merge), edit existing text,
add text boxes, and add or remove watermarks. Built with Tauri 2, Rust and native PDFium,
with a React + TypeScript UI.

The original Electron + PDFium-WASM spec is kept in [docs/original-spec.md](docs/original-spec.md);
see "Why this differs from the original spec" below.

## Run it

Prerequisites: Node 20+, Rust (stable), and on Windows the VS C++ Build Tools and WebView2.

```bash
npm install          # also downloads the pinned PDFium build into src-tauri/pdfium/
npm run tauri dev    # run the app
npm run tauri build  # installer in src-tauri/target/release/bundle/
npm run test:rust    # unit tests + end-to-end pipeline test against real PDFium
npm run typecheck
npm run test:all     # typecheck, UI + Rust coverage gates, E2E against the real app
```

See [TESTING.md](TESTING.md) for the test layers, coverage gates and where new tests go.

`npm run setup:pdfium -- --force` re-downloads PDFium. The release is pinned in
`scripts/fetch-pdfium.mjs` to the build that `pdfium-render`'s `pdfium_8125` feature targets.
Bump both together. Each download is checked against a pinned SHA-256 in that script, so
a bump also updates the hashes.

## Features

| Area | What it does |
|---|---|
| Tabs | Each opened or dropped PDF gets its own tab with its own pages and undo history. Opening a file that is already open (and unchanged on disk) switches to its tab. Ctrl+Tab / Ctrl+Shift+Tab switch, Ctrl+W or middle-click closes |
| Pages | Thumbnails, multi-select (Ctrl/Shift), drag to reorder, rotate (R / Shift+R), delete, merge more PDFs into the current tab, or with nothing open combine several into one new tab (*Merge PDFs*, Ctrl+Shift+O), undo/redo |
| Edit text | Click a paragraph → edit inline. Lines are grouped into paragraphs (columns and tables are kept apart). The edited paragraph is re-typeset with wrapping and alignment |
| Add text | Text boxes with font, size, colour, bold/italic, alignment, line height and wrap width. Drag to move |
| Comments | In read view: highlight text, add sticky notes, draw with a pen or a see-through marker, select and copy text. Notes can be dragged, or nudged with the arrow keys (Shift for 10 pt); Tab reaches every comment and Enter opens it. A highlight that carries a comment shows a small badge. Comments already in the file open in a card where their text can be edited in place or deleted (with their popup and replies). The *Marks* tab lists every comment in the document. Written as real PDF annotations (`/Annots`), never into the page content. Edit mode shows comments but does not create them |
| Outline | The *Outline* tab shows the file's bookmarks as a tree, collapsed where the file says. Clicking one goes to its page and the spot on it; the entry for the section being read is marked. Bookmarks follow pages that were moved, and are greyed out for pages that were removed. With merged files, each file's outline is listed under its name |
| Password-protected files | Opening one asks for its password; a wrong one can be retried. The tab shows a lock. A save keeps the password: the saved file is encrypted with AES-256 and opens with the same password |
| Recent files | The Library lists the last 10 files opened, newest first. A click reopens one, without a dialog. Files that were moved or deleted are taken off when clicked. The list can be cleared, and turned off in Settings (which also clears it) |
| Find | Ctrl+F in read view searches the text of the file, ignoring case and line breaks, and marks every match on the page. Enter and Shift+Enter step through them. Text is read page by page from the sandboxed worker and only the matches are kept |
| Watermark | Text watermark on every page (font, size, colour, opacity, angle), written as a real PDF object tagged `/Artifact /Watermark` |
| Remove watermarks | Finds tagged watermark artifacts, watermark annotations, and, given the text, untagged watermark text (fragments only when rotated or transparent, so body text is never touched) |
| Save | Builds a new PDF with PDFium. Unchanged pages are copied untouched (vector, links, annotations kept); the "Sanitize" option removes risky annotations |

Every preview is the real PDFium render of the edited page, so what you see is what is saved.

## Architecture

```
React UI (WebView)          Rust app process                 PDF worker processes (same exe, --pdf-worker)
------------------          ----------------                 ----------------------------------------------
no file access     invoke   commands.rs: dialogs, grants,    worker/  PDFium (C API via pdfium-render bindings)
blob: page images  ------>  host.rs: worker pool, timeouts,  -------> extract.rs  text → lines → paragraphs
edit model (JSON)           restart, doc bytes kept in RAM   stdin/   edit.rs     layout, text objects,
                                                             stdout   watermark, sanitize, render, save
```

* **Edits are data.** A page's edits are `{ removedObjects, removedAnnots, blocks,
  changedAnnots, annotations }` (see `src-tauri/src/protocol.rs`). Source documents are never modified. Rendering an edited page
  copies that page into a scratch document and applies the edits; saving does the same into
  a fresh document. Undo/redo is just UI state.
* **Worker pool.** Worker 0 handles interactive work (page view, text extraction, save), and
  the others render thumbnails, so a 500-page thumbnail flood never blocks the editor.
  Workers load documents lazily from bytes the host keeps, so a crashed worker is replaced
  transparently. Worker 0 is started in the background at launch, so the first open does
  not wait for PDFium to load.
* **Memory.** A document's bytes are held once: on Windows the host copies them into an
  anonymous shared-memory section and gives each worker a map-read-only handle
  (`src-tauri/src/shared.rs`), instead of every process keeping its own copy. PDFium's
  caches grow with every page a worker touches, so thumbnail workers are replaced after
  300 renders and workers holding documents are stopped after being idle (30 s for
  thumbnail workers, 3 min for worker 0). The UI keeps separate render-cache budgets for
  thumbnails (96 MB) and page views (128 MB), and all thumbnails share one
  IntersectionObserver.
* **Fonts.** Embedded PDF fonts are not reused: they are usually subsets and may not be
  re-embeddable. New text uses a standard-14 font when the family matches and the text is
  WinAnsi (nothing embedded). Otherwise it uses an installed TrueType font that covers every
  character, embedded in full; Vietnamese, for example, takes this path.

## Security model

PDF is a hostile format, so untrusted bytes are parsed only in the worker:

* **Process isolation.** PDFium runs in separate worker processes. A crash or a hang (render
  30 s, extract 30 s, save 300 s timeouts) kills only that worker; the app restarts it.
* **Windows sandbox.** Each worker runs in its own Job Object: 3 GB memory cap, no child
  processes, UI restrictions, and it is killed with the app. It drops to **Low integrity**
  (no writes to user files or the registry) and enables mitigations: no dynamic code, no
  extension-point DLLs, no remote or low-label image loads, strict handle checks. The
  mitigations are best-effort; a worker that cannot drop to Low integrity exits before it
  reads any document.
* **macOS sandbox.** Once PDFium is loaded, each worker enters a Seatbelt sandbox that denies
  everything except reading the installed font folders: no file writes, no other file
  reads, no network, no starting programs. A worker that cannot enter the sandbox exits
  before it reads any document. The host checks each worker's memory every
  0.5 s and kills one that goes over 3 GB; the app restarts it.
* On every platform the worker's environment is cleared, and it never touches the file
  system for documents (bytes in, bytes out over pipes).
* **No PDF JavaScript.** The bundled PDFium build has no V8/XFA, and no form-fill environment
  is created.
* **Output.** Saving builds a new document page by page, so document-level JavaScript,
  OpenAction, embedded files and XFA are never copied. With *Sanitize* on (the default), link
  annotations with JavaScript, Launch or remote actions and non-http(s)/mailto URIs are
  removed, as are file-attachment, sound, movie, screen, rich-media and 3D annotations.
* **UI has no file access.** Open and save dialogs run in Rust. Dropped files, and files
  the OS opens the app with (a double-clicked PDF: the command line on Windows, an
  open-documents event on macOS), are recorded as one-time grants in Rust before the UI
  hears about them. The recent files list is kept in Rust as well: the UI gets file names
  and ids, never paths, and reopens an entry by its id, so it still cannot name a file to
  read. A file that needs a password is held in Rust under a one-time id that the UI
  sends with the password. Passwords are kept in memory only while their document is
  open (any worker may have to load it again), are never written to disk, and are
  overwritten when the document closes. The UI
  capability set has no fs or dialog open/save permissions. A strict CSP is set, and
  navigation away from the app is blocked.
* **Bounded inputs.** 512 MB file limit with a `%PDF-` header check, bounded IPC frames,
  render size caps, validated edit geometry and text lengths. Worker output is checked
  (images must be PNG/JPEG, saves must start with `%PDF-`) before use.
* **Atomic saves.** Output is written to a temporary file and renamed over the target.

## Known limitations

* Editing a paragraph applies one style to it (a warning is shown for mixed styles), drops
  first-line indents and justification, and reflows with the substituted font, so line
  breaks can differ slightly from the original.
* Text inside Form XObjects, rotated text and invisible OCR text are not editable as
  paragraphs (rotated text can still be deleted).
* Page-level `/AA` actions cannot be removed through PDFium's API. Copied form widgets keep
  their appearance but lose the AcroForm dictionary.
* Password-protected PDFs: a save keeps the open password (AES-256), but not the
  original's restrictions (printing, copying, editing): the saved file grants every
  permission. Files with only restrictions and no open password already opened without a
  prompt, and are still saved without protection. A save that combines files with
  different passwords uses the password of the first protected one in page order (the
  save warns).
* The OS sandbox covers Windows and macOS. On Linux the worker is still isolated with
  timeouts and restart, but has no sandbox or memory cap; add seccomp/landlock before
  shipping there.
* The macOS memory cap is polled, so a worker can overshoot 3 GB by whatever it allocates
  in half a second before it is stopped.
* The page editor shows pages in their original orientation; the app-level rotation is
  applied on save and in thumbnails.
* Comments: free text, shapes, replies and review status cannot be created yet. Rich text
  (`/RC`) is never shown (only the plain `/Contents`); editing a comment that has rich text
  replaces it with the plain text. New notes get no `/Popup` annotation (viewers create one
  when the note is opened). A highlight stays where it was drawn when the text under it is
  edited (the editor warns).
* Find searches the text of the file as opened, in read view only: text you changed or
  added in the editor is not found until the document is saved and reopened. Scanned
  pages without a text layer have nothing to find. A search stops after 2,000 matches.
* Bookmarks are shown but not edited, and a saved PDF has none: saving builds a new
  document page by page, and the outline is not carried over. Long outlines are capped
  (10,000 entries, 32 levels); past 200 distinct pages, a bookmark goes to the top of its
  page rather than the exact spot.

## Why this differs from the original spec

| Spec | Here | Reason |
|---|---|---|
| Electron + PDFium WASM | Tauri 2 + native PDFium | ~20 MB vs ~150 MB, no WASM heap limit, and OS-level sandboxing of the parser |
| Strip text, render the background to canvas, overlay HTML, export via `printToPDF` | Edit the PDF itself with PDFium page objects | `printToPDF` would rasterise every page and drop links, forms, bookmarks and metadata |
| Reuse extracted embedded fonts in `FontFace` | Standard-14 or installed TrueType | Subset/CFF/Type1 fonts can't render newly typed characters or be re-embedded |
| TipTap/Lexical rich text | Plain text per paragraph with block-level style | Smaller attack surface; per-run styling is a possible next step |

## Developer notes

* `NOVAPDF_INSPECT=file.pdf cargo test --manifest-path src-tauri/Cargo.toml --test inspect -- --ignored --nocapture`
  prints the paragraphs PDFium sees and writes `target/inspect-N.png`.
* Debug builds only: `NOVAPDF_DEV_OPEN="a.pdf;b.pdf"` pre-grants files as if dropped, and
  `NOVAPDF_DEV_PICK=list.txt` makes Open/Merge return the paths listed in that file instead
  of showing the native dialog, for scripted UI tests (drive the WebView via
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`).

## Product name and updates

The app shipped as NovaPDF up to 0.2.1 and is now NovaQuire. Installed copies move to the
new name through the normal auto-update; nobody has to reinstall.

- **What changes:** only the name people see (window, menus, installer, Start menu, Dock,
  release names). It lives in `productName` in `src-tauri/tauri.conf.json` and `APP_NAME` in
  `src/lib/brand.ts`, which a test keeps equal.
- **What must never change**, or existing installs stop updating or lose their settings: the
  app identifier `io.novapdf.app`, the `novapdf` crate and program file, the `novapdf.*`
  settings keys, and the updater endpoint and signing key.
- **Windows:** an install is keyed by its product name, so the new installer would otherwise
  sit next to the old one. `src-tauri/windows/hooks.nsh` retires the other name's install
  after installing: it deletes that install's program, shortcuts and Apps & features entry,
  re-creates the shortcuts under the new name and points a taskbar pin at the new program. It
  keeps settings and the PDF file association, and touches nothing if the old program is
  still locked (the next update retries).
- **macOS:** the updater replaces the app in place, so it keeps its path. An updated copy is
  still the file `NovaPDF.app` in Finder, while the Dock, menu bar and window say NovaQuire.
  New downloads are `NovaQuire.app`.

**If a renamed release fails to update people:**

1. Stop the rollout: re-upload the previous release's `latest.json` to the bucket. Copies
   that have not updated keep the old version and keep checking.
2. Copies already on the new release go back with a newer version under the old name: set
   `productName` and `APP_NAME` to `NovaPDF`, set the release names in
   `.github/workflows/release.yml`, bump the version and release. Its installer retires the
   NovaQuire install the same way.
3. Fix the problem, then rename forward again with a higher version. Repeat until it sticks;
   every step is an ordinary update because the hook is symmetric and the internal names
   never change.

Before releasing a renamed version, test the update from the last released version on
Windows and macOS (see `TESTING.md`, "Testing a rename update").

## License

NovaQuire is released under the [MIT License](LICENSE).

The installers bundle third-party code under its own licenses, and ship those licenses with it:

- PDFium (BSD-3-Clause and Apache-2.0) and the libraries built into it, such as FreeType,
  ICU and libjpeg-turbo. `npm install` fetches the binary together with its license files
  into `src-tauri/pdfium/licenses/`, and they are installed next to the library.
- The Rust crates and npm packages the app is built from, and the bundled OFL fonts. Their
  licenses are in [src-tauri/THIRD-PARTY-NOTICES.txt](src-tauri/THIRD-PARTY-NOTICES.txt),
  which is installed with the app. After changing dependencies, run `npm run notices` and
  commit the result; the release workflow fails if the file is out of date
  (`npm run notices:check`).

When text needs a font that is not one of the PDF standard fonts, saving embeds an installed
font. Fonts whose license forbids embedding (OS/2 `fsType` "Restricted") are skipped.
