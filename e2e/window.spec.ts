// Main window behaviour at startup: it opens maximized, and only one app may run.
import { spawn } from "node:child_process";
import { expect, test } from "./app";
import { APP_EXE } from "./paths";

test.use({ appOptions: { singleInstance: true } });

test("opens maximized", async ({ app }) => {
  const maximized = await app.page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    return internals.invoke("plugin:window|is_maximized", { label: "main" });
  });
  expect(maximized).toBe(true);
});

test("a second launch exits and leaves the running app open", async ({ app }) => {
  const env = { ...process.env };
  delete env.NOVAPDF_DEV_MULTI_INSTANCE;
  const second = spawn(APP_EXE, [], { env, stdio: "ignore" });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      second.kill();
      reject(new Error("The second launch kept running"));
    }, 20_000);
    second.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  expect(code).toBe(0);
  await expect(app.page.locator(".app")).toBeVisible();
});
