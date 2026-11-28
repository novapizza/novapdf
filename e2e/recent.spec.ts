// Recent files: the list lives in Rust and survives a relaunch; the UI opens an
// entry by id only.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, WORK_DIR } from "./paths";
import { expect, launchApp, statusBar, test, toast } from "./app";

function dataDir() {
  mkdirSync(WORK_DIR, { recursive: true });
  return mkdtempSync(join(WORK_DIR, "data-"));
}

const recentRows = (page: import("@playwright/test").Page) =>
  page.getByRole("region", { name: "Recent" }).getByRole("listitem");

test("files opened in one session are listed in the next, and reopen from the list", async () => {
  const data = dataDir();
  try {
    const first = await launchApp({ dataDir: data });
    try {
      first.pick([FIXTURES.sample, FIXTURES.second]);
      await first.page.getByRole("button", { name: /^Open$/ }).click();
      await expect(toast(first.page, "Opened 2 files (5 pages)")).toBeVisible();
    } finally {
      await first.close();
    }

    const next = await launchApp({ dataDir: data });
    try {
      const { page } = next;
      await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
      // Newest first: second.pdf was opened last.
      await expect(recentRows(page)).toHaveCount(2);
      await expect(recentRows(page).nth(0)).toContainText("second.pdf");
      await expect(recentRows(page).nth(1)).toContainText("sample.pdf");
      await expect(recentRows(page).nth(0)).toContainText("Today");

      // No grant and no dialog: Rust opens it from its own list.
      await recentRows(page).nth(1).getByRole("button", { name: /^sample\.pdf/ }).click();
      await expect(toast(page, "Opened sample.pdf (3 pages)")).toBeVisible();
      await expect(statusBar(page)).toContainText("Page 1 of 3");
      await expect(page.getByAltText("Page 1")).toBeVisible();

      // Reopening moved it to the top.
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await expect(recentRows(page).nth(0)).toContainText("sample.pdf");

      // Remove one, then clear the rest.
      await recentRows(page).nth(1).hover();
      await recentRows(page).nth(1).getByRole("button", { name: "Remove second.pdf from the list" }).click();
      await expect(recentRows(page)).toHaveCount(1);
      await page.getByRole("button", { name: "Clear list" }).click();
      await expect(page.getByText("No recent files")).toBeVisible();
    } finally {
      await next.close();
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("a file that was deleted is reported and taken off the list", async () => {
  const data = dataDir();
  const copy = join(data, "temporary.pdf");
  copyFileSync(FIXTURES.sample, copy);
  try {
    const first = await launchApp({ dataDir: data });
    try {
      first.pick([copy]);
      await first.page.getByRole("button", { name: /^Open$/ }).click();
      await expect(toast(first.page, "Opened temporary.pdf")).toBeVisible();
    } finally {
      await first.close();
    }
    rmSync(copy);

    const next = await launchApp({ dataDir: data });
    try {
      const { page } = next;
      await recentRows(page).getByRole("button", { name: /^temporary\.pdf/ }).click();
      await expect(toast(page, /temporary\.pdf: This file was moved or deleted/)).toBeVisible();
      await expect(page.getByText("No recent files")).toBeVisible();
      await expect(page.getByRole("tablist", { name: "Open documents" })).toHaveCount(0);
    } finally {
      await next.close();
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("turning the list off forgets it, and nothing is recorded while off", async () => {
  const data = dataDir();
  try {
    const app = await launchApp({ dataDir: data });
    try {
      const { page } = app;
      app.pick([FIXTURES.sample]);
      await page.getByRole("button", { name: /^Open$/ }).click();
      await expect(toast(page, "Opened sample.pdf (3 pages)")).toBeVisible();
      await page.getByRole("button", { name: "Settings" }).click();
      const remember = page.getByRole("dialog", { name: "Settings" }).getByRole("checkbox", { name: "Remember recent files" });
      await expect(remember).toBeChecked();
      await remember.click();
      await expect(remember).not.toBeChecked();
      await page.keyboard.press("Escape");
      app.pick([FIXTURES.second]);
      await page.getByRole("button", { name: /^Open$/ }).click();
      await expect(toast(page, "Opened second.pdf (2 pages)")).toBeVisible();
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Recent" })).toHaveCount(0);
    } finally {
      await app.close();
    }
    // Off is remembered across launches.
    const next = await launchApp({ dataDir: data });
    try {
      await expect(next.page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
      await expect(next.page.getByRole("heading", { name: "Recent" })).toHaveCount(0);
    } finally {
      await next.close();
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
