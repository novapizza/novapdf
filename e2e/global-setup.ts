// Builds the debug app (incremental; fast when nothing changed) and writes the
// fixture PDFs before any E2E test runs.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { APP_EXE, FIXTURE_DIR, ROOT } from "./paths";
// @ts-expect-error plain .mjs helper without types
import { writeFixtures } from "./fixtures/make-pdfs.mjs";

export default function globalSetup() {
  if (process.platform !== "win32") {
    throw new Error("The E2E suite drives WebView2 and runs on Windows only.");
  }
  if (!process.env.E2E_SKIP_BUILD) {
    execSync("cargo build --manifest-path src-tauri/Cargo.toml", { cwd: ROOT, stdio: "inherit" });
  }
  if (!existsSync(APP_EXE)) throw new Error(`App not built: ${APP_EXE}`);
  writeFixtures(FIXTURE_DIR);
}
