# Technical Specification: Electron + PDFium WASM Inline PDF Editor

## 1. Project Overview
Build a desktop PDF editor using **Electron (Chromium)** and **PDFium WASM (`@embedpdf/pdfium`)** that supports:
1. **Structural PDF Operations:** Reorder pages, delete pages, and merge multiple PDF files natively in binary.
2. **Inline Paragraph & Watermark Editing:** Convert PDF pages into a layered canvas-plus-DOM structure where background vector graphics remain intact while text is reconstructed into semantic, reflowable HTML `<p>` blocks for inline rich-text editing.
3. **Font Preservation:** Extract embedded PDF fonts (or match local OS fonts) so edited HTML matches the original typography.
4. **Local PDF Export:** Compile the edited DOM back into a clean PDF using Electron's native `webContents.printToPDF()`.

*(Note: Raster image extraction/editing is explicitly out of scope; raster images embedded in the PDF remain baked into the background layer.)*

---

## 2. Core Tech Stack
- **Desktop Runtime:** Electron (Main + Preload + Renderer architecture)
- **PDF Engine:** `@embedpdf/pdfium` (WebAssembly build of Google's PDFium, Apache 2.0/MIT licensed)
- **Frontend Framework:** React / TypeScript (or Vue/Vanilla TS)
- **Inline Rich-Text Editor:** TipTap (ProseMirror-based) or Lexical for controlled paragraph reflow and cursor management
- **PDF Compiler / Exporter:** Electron `webContents.printToPDF()` with `@media print` CSS

---

## 3. System Architecture & Pipeline

### A. Dual-Mode Processing Pipeline
Split operations into two execution paths for optimal speed and fidelity:

1. **Fast Binary Mode (Page Organizer — Pure PDFium WASM):**
   - Used for **merging files**, **reordering pages**, and **deleting pages**.
   - Operates directly on PDF byte buffers in a Web Worker using PDFium C++ APIs (`FPDF_ImportPages`, `FPDFPage_Delete`, `FPDFPage_Move`, `FPDF_SaveAsCopy`) without converting to HTML.
2. **Inline Edit Mode (Hybrid Canvas + HTML Overlay):**
   - **Step 1 (Text & Font Extraction):** Parse page text objects via `FPDFText_*` and `FPDFPageObj_*` APIs to extract characters, bounding boxes, transformation matrices, font names, font sizes, and colors.
   - **Step 2 (Font Loading):** Extract embedded font binaries via `FPDFFont_GetFontData()`. If the font is subsetted (prefixed with `XXXXXX+`), check `window.queryLocalFonts()` in Electron to prefer the full local system font if installed; otherwise load the extracted `ArrayBuffer` via `new FontFace()` and pair with a metric-compatible fallback stack.
   - **Step 3 (Background Layer Generation):** Clone/modify the PDFium page in memory by iterating through page objects (`FPDFPage_CountObjects` / `FPDFPage_GetObject`) and removing all `FPDF_PAGEOBJ_TEXT` items (`FPDFPage_RemoveObject`). Render the remaining vectors, borders, tables, and backgrounds to an HTML5 `<canvas>` (or high-DPI image) as the non-editable bottom layer.
   - **Step 4 (Paragraph Reconstruction):** Group extracted text spans into lines (matching Y-baselines) and merge consecutive lines into semantic `<p>` blocks when they share font family, font size, left-margin alignment ($\pm 2\text{pt}$), and standard line-height spacing ($1.1\times$–$1.4\times$).
   - **Step 5 (Inline Editing & Watermarks):** Mount reconstructed `<p>` blocks inside a TipTap/Lexical editor positioned over the clean background `<canvas>` inside fixed-dimension page containers (e.g., `8.5in × 11in`). Overlay customizable DOM/CSS watermarks (`position: absolute; pointer-events: none; transform: rotate(-45deg)`).
   - **Step 6 (PDF Export):** Trigger Electron Main Process `win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })` while using `@media print` CSS to hide app chrome, toolbars, and active selection borders.

---

## 4. Key Implementation Requirements & Constraints

### Electron & WASM Integration
- Load the `.wasm` binary cleanly in Electron without `file://` CORS issues (either read via `fs.readFileSync` in Preload and pass `wasmBinary` to PDFium init, or serve via a custom `app://` protocol).
- Run PDFium WASM operations inside a **Web Worker** so large multi-page PDFs do not block the UI thread.
- Strictly manage WASM heap memory (`wasmExports.malloc` / `free`) and close handles (`FPDFText_ClosePage`, `FPDF_ClosePage`, `FPDF_CloseDocument`) inside `try...finally` blocks to prevent memory leaks.

### Watermark Handling
- **Adding Watermarks:** Render a configurable CSS watermark layer across all `.page` containers so users can adjust text, opacity, angle, and color in real time before `printToPDF()`.
- **Removing Existing Watermarks:**
  - Text-based watermarks are automatically converted into selectable HTML blocks during text extraction, allowing users to click and delete them.
  - Provide an option to inspect and strip `FPDF_ANNOT_WATERMARK` annotations (`FPDFPage_RemoveAnnot`) or rotated/semi-transparent `FPDF_PAGEOBJ_FORM` objects during background rendering.

### Page Overflow & Pagination
- Each PDF page must render inside a fixed-dimension CSS container matching the original PDF page size (`FPDF_GetPageWidthF` / `FPDF_GetPageHeightF` converted from points to CSS pixels/inches).
- Handle paragraph growth gracefully when users add lines of text (either via CSS overflow detection pushing trailing blocks to the next page container or adjustable block bounding boxes).

---

## 5. Suggested Build Phases for Implementation
1. **Phase 1 — Electron + PDFium WASM Boilerplate:** Set up Electron (Main/Preload/Renderer), load `@embedpdf/pdfium` in a Web Worker, and implement file open, thumbnail rendering, page deletion, reordering, and file merging.
2. **Phase 2 — Background Stripping & Font Loader:** Implement `FPDF_PAGEOBJ_TEXT` stripping to render text-free background canvases, plus `FPDFFont_GetFontData` + `FontFace` / `queryLocalFonts()` loading.
3. **Phase 3 — Paragraph Grouping & TipTap Overlay:** Build the heuristic line-to-paragraph grouping engine and mount TipTap editable `<p>` blocks over the background canvas.
4. **Phase 4 — Watermark Layer & `printToPDF` Export:** Add customizable watermark controls, `@media print` stylesheets, and IPC handlers for saving the final PDF via `webContents.printToPDF()`.