import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const APP_EXE = join(ROOT, "src-tauri", "target", "debug", "novapdf.exe");
/** Fixtures, WebView2 profiles and saved files. Outside the repo so the Vite dev
 *  server (which serves the app under test) never watches or reloads on them. */
export const WORK_DIR = join(tmpdir(), "novapdf-e2e");
export const FIXTURE_DIR = join(WORK_DIR, "fixtures");
export const FIXTURES = {
  sample: join(FIXTURE_DIR, "sample.pdf"),
  second: join(FIXTURE_DIR, "second.pdf"),
  notPdf: join(FIXTURE_DIR, "not-a.pdf"),
  specWatermark: join(FIXTURE_DIR, "spec-watermark.pdf"),
  outlined: join(FIXTURE_DIR, "outlined.pdf"),
  protected: join(FIXTURE_DIR, "protected.pdf"),
};
