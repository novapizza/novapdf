// Downloads the prebuilt PDFium shared library (bblanchon/pdfium-binaries) for the
// current platform into src-tauri/pdfium/, where Tauri bundles it as a resource.
//
// The release is pinned to the PDFium build that pdfium-render's `pdfium_latest`
// feature targets. Bump both together.
//
// Each archive is checked against a pinned SHA-256 before it is unpacked, so a
// replaced or tampered release asset fails the build instead of being bundled
// (and, in the release workflow, signed). When bumping PDFIUM_RELEASE, take the
// new hashes from the release's asset digests and confirm them by hashing the
// downloads yourself.
//
// Usage: node scripts/fetch-pdfium.mjs [--force] [--universal]
//
// --universal (macOS only) merges the arm64 and x64 builds with lipo, for
// `tauri build --target universal-apple-darwin`.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  "win32-x64": {
    asset: "pdfium-win-x64.tgz",
    lib: "bin/pdfium.dll",
    sha256: "9a964261760cff52570aabf038ab346d3a5034dd8b30d0d5fe8861235d356b8b",
  },
  "win32-arm64": {
    asset: "pdfium-win-arm64.tgz",
    lib: "bin/pdfium.dll",
    sha256: "d394ba61991fb53f4d87f70988035f337d9e73f2bd2c3c1b966df8c43fcabb05",
  },
  "darwin-x64": {
    asset: "pdfium-mac-x64.tgz",
    lib: "lib/libpdfium.dylib",
    sha256: "8a5193535b80c7215d8932f6647ae5097465b6dba2811602c21e120c2af112b0",
  },
  "darwin-arm64": {
    asset: "pdfium-mac-arm64.tgz",
    lib: "lib/libpdfium.dylib",
    sha256: "4939bd935ac83ddc09a3a4f038bc43a19cea1660316a3667f26cb07a070e139d",
  },
  "linux-x64": {
    asset: "pdfium-linux-x64.tgz",
    lib: "lib/libpdfium.so",
    sha256: "e1c3ce6e270cb5e0c20816b379ad9f2c1309972697c505f508de92bf5e7d6659",
  },
  "linux-arm64": {
    asset: "pdfium-linux-arm64.tgz",
    lib: "lib/libpdfium.so",
    sha256: "8b8818f2ec57d1b213d952ca6d7f0ffeca9d0110487d0e20ad83ba918bc92efa",
  },
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

// Downloads one target's archive, checks its pinned SHA-256, and unpacks it into
// its own folder; returns that folder. Nothing is unpacked if the hash differs.
async function fetchTarget(key) {
  const { asset, sha256 } = targets[key];
  const dir = join(work, key);
  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/bblanchon/pdfium-binaries/releases/download/${encodeURIComponent(
    PDFIUM_RELEASE,
  )}/${asset}`;
  console.log(`[pdfium] Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) {
    throw new Error(`SHA-256 mismatch for ${asset}: expected ${sha256}, got ${actual}`);
  }
  writeFileSync(join(dir, asset), bytes);
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
