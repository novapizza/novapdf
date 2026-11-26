# Comments and notes in read view: design review

Status: phases 0 to 3 built (2026-11-26), plus ink. See "What was built" at the end, and
"Gaps found in review" for what is still open.
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

## Read-view integration

Decided (2026-11-26): read view is for reading and markup (comments, highlights, ink).
Edit mode is for real content edits only (text, images, objects). Comments are an
`/Annots` layer and real edits change the page content stream, so the split follows what
each one does to the file (see P2).

What read view needs that it does not have today:

1. **Its own tools and keys.** `interactive` in [PageSurface.tsx](src/components/PageSurface.tsx)
   is `editMode && …`. The tool state is reset when leaving edit mode
   ([DocumentView.tsx](src/components/DocumentView.tsx), "Leaving edit mode" effect), and
   the keyboard handler returns early when `!editMode`. Read view needs its own tool state
   (Hand, Select text, Note, Highlight, Ink) and keys (Delete, Esc, arrow keys, Tab).
   Switching mode must save an open note draft, the same way `finishEditing` works for
   paragraphs.
2. **Rotation in the overlay.** Read view lays pages out rotated
   (`displaySize(info, p.rotation)`); edit mode shows them unrotated. Annotations are
   stored in unrotated display space (P3), so the read-view overlay must map mouse
   positions (note placement, ink strokes, highlight areas) from the rotated screen back to
   unrotated page coordinates, and rotate when drawing. Edit mode needs no conversion.
   Tests: the four rotations × a page whose CropBox does not start at (0, 0).
3. **"Select" stays in read view.** The read toolbar's Select button currently jumps to
   edit mode ([App.tsx](src/App.tsx), "Reader tools"). It becomes text selection in read
   view (copy, then Highlight / Comment). The Edit button still goes to edit mode.
4. **Highlight is a read-view tool, so read view needs its own text layer.** Today the
   page text is only loaded in edit mode, for paragraph editing. Text-snapped highlights
   (and the Select tool from point 3) need it in read view as well. Loading text runs on
   worker 0 (the interactive worker), so do not load it for every page as the reader
   scrolls: load it only while Select or Highlight is active, and only for pages on
   screen. Ship the free-hand marker highlight (P6) first: it is also a read-view tool and
   needs no text layer.
5. **Stamp and Remove stamps** are already in the read toolbar, but a watermark changes
   the page content. Keep them there: they are dialogs and don't use clicks on the page,
   and Acrobat files Stamp under Comment. The rule is then: read view = markup plus
   document-wide tools in dialogs; edit mode = in-place content editing.
6. **Labels.** The "Read-only mode" pill with its lock icon (in `Filmstrip`,
   [DocumentView.tsx](src/components/DocumentView.tsx)) becomes wrong. Rename it (for
   example "Reading & review") and change the icon. Enable the Highlight / Note / Ink
   toolbar buttons that are disabled today.
7. **Edit mode** shows comments read-only and dimmed, with a toggle, and warns when an
   edited paragraph sits under a highlight (its highlight area goes stale).

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

## What was built (2026-11-26)

Built on branch `feature/annotations`:

- **Read view tools:** Hand (open comments), Select (select text, then Copy or
  Highlight), Highlight (drag over text), Note (click, type), Ink (pen, or a wide
  see-through marker in the highlight colour). Colour swatches per tool. Esc steps back:
  closes the card, clears the selection, then returns to the Hand.
- **Comments in the file:** listed per page on a thumbnail worker, with click targets in
  read view. A card shows author, date, text and replies. The text is edited in place
  (`changedAnnots`, P5). Delete removes the comment with its popup and replies (P4).
- **Marks tab** (left, in the filmstrip): every comment in the document, filled by a
  chunked background scan, with a filter and the author name setting.
- **Worker:** `worker/annots.rs`, with the `Annotations` and `TextChars` requests.
- **Tests:** a `pipeline.rs` section, `worker_process.rs`, unit tests, Vitest
  (`AnnotationLayer`, `MarksPanel`, `DocumentView` flows) and `e2e/comments.spec.ts`.

The spike settled P2, P3 and P7:

- PDFium writes `/AP` for Text, Highlight and Ink when it renders a page with
  annotations. Save forces this with a 1×1 render of pages that have new comments
  (`Page::generate_annot_appearances`).
- Flags (Print, plus NoZoom and NoRotate on notes), `/NM`, `/M`, `/CreationDate` and `/T`
  are written.
- Comment-only saves keep the content stream byte-for-byte.
- A CropBox with a non-zero origin and the app rotation both place comments correctly.

Where the build departs from the design:

- **No `/Popup` for new notes (P7).** PDFium can draw popup annotations onto the page.
  Acrobat, pdf.js and PDFium all open a note without one.
- **`changedAnnots` changes text only, not rect or colour.** PDFium refuses
  `FPDFAnnot_SetColor` on annotations that have an appearance stream, which is most of
  them.
- **No comment toggle in Edit mode.** New comments are drawn dimmed by the overlay.
  Comments already in the file are part of the page image there, as before.
- **The card saves on close.** It saves on blur, and also when it closes without a blur
  (switching mode). That second save waits a microtask, so React StrictMode's extra
  mount in development does not drop a new note.

Answered open questions:

- **Author:** a "Your name on new comments" field in the Marks tab, kept in local
  storage. It is empty by default and never taken from the OS.
- **Comments panel:** left, in the Marks tab.
- **Re-render or overlay:** deleting a comment in the file re-renders the page (P1). New
  and changed comments never do.

Not built yet: free text, shapes, replies and review status, a Sanitize option that
removes all comments, and flattening.

### Gaps found in review (2026-11-26), all fixed the same day

| Gap | Planned in | Fix |
|---|---|---|
| Caps on a hostile file were not tested. | Tests: `worker_process.rs`, "caps on a hostile file" | `comment_listing_is_capped_on_a_hostile_file` in [worker_process.rs](src-tauri/tests/worker_process.rs): 500 listed per page with `more` counting the rest, text cut at 20 000 characters, 4 MB of text per page and 8 MB per request (the list stops early). |
| New comments were not checked against the page size (only ±20 000 pt). | Security: "rect size within the page" | The worker rejects a new comment, or a moved note, that is not on the page (`annots::on_page`, 1 pt slack for rounding). The UI keeps pointer positions on the page, so it never sends one. |
| Notes could not be moved. | Order step 2: "add, edit, move, delete" | Drag a note with the Hand or Note tool. New notes change `x, y`; a note in the file gets `changedAnnots[].at` (its `/Rect` moves, same size, `contents` optional so cut text is never written back). The page render leaves a moved note in the file out and the overlay draws it, so a move re-renders the page once (like a delete, P1). Only notes move: markup stays with its text. |
| No keyboard access to comments. | UI, Keyboard | Every click target is a button in the Tab order; Enter or Space opens it. Arrow keys nudge the open note 1 pt (Shift: 10 pt), as seen on screen on a turned page. Each nudge is its own undo step. |

Covered differently: the planned "Highlight / Comment" bar for selected text has Copy and
Highlight; Highlight opens the comment card, so a comment can be typed straight away.

Also added: a highlight (or other text markup) that carries a comment, its own text or a
reply, shows a small badge at its top-right corner as seen on screen. With the Note tool
on, clicking a note opens it (it used to place a new note on top).
