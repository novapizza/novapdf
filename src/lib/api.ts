import { invoke } from "@tauri-apps/api/core";
import type {
  DocId,
  FontSpec,
  LayoutResult,
  OpenOutcome,
  PageAnnots,
  PageEdits,
  PageText,
  Rotation,
  TextChars,
  UpdateStatus,
  Watermark,
  WatermarkScan,
} from "./types";
import { editsAreEmpty } from "./types";

export interface RenderRequest {
  docId: DocId;
  pageIndex: number;
  width: number;
  format: "jpeg" | "png";
  rotation: Rotation;
  edits: PageEdits | null;
  watermark: Watermark | null;
  priority: "view" | "thumb";
}

export const api = {
  openWithDialog: () => invoke<OpenOutcome[]>("open_with_dialog"),
  openDropped: (paths: string[]) => invoke<OpenOutcome[]>("open_dropped", { paths }),
  /** Files the OS launched the app with (a double-clicked PDF), already granted for `openDropped`. */
  takeLaunchFiles: () => invoke<string[]>("take_launch_files"),
  closeDocument: (docId: DocId) => invoke<void>("close_document", { docId }),

  async renderPage(req: RenderRequest): Promise<Blob> {
    const args = { ...req, edits: req.edits && !editsAreEmpty(req.edits) ? req.edits : null };
    const bytes = await invoke<ArrayBuffer>("render_page", { args });
    return new Blob([bytes], { type: req.format === "png" ? "image/png" : "image/jpeg" });
  },

  extractPage: (docId: DocId, pageIndex: number) =>
    invoke<PageText>("extract_page", { docId, pageIndex }),

  findWatermarks: (docId: DocId, text: string | null) =>
    invoke<WatermarkScan>("find_watermarks", { docId, text }),

  /** Comments in the file on pages `first .. first + count` (at most 50). May return
   *  fewer pages than asked when the text is large: ask again from the next page. */
  listAnnotations: (docId: DocId, first: number, count: number, background: boolean) =>
    invoke<PageAnnots[]>("list_annotations", { docId, first, count, background }),

  textChars: (docId: DocId, pageIndex: number) => invoke<TextChars>("text_chars", { docId, pageIndex }),

  saveWithDialog: (args: {
    pages: { docId: DocId; pageIndex: number; rotation: Rotation; edits: PageEdits | null }[];
    watermark: Watermark | null;
    sanitize: boolean;
    suggestedName: string;
  }) => invoke<{ path: string; warnings: string[] } | null>("save_with_dialog", { args }),

  layoutText: (args: {
    text: string;
    font: FontSpec;
    size: number;
    width: number | null;
    indent?: number;
    hScale?: number;
  }) =>
    invoke<LayoutResult>("layout_text", { args }),

  listFonts: () => invoke<string[]>("list_fonts"),

  checkUpdate: () => invoke<UpdateStatus>("check_update"),
  /** Downloads the update the last check found; it installs when the app quits. */
  downloadUpdate: () => invoke<void>("download_update"),
  /** Keeps a downloaded update from installing on quit. */
  discardUpdate: () => invoke<void>("discard_update"),
  /** On success the app restarts, so this only settles if the install failed. */
  installUpdate: () => invoke<void>("install_update"),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}
