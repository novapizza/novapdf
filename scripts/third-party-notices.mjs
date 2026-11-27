// Writes src-tauri/THIRD-PARTY-NOTICES.txt: the license texts of every Rust crate
// and npm package that ends up in the shipped app. Tauri bundles the file as a
// resource, which is how the MIT/Apache/BSD/ISC/OFL notice requirements are met.
// PDFium's own licenses ship next to it in pdfium/licenses/ (scripts/fetch-pdfium.mjs).
//
// Rust: the normal (non-build, non-dev) dependency graph for all platforms, so
// one file is right for every installer. npm: the production dependency tree,
// which is what Vite bundles into dist/.
//
// Each package's own license files are copied verbatim; identical texts are
// printed once with every package that uses them listed above.
//
// Usage: node scripts/third-party-notices.mjs [--check]
//   --check  exits 1 if the committed file is out of date (used by the release workflow).

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(root, "src-tauri", "THIRD-PARTY-NOTICES.txt");
const check = process.argv.includes("--check");

const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense|ofl)([-._].*)?$/i;

// Reads a package's license files. When the license is a plain choice that
// includes MIT ("MIT OR Apache-2.0") and an MIT file exists, only that one is
// kept: the recipient may pick, and it keeps the notices file small.
function licenseTexts(dir, license, extra = []) {
  const names = existsSync(dir)
    ? readdirSync(dir).filter((n) => LICENSE_FILE.test(n) && statSync(join(dir, n)).isFile())
    : [];
  let files = [...new Set([...names.map((n) => join(dir, n)), ...extra])].sort();
  const choices = (license ?? "").split(/\s+OR\s+|\//).map((s) => s.trim());
  if (!/\bAND\b|[()]/.test(license ?? "") && choices.includes("MIT")) {
    const mit = files.filter((f) => /mit/i.test(f.slice(dir.length)));
    if (mit.length) files = mit;
  }
  return files.map((f) => readFileSync(f, "utf8").replace(/\r\n?/g, "\n").trim());
}

function rustPackages() {
  const meta = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--manifest-path", join(root, "src-tauri", "Cargo.toml")], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }),
  );
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
  const seen = new Set();
  const stack = [meta.resolve.root];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps) {
      if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg);
    }
  }
  seen.delete(meta.resolve.root);
  return [...seen].map((id) => {
    const p = pkgs.get(id);
    const dir = dirname(p.manifest_path);
    const extra = p.license_file ? [join(dir, p.license_file)] : [];
    return {
      name: p.name,
      version: p.version,
      license: p.license ?? "see license file",
      url: p.repository ?? "",
      authors: p.authors ?? [],
      texts: licenseTexts(dir, p.license, extra),
    };
  });
}

function npmPackages() {
  const tree = JSON.parse(
    // A fixed command string: npm is a .cmd on Windows, which needs a shell.
    execSync("npm ls --omit=dev --all --json --long", {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const out = new Map();
  const walk = (deps = {}) => {
    for (const d of Object.values(deps)) {
      if (!d.path || out.has(d.path)) continue;
      const pkg = JSON.parse(readFileSync(join(d.path, "package.json"), "utf8"));
      const license = typeof pkg.license === "object" ? pkg.license.type : pkg.license;
      const repo = typeof pkg.repository === "object" ? pkg.repository.url : pkg.repository;
      out.set(d.path, {
        name: pkg.name,
        version: pkg.version,
        license: license ?? "see license file",
        url: repo ?? pkg.homepage ?? "",
        authors: pkg.author ? [typeof pkg.author === "object" ? pkg.author.name : pkg.author] : [],
        texts: licenseTexts(d.path, license),
      });
      walk(d.dependencies);
    }
  };
  walk(tree.dependencies);
  return [...out.values()];
}

// Standard texts for the few packages that publish no license file. Only the
// licenses actually needed are here; an unknown one fails the run.
const FALLBACK = {
  MIT: (p) =>
    `MIT License\n\nCopyright (c) ${p.authors.join(", ") || `the ${p.name} authors`}\n\n` +
    "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\n" +
    "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\n" +
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
};

FALLBACK["BSD-3-Clause"] = (p) =>
  `BSD 3-Clause License\n\nCopyright (c) ${p.authors.join(", ") || `the ${p.name} authors`}\nAll rights reserved.\n\n` +
  "Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n\n" +
  "1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.\n\n" +
  "2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.\n\n" +
  "3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.\n\n" +
  "THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \"AS IS\" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.";

// Licenses whose text names no copyright holder, so another package's copy of
// it is the same text. Used when a package ships none itself.
const SHARED_TEXT = new Set(["MPL-2.0", "Apache-2.0"]);

function withFallback(p, all) {
  if (p.texts.length) return p;
  // For "A OR B" the recipient may pick; MIT is chosen when offered.
  const options = p.license.split(/\s+OR\s+|\//).map((s) => s.replace(/[()]/g, "").trim());
  const pick = options.find((o) => FALLBACK[o]);
  if (pick) return { ...p, texts: [FALLBACK[pick](p)] };
  if (SHARED_TEXT.has(p.license)) {
    const donor = all.find((q) => q.license === p.license && q.texts.length === 1);
    if (donor) return { ...p, texts: donor.texts };
  }
  throw new Error(`${p.name}@${p.version} (${p.license}) has no license file and no fallback text`);
}

function render(packages) {
  const resolved = [];
  const missing = [];
  for (const p of packages) {
    try {
      resolved.push(withFallback(p, packages));
    } catch (e) {
      missing.push(e.message);
    }
  }
  if (missing.length) throw new Error(`License text missing:\n  ${missing.join("\n  ")}`);
  const groups = new Map();
  for (const p of resolved) {
    const key = p.texts.join("\n\n----------\n\n");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const sorted = [...groups.entries()]
    .map(([text, ps]) => [text, ps.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))])
    .sort((a, b) => a[1][0].name.localeCompare(b[1][0].name));

  const rule = "=".repeat(78);
  let out =
    "NovaPDF third-party notices\n\n" +
    "NovaPDF includes the open-source software listed below. Each component is\n" +
    "used under the license reproduced with it.\n\n" +
    "PDFium and the libraries compiled into it (FreeType, ICU, libjpeg-turbo,\n" +
    "OpenJPEG, libpng, zlib, Little CMS, Abseil, HarfBuzz and others) are\n" +
    "covered by the license files in the pdfium/licenses/ folder installed\n" +
    "next to this file.\n\n" +
    "This file is generated by scripts/third-party-notices.mjs. Do not edit it.\n";
  for (const [text, ps] of sorted) {
    out += `\n${rule}\n`;
    for (const p of ps) out += `${p.name} ${p.version} (${p.license})${p.url ? `  ${p.url}` : ""}\n`;
    out += `${rule}\n\n${text}\n`;
  }
  return out;
}

const content = render([...rustPackages(), ...npmPackages()]);

if (check) {
  const current = existsSync(outFile) ? readFileSync(outFile, "utf8").replace(/\r\n?/g, "\n") : "";
  if (current !== content) {
    console.error("[notices] src-tauri/THIRD-PARTY-NOTICES.txt is out of date. Run: npm run notices");
    process.exit(1);
  }
  console.log("[notices] up to date.");
} else {
  writeFileSync(outFile, content);
  console.log(`[notices] Wrote ${outFile}`);
}
