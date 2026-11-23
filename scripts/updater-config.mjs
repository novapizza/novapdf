// Writes the Tauri config overlay that turns on self-update for a release build,
// and prints the matching `config=` line for $GITHUB_OUTPUT.
//
// The endpoint and public key stay out of tauri.conf.json, so development builds
// have no updater configuration and report that instead of failing a check.
//
// Usage: node scripts/updater-config.mjs <out-file>
// Env:   TAURI_UPDATER_PUBKEY  verifier half of the updater signing keypair
//        R2_PUBLIC_BASE_URL    public prefix latest.json is served from
//
// Missing either prints an empty `config=`: the release builds, it just cannot
// update itself.
import { writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/updater-config.mjs <out-file>");
  process.exit(1);
}

const pubkey = process.env.TAURI_UPDATER_PUBKEY?.trim();
const base = process.env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
if (!pubkey || !base) {
  console.error("::warning::updater not configured (TAURI_UPDATER_PUBKEY or R2_PUBLIC_BASE_URL missing); this release cannot self-update");
  console.log("config=");
  process.exit(0);
}

writeFileSync(
  out,
  JSON.stringify(
    {
      bundle: { createUpdaterArtifacts: true },
      plugins: { updater: { endpoints: [`${base}/latest.json`], pubkey } },
    },
    null,
    2,
  ),
);
console.log(`config=--config ${out}`);
