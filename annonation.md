# Comments and notes in read view: design review

Status: proposal, not started. No code has been changed yet.
Revision 2 (2026-11-22): adds problems found in the render, save and geometry code, and
changes three recommendations from revision 1 (see "Changes from revision 1").

Goal: in read view, the user can add comments and notes to a PDF, like the annotation
editor in pdf.js (sticky notes, highlights, free text, ink), and see comments that are
already in the file.

## Where things stand today

- **Existing annotations show up as pixels only.** Pages render with `FPDF_ANNOT`
  ([pdf.rs](src-tauri/src/worker/pdf.rs), `FPDF_RenderPageBitmap` call), so a sticky-note
  icon is visible, but clicking it does nothing and its text is never shown.
- **The only annotation edit is deletion.** `PageEdits` has `removedAnnots`
  ([types.ts](src/lib/types.ts), [protocol.rs](src-tauri/src/protocol.rs)), used by the
  watermark cleaner. Removal happens in `Writer::apply_edits_with`
  ([edit.rs](src-tauri/src/worker/edit.rs)).
- **Read mode has no text layer.** Text extraction runs only in edit mode
  ([PageSurface.tsx](src/components/PageSurface.tsx), the "text (edit mode only)" section),
  and `Extract` returns paragraphs and loose text, with no per-character boxes.
- **Save already keeps annotations.** `build` in [edit.rs](src-tauri/src/worker/edit.rs)
  imports pages with `import_pages`, and unchanged pages are copied untouched, so existing
  comments survive a save.
- **Sanitize on save is on by default** (`useState(true)` in [App.tsx](src/App.tsx)). It
  removes only risky annotation types, so comments are kept.

## Problems found in the code (must be designed around)

### P1. Adding annotations to `PageEdits` would re-render the page on every change

`renderKey` in [renderCache.ts](src/lib/renderCache.ts) hashes the whole request,
including `edits`. `PageSurface` passes the page's edits to the page-view render. If new
annotations live in `PageEdits` unchanged:

- every note added, moved or typed into changes the key and triggers a full page render
  on worker 0;
- the worker would draw the annotation into the bitmap **and** the UI overlay would draw it
  again (shown twice);
- `editsAreEmpty` becomes false, so the render takes the slower scratch-document path.

**Fix:** keep `annotations` in `PageEdits` (for undo/history), but strip them from
**page-view** render requests (`edits: { ...edits, annotations: [] }` before building the
request, and treat "only annotations" as empty). Thumbnails and save keep them. Add a
Vitest case asserting the page-view render key does not change when a note is added.

The same applies to `removedAnnots` and in-place changes to existing annotations made from
read view: the overlay can hide or restyle them instantly, but the bitmap still has the
old annotation drawn in. Options:
- render page views **without** `FPDF_ANNOT` and draw all annotations as overlay (big
  change, loses PDFium's appearance rendering), or
- **(recommended)** accept one re-render when an existing annotation is deleted or
  changed (rare), and avoid re-renders for new annotations (common).

### P2. Annotation-only edits must not rewrite page content

`apply_edits_with` returns `changed`, and `build` then calls `page.generate_content()`. A
comment that says "don't rewrite the original content, it damages it" explains why removed
objects are cut out of the bytes by `content.rs` instead. Annotations live in `/Annots`,
not in the content stream, so:

- adding, changing or removing annotations must **not** set `changed`;
- a page with only annotation edits must keep its content stream byte-for-byte.

Add a `pipeline.rs` assertion: content stream bytes are identical before and after adding
a note.

### P3. Coordinate space: use the same space as `TextBlock`

`TextBlock` coordinates are "PDF points in display space: origin top-left, y down"
([types.ts](src/lib/types.ts)). The worker maps them through `page.display_matrix()` and
its inverse, which already handles the **CropBox/MediaBox offset** and the page's own
`/Rotate`. Many real PDFs have a CropBox that does not start at (0, 0). Converting naively
from "PDF space" would put notes in the wrong place on those.

**Use the same display space for annotations** and convert with the same inverse matrix
in the worker (as `draw_block` does). The app-level rotation needs no conversion on save:
`set_rotation` rotates the whole page, and annotations go with it. In read view, apply
the app rotation only when drawing the overlay.

### P4. Deleting a note leaves its popup and replies behind

A sticky note (Text) usually has a separate `/Popup` annotation (its own index, with
`/Parent` pointing back), and replies are separate annotations with `/IRT` pointing at it.
Deleting only the note's index leaves an orphan popup and replies to nothing.

**Fix:** when the user deletes an existing comment, the UI adds the note **and** its popup
**and** its reply chain to `removedAnnots`. The annotation list from the worker must
include `popupIndex` and `inReplyTo` so the UI can work this out.

### P5. Remove + re-add loses data on existing annotations

Revision 1 suggested editing an existing comment by removing it and adding a new one. That
loses everything the app does not model: rich text (`/RC`), the original appearance,
`/NM`, creation date, and replies (their `/IRT` points at the old object).

**Fix:** add an in-place change list for existing annotations:

```ts
changedAnnots: { index: number; contents?: string; rect?: Rect; color?: RGB }[]
```

applied with `FPDFAnnot_SetStringValue` / `SetRect` / `SetColor`. When `contents` changes,
also set `/M` and remove `/RC` (otherwise viewers that prefer rich text show the old
text). FreeText is the exception: its visible text is in the appearance stream, so
changing it in place needs a new AP (see P7).

### P6. Text highlights need character boxes

Nothing in `Extract` gives per-character boxes, so text-snapped highlights need a new
bounded worker request (e.g. `TextQuads { docId, pageIndex }` returning lines of char
boxes via `FPDFText_GetCharBox` / `FPDFText_GetLooseCharBox`, or quads for a selected
range). Read view also needs a transparent text layer to select from.

**Cheaper first step:** a free-hand "marker" highlight (pdf.js calls it free highlight),
an Ink annotation with a wide translucent stroke, needs no text layer at all.

### P7. Appearance streams and flags

- As far as I know, PDFium generates appearance streams for Text, Highlight, Ink and
  Square, but not FreeText. **Verify per subtype** in `pipeline.rs` (create, save, reload,
  check `/AP`, render in PDFium) and write FreeText's stream with `FPDFAnnot_SetAP`.
- Set the **Print** flag (`FPDF_ANNOT_FLAG_PRINT`) on new annotations, or they disappear
  when printed.
- Set `/NM` (unique id, use the UI's `id`), `/M` and `/CreationDate` in PDF date format
  (`D:YYYYMMDDHHmmSS+HH'mm'`), `/T` (author).
- For notes, also create the `/Popup` annotation (closed). Acrobat expects one.
- Set `NoRotate` (and `NoZoom`) on notes so the icon stays upright and fixed-size.

### P8. Scanning a whole document must not block editing

A Comments panel for a 1000-page document needs annotations from every page. Worker 0 is
the interactive worker (view, extract, save). Do not scan all pages there in one request:

- load per page lazily as pages become visible (cheap, uses existing visibility), and
- fill the panel with a chunked, low-priority scan on a thumbnail worker, or in small
  batches between interactive requests. Keep a timeout and page cap per request.

## Suggested design (revised)

### 1. Data model

```ts
interface PageEdits {
  removedObjects: number[];
  removedAnnots: number[];      // existing: also used for comment delete (with popup + replies)
  blocks: TextBlock[];
  changedAnnots: AnnotChange[]; // new: in-place change of existing annotations (P5)
  annotations: NewAnnot[];      // new: annotations created in the app
}

// All geometry in the same display space as TextBlock (P3).
type NewAnnot =
  | { id: string; kind: "note";      rect: Rect; contents: string; color: RGB; author?: string; created: string; modified: string }
  | { id: string; kind: "freeText";  rect: Rect; text: string; font: FontSpec; size: number; color: RGB }
  | { id: string; kind: "highlight"; quads: Quad[]; color: RGB; contents?: string }
  | { id: string; kind: "ink";       strokes: Point[][]; color: RGB; width: number; opacity: number };
```

Mirror in `protocol.rs` with `#[serde(default)]` on the new fields, and update
`EMPTY_EDITS` / `editsAreEmpty` / `is_empty`. Undo/redo, per-tab history, merge and doc
freeing then work without new code.

### 2. Worker requests

- `Annotations { docId, pageIndex }` returns a bounded list per page:
  `index, subtype, rect (display space), contents, author, modified, color, popupIndex,
  inReplyTo, flags (hidden?)`. Skip Link and Widget (form fields); skip hidden ones.
- Later, `TextQuads` for highlights (P6).
- Writing happens inside the existing `Render` (thumbnails) and `Save`, after the
  `removedAnnots` pass, without setting `changed` (P2).

### 3. UI

- **Overlay** per mounted page: hit areas for existing annotations, drawn shapes for new
  ones. Only mount for mounted pages (memory budget).
- **Popup** on click: shows author, date, text. Editable for notes.
- **Comments panel**: all comments, grouped by page, with replies nested; click to jump;
  filter by text/author. Respect `removedAnnots` / `changedAnnots` when listing.
- **Toolbar** in read view: Note, Highlight, Free text, Draw, color swatches. Floating
  "Highlight / Comment" bar when text is selected (phase 3).
- **Undo granularity:** typing in a note is one history step, committed on blur or Enter,
  like paragraph editing (`finishEditing` in [DocumentView.tsx](src/components/DocumentView.tsx)).
  An empty new note is discarded on blur.
- **Keyboard:** Delete removes the selected annotation, Esc deselects, arrow keys nudge,
  Tab cycles through annotations on the page. Overlay elements need roles and labels.
- **Edit mode:** show annotations read-only (dimmed, with a toggle). No creating (see the
  decision below).

### 4. Security

Annotation data comes from hostile PDFs:

- Render `/Contents` as plain text only. Never render `/RC` (XHTML) as HTML.
- Read strings with PDFium's two-call pattern and **check the length before allocating**.
  Cap each string (e.g. 16 KB) and truncate.
- Cap annotations per page returned to the UI (e.g. 500) and say "N more not shown".
- Validate new annotations in `protocol.rs`: string lengths, number of quads, strokes,
  points per stroke, rect size within the page, finite numbers, colors.
- Strip control characters from text written into the PDF.
- Only create subtypes that have no actions, so they pass `sanitize_page`.
- Author name and dates are personal data. Take the author from a setting, never silently
  from the OS user name.

### 5. Other things to update

- "Read-only mode" pill in [DocumentView.tsx](src/components/DocumentView.tsx): rename
  (for example "Reading").
- Dirty state needs no change: `isDirty` compares workspace history in
  [tabs.ts](src/state/tabs.ts), so annotation edits count automatically.
- `CleanDialog` (watermark cleaner) also writes `removedAnnots`. Make sure the Comments
  panel hides annotations removed by it, and that watermark annotations are not listed as
  comments.
- README: feature table and "Known limitations" (FreeText appearance, no reply threads
  yet, rich text not shown).

### 6. Tests (required by the gates, see [TESTING.md](TESTING.md))

- Rust unit tests for validation of the new types, in sibling `tests.rs` files.
- `pipeline.rs` (one new section in the single test):
  - each subtype: create, save, reload, read back contents/rect/color; has `/AP`; has Print flag;
  - content stream unchanged on annotation-only pages (P2);
  - CropBox with non-zero origin: note lands in the right place (P3);
  - deleting a note also removes its popup (P4);
  - in-place change keeps `/NM` and replies (P5).
- `worker_process.rs`: the `Annotations` request, including caps on a hostile file with
  many/huge annotations.
- Vitest: reducer (add/change/remove, undo/redo), render key unchanged on new annotation
  (P1), overlay, popup, comments panel.
- E2E (`npm run test:e2e`, Windows): add a note in read view, save, open the saved file in
  a second instance with `launchApp()`, check the note is listed.
- Keep per-file coverage thresholds; add thresholds for new files.

## Suggested order (revised)

0. **Spike** in `pipeline.rs`: create each subtype with PDFium, check AP, flags, CropBox
   offset, content unchanged. Settles P2, P3 and P7 before any UI work.
1. View existing comments: `Annotations` request, overlay hit areas, popup, Comments panel.
   Read-only.
2. Sticky notes: add, edit (in place for existing), move, delete with popup and replies.
3. Free-hand marker highlight (Ink), then text-snapped highlight with `TextQuads`.
4. Free text (own appearance stream), ink drawing, shapes.
5. Replies (`/IRT`) and status (accepted/rejected).

## Decision: comments in Edit mode

**Create comments only in read view, but still show them in Edit mode.**

Why not create them in Edit mode:

- Clicks there already mean something: select a paragraph, pick a link target, delete an
  object.
- Two tool sets in one mode is confusing. Acrobat also keeps "Comment" separate from
  "Edit PDF".

Why still show them there (read-only, dimmed, with a toggle):

- If someone rewrites a paragraph under a highlight, the highlight's quads no longer match
  the text. The user needs to see that.
- Ideally, warn when an edited paragraph overlaps a highlight.

## Changes from revision 1

- Coordinates: display space like `TextBlock`, not raw PDF space (P3).
- Editing existing comments: in place via `changedAnnots`, not remove + re-add (P5).
- Page-view renders must ignore new annotations (P1); annotation-only pages must not
  rewrite content (P2).

## Open questions

- Where does the author name come from (setting, prompt on first comment)?
- Comments panel: left sidebar or right (where the edit-mode Inspector is)?
- Should "Sanitize" on save offer to remove all comments (for sharing a clean copy)?
- Flatten option: burn comments into page content on save?
- Should deleting or changing an existing annotation re-render the page (simple), or
  should page views be rendered without annotations and draw all of them as overlay
  (consistent, much more work)? Recommendation: re-render (P1).
