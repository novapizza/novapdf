// Downloads the prebuilt PDFium shared library (bblanchon/pdfium-binaries) for the
// current platform into src-tauri/pdfium/, where Tauri bundles it as a resource.
//
// The release is pinned to the PDFium build that pdfium-render's `pdfium_latest`
// feature targets. Bump both together.
//
// Usage: node scripts/fetch-pdfium.mjs [--force] [--universal]
//
// --universal (macOS only) merges the arm64 and x64 builds with lipo, for
// `tauri build --target universal-apple-darwin`.

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
const universal = process.argv.includes("--universal");

const targets = {
  "win32-x64": { asset: "pdfium-win-x64.tgz", lib: "bin/pdfium.dll" },
  "win32-arm64": { asset: "pdfium-win-arm64.tgz", lib: "bin/pdfium.dll" },
  "darwin-x64": { asset: "pdfium-mac-x64.tgz", lib: "lib/libpdfium.dylib" },
  "darwin-arm64": { asset: "pdfium-mac-arm64.tgz", lib: "lib/libpdfium.dylib" },
  "linux-x64": { asset: "pdfium-linux-x64.tgz", lib: "lib/libpdfium.so" },
  "linux-arm64": { asset: "pdfium-linux-arm64.tgz", lib: "lib/libpdfium.so" },
};

if (universal && process.platform !== "darwin") {
  console.error("[pdfium] --universal is only supported on macOS.");
  process.exit(1);
}

const keys = universal ? ["darwin-arm64", "darwin-x64"] : [`${process.platform}-${process.arch}`];
const target = targets[keys[0]];
if (!target) {
  console.error(`[pdfium] No prebuilt PDFium configured for ${keys[0]}.`);
  process.exit(1);
}

// The stamp records the arch set too, so switching to or from --universal refetches.
const stamp = `${PDFIUM_RELEASE}${universal ? " universal" : ""}`;
const libName = target.lib.split("/").pop();
if (!force && existsSync(join(outDir, libName)) && existsSync(stampFile)) {
  if (readFileSync(stampFile, "utf8").trim() === stamp) {
    console.log(`[pdfium] ${libName} (${stamp}) already present.`);
    process.exit(0);
  }
}

const work = join(tmpdir(), `novapdf-pdfium-${Date.now()}`);
mkdirSync(work, { recursive: true });

// Downloads and unpacks one target's archive into its own folder; returns that folder.
async function fetchTarget(key) {
  const { asset } = targets[key];
  const dir = join(work, key);
  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/bblanchon/pdfium-binaries/releases/download/${encodeURIComponent(
    PDFIUM_RELEASE,
  )}/${asset}`;
  console.log(`[pdfium] Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  writeFileSync(join(dir, asset), Buffer.from(await res.arrayBuffer()));
  // `tar` ships with Windows 10+, macOS and Linux.
  execFileSync("tar", ["-xzf", asset], { cwd: dir, stdio: "inherit" });
  return dir;
}

try {
  const dirs = [];
  for (const key of keys) dirs.push(await fetchTarget(key));

  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, libName);
  if (universal) {
    execFileSync("lipo", ["-create", ...dirs.map((d) => join(d, target.lib)), "-output", out], {
      stdio: "inherit",
    });
  } else {
    copyFileSync(join(dirs[0], target.lib), out);
  }
  if (existsSync(join(dirs[0], "LICENSE"))) copyFileSync(join(dirs[0], "LICENSE"), join(outDir, "LICENSE"));
  writeFileSync(stampFile, `${stamp}\n`);
  console.log(`[pdfium] Installed ${libName} -> ${outDir}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
