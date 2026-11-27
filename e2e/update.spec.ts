// Self-update. Test builds have no updater endpoint or public key (the release
// workflow injects them), so the real check reports that this build can't update
// itself rather than failing. That also proves the updater plugin starts without
// its configuration.
import { expect, test } from "./app";

test("Check for updates reports that a development build can't update itself", async ({ app }) => {
  const { page } = app;
  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "Search commands" }).fill("check for updates");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/This build can't update itself/)).toBeVisible();
  // Nothing was found, so there is nothing to install.
  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "Search commands" }).fill("install novaquire");
  await expect(page.getByRole("option", { name: /Install NovaQuire update/ })).toHaveAttribute("aria-disabled", "true");
});

test("automatic updates can be turned off and on from the palette", async ({ app }) => {
  const { page } = app;
  const run = async (command: string) => {
    await page.keyboard.press("Control+k");
    await page.getByRole("textbox", { name: "Search commands" }).fill(command);
    await page.keyboard.press("Enter");
  };
  // On by default.
  await run("turn off automatic updates");
  await expect(page.getByText(/Automatic updates are off/)).toBeVisible();
  await run("turn on automatic updates");
  await expect(page.getByText(/Automatic updates are on/)).toBeVisible();
});
