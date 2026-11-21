// Runs Playwright with an upper-case drive letter in the working directory.
// On Windows, a cwd like "c:\..." (VS Code's terminal) and "C:\..." (Node's
// import.meta.url) make Playwright treat spec files as foreign and fail with
// "did not expect test.use() to be called here".
import { spawnSync } from "node:child_process";

const cwd = process.cwd().replace(/^[a-z]:/, (d) => d.toUpperCase());
const cli = new URL("../node_modules/@playwright/test/cli.js", import.meta.url);
const r = spawnSync(process.execPath, [cli.pathname.replace(/^\/([A-Za-z]:)/, "$1"), "test", ...process.argv.slice(2)], {
  cwd,
  stdio: "inherit",
});
process.exit(r.status ?? 1);
