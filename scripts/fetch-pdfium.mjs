// Downloads the prebuilt PDFium shared library (bblanchon/pdfium-binaries) for the
// current platform into src-tauri/pdfium/, where Tauri bundles it as a resource.
//
// The release is pinned to the PDFium build that pdfium-render's `pdfium_latest`
// feature targets. Bump both together.
//
// Usage: node scripts/fetch-pdfium.mjs [--force]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PDFIUM_RELEASE = "chromium/8125";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "pdfium");
const stampFile = join(outDir, "VERSION");
const force = process.argv.includes("--force");

const targets = {
  "win32-x64": { asset: "pdfium-win-x64.tgz", lib: "bin/pdfium.dll" },
  "win32-arm64": { asset: "pdfium-win-arm64.tgz", lib: "bin/pdfium.dll" },
  "darwin-x64": { asset: "pdfium-mac-x64.tgz", lib: "lib/libpdfium.dylib" },
  "darwin-arm64": { asset: "pdfium-mac-arm64.tgz", lib: "lib/libpdfium.dylib" },
  "linux-x64": { asset: "pdfium-linux-x64.tgz", lib: "lib/libpdfium.so" },
  "linux-arm64": { asset: "pdfium-linux-arm64.tgz", lib: "lib/libpdfium.so" },
};

const key = `${process.platform}-${process.arch}`;
const target = targets[key];
if (!target) {
  console.error(`[pdfium] No prebuilt PDFium configured for ${key}.`);
  process.exit(1);
}

const libName = target.lib.split("/").pop();
if (!force && existsSync(join(outDir, libName)) && existsSync(stampFile)) {
  if (readFileSync(stampFile, "utf8").trim() === PDFIUM_RELEASE) {
    console.log(`[pdfium] ${libName} (${PDFIUM_RELEASE}) already present.`);
    process.exit(0);
  }
}

const url = `https://github.com/bblanchon/pdfium-binaries/releases/download/${encodeURIComponent(
  PDFIUM_RELEASE,
)}/${target.asset}`;
const work = join(tmpdir(), `novapdf-pdfium-${Date.now()}`);
mkdirSync(work, { recursive: true });

try {
  console.log(`[pdfium] Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const archive = join(work, target.asset);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));

  // `tar` ships with Windows 10+, macOS and Linux.
  execFileSync("tar", ["-xzf", target.asset], { cwd: work, stdio: "inherit" });

  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(work, target.lib), join(outDir, libName));
  if (existsSync(join(work, "LICENSE"))) copyFileSync(join(work, "LICENSE"), join(outDir, "LICENSE"));
  writeFileSync(stampFile, `${PDFIUM_RELEASE}\n`);
  console.log(`[pdfium] Installed ${libName} -> ${outDir}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
