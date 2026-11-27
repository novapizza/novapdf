// Main window behaviour at startup: it opens maximized, only one app may run, and a
// file the OS launches the app with (a double-clicked PDF) opens.
import { spawn } from "node:child_process";
import { expect, statusBar, test, toast } from "./app";
import { APP_EXE, FIXTURES } from "./paths";

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

test("a second launch with a file opens it in the running app", async ({ app }) => {
  const env = { ...process.env };
  delete env.NOVAPDF_DEV_MULTI_INSTANCE;
  // What Windows runs when the user double-clicks a PDF NovaQuire is the default app for.
  const second = spawn(APP_EXE, [FIXTURES.second], { env, stdio: "ignore" });
  await new Promise((resolve) => second.on("exit", resolve));
  await expect(toast(app.page, "Opened second.pdf (2 pages)")).toBeVisible();
  await expect(statusBar(app.page)).toContainText("Page 1 of 2");
});

test.describe("launched with a file", () => {
  test.use({ appOptions: { singleInstance: true, args: [FIXTURES.sample] } });

  test("opens it at startup", async ({ app }) => {
    await expect(toast(app.page, "Opened sample.pdf (3 pages)")).toBeVisible();
    await expect(statusBar(app.page)).toContainText("Page 1 of 3");
    await expect(app.page.getByAltText("Page 1")).toBeVisible();
  });
});
