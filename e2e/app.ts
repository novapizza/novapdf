// Launches the real NovaPDF debug build and connects Playwright to its WebView2.
//
// Debug-build hooks used here (both compiled out of release builds):
//   NOVAPDF_DEV_OPEN     ';'-separated paths pre-granted as if dropped on the window.
//                        Tests then emit the same "files-dropped" event the native
//                        drop handler emits, so opening goes through the real path.
//   NOVAPDF_DEV_SAVE_TO  "Save as…" writes here instead of showing the native dialog.
import { test as base, chromium, expect, type Browser, type Page } from "@playwright/test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { APP_EXE, WORK_DIR } from "./paths";

export interface AppOptions {
  /** Files the app may open (as if dropped). */
  grants?: string[];
  /** Where Save as… writes. */
  saveTo?: string;
}

export interface App {
  page: Page;
  /** Opens files through the drop path. Each path must be in `grants`. */
  drop(paths: string[]): Promise<void>;
  close(): Promise<void>;
}

let nextPort = 9300 + Math.floor(Math.random() * 500);

async function waitForDevtools(port: number, child: ChildProcess, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode != null) throw new Error(`App exited early with code ${child.exitCode}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`WebView2 DevTools did not come up on port ${port}`);
}

export async function launchApp(opts: AppOptions = {}): Promise<App> {
  const port = nextPort++;
  mkdirSync(WORK_DIR, { recursive: true });
  const profile = mkdtempSync(join(WORK_DIR, "profile-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NOVAPDF_DEV_OPEN: (opts.grants ?? []).join(";"),
    NOVAPDF_DEV_SAVE_TO: opts.saveTo ?? "",
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    // A fresh profile per launch: no theme or storage carried between tests.
    WEBVIEW2_USER_DATA_FOLDER: profile,
  };
  const child = spawn(APP_EXE, [], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d));

  let browser: Browser | undefined;
  const close = async () => {
    await browser?.close().catch(() => {});
    if (child.exitCode == null && child.pid) {
      try {
        // /T also ends the PDF workers and WebView2 processes the app started.
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
    }
    // WebView2 may hold the profile briefly after exit; leftovers are harmless.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* still locked */
    }
  };

  try {
    await waitForDevtools(port, child);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await findAppPage(browser);
    await expect(page.locator(".app")).toBeVisible();
    return {
      page,
      close,
      async drop(paths) {
        await page.evaluate(async (payload) => {
          const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } })
            .__TAURI_INTERNALS__;
          await internals.invoke("plugin:event|emit", { event: "files-dropped", payload });
        }, paths);
      },
    };
  } catch (e) {
    await close();
    throw new Error(`${(e as Error).message}\n--- app stderr ---\n${stderr}`);
  }
}

async function findAppPage(browser: Browser): Promise<Page> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) if (p.url().startsWith("http://localhost:1420")) return p;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("The NovaPDF window did not load http://localhost:1420");
}

/** `test` with an `app` fixture launched per test and closed after it. */
export const test = base.extend<{ appOptions: AppOptions; app: App }>({
  appOptions: [{}, { option: true }],
  app: async ({ appOptions }, use) => {
    const app = await launchApp(appOptions);
    try {
      await use(app);
    } finally {
      await app.close();
    }
  },
});
export { expect };

/** Status-bar text, e.g. "Page 1 of 3". */
export const statusBar = (page: Page) => page.locator("footer.status");
/** Toast messages. */
export const toast = (page: Page, text: string | RegExp) => page.locator(".toast", { hasText: text });
