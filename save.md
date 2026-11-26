# Save to the original file: design review

Status: proposed (2026-11-26), not built.

Goal: the Save button becomes a split button with a dropdown. The default action stays
**Save as…**; **Save** (overwrite the file the tab was opened from) is the second option.

## Why plain Save is not a normal save here

Save builds a new document and copies pages into it one by one (`build` in
[edit.rs](src-tauri/src/worker/edit.rs), `out.import_pages`). That is deliberate: doc-level
JavaScript, OpenAction, embedded files and XFA are never carried over. But page import
also leaves out document-level parts the user may care about:

- bookmarks (outline) and named destinations
- the document information dictionary and XMP metadata (title, author, ...)
- page labels
- the AcroForm dictionary (README: copied form widgets "lose the AcroForm dictionary")
- the structure tree (tagged PDF, accessibility)
- embedded files
- digital signatures (they become invalid anyway once the file changes)

With *Save as…* the original keeps all of this. With *Save* it is gone for good, without a
word to the user. (Based on how PDFium page import works; not yet verified with a test file
that has bookmarks.)

## Requirements

1. **Warn or block when something would be lost.** At open, the worker reports whether the
   document has an outline, AcroForm fields, a signature, embedded files or page labels.
   - Signed: Save is disabled (tooltip says why); only Save as… is offered.
   - Other losses: Save asks first, naming what will be removed
     ("Saving will remove the bookmarks and form fields from report.pdf").
   - Nothing lost: Save writes directly.
2. **Do not overwrite changes made by another program.** The host already records size and
   mtime per open file (`OpenFiles` in [commands.rs](src-tauri/src/commands.rs)). If either
   differs at save time, refuse and offer Save as….
3. **The UI never sends a path.** A new command (e.g. `save_to_original { docId, ... }`)
   takes the document id; Rust resolves the path from its own `OpenFiles` record. This keeps
   "the UI has no file access" true.
4. **Only for single-source tabs.** Save is offered only when every page of the tab comes
   from one document that was opened from a path. Merged tabs, tabs with pages appended by
   *Merge*, have only Save as….
5. **Windows details.**
   - If the file is locked (open in Acrobat, for example), the rename fails: show a plain
     message ("report.pdf is open in another program"), not the raw OS error.
   - `write_atomically` replaces the file, which resets ACLs and attributes. Use
     `ReplaceFileW` when the target exists, which keeps them.
6. **State after a successful Save.**
   - Clear "Unsaved changes" (mark the current history entry as saved).
   - Update the recorded size and mtime in `OpenFiles`, so reopening the file switches to
     this tab instead of opening a new one.
   - Keep undo history.
   - Keep the in-memory bytes: edits are applied on top of them, so a second Save gives the
     same result.
7. **Shortcuts.** Ctrl+S stays on Save as…. Do not bind Ctrl+S to the overwrite, given
   point 1. (Revisit once nothing is lost on save.)

## Security

- No new file-system permission in the UI capability set.
- The overwrite target is only ever a path the host itself opened (dialog, drop grant or OS
  open), looked up by doc id.
- The same output checks as today: worker output must start with `%PDF-`, atomic write.

## Tests (gates in [TESTING.md](TESTING.md))

- Rust unit tests (`commands/tests.rs`): no source path, merged tab, file changed on disk,
  signed document, locked file message.
- `pipeline.rs` section: the "what would be lost" report for a PDF with an outline, a form
  and an embedded file.
- Vitest (`App.test.tsx`): the split button and dropdown, Save disabled with a reason,
  confirm dialog, dirty flag cleared after Save.
- E2E: copy a fixture, open it, edit, Save, then open the file in a second instance with
  `launchApp()` and check the edit is there.

## Suggested order

1. Host: `save_to_original` with requirements 2, 3, 4 and 6.
2. Worker: the "what would be lost" report; UI confirm/disable (requirement 1).
3. UI split button and dropdown.
4. Windows polish (requirement 5).

Ship 1 to 3 together; 4 can follow.
