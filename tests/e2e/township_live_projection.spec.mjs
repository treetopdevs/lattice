import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const instrumentUrl = "http://localhost:4114/township";
const triggerFile = "/tmp/lattice-township-live-trigger";

test("real carrier pull patches the LiveView and Vue replay without a write", async ({ page }, testInfo) => {
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));

  await page.goto(instrumentUrl, { waitUntil: "domcontentloaded" });

  const source = page.locator(
    "#source-status[data-source='carrier'][data-freshness='fresh'][data-verification='arrival']",
  );
  await expect(source).toBeVisible();
  await expect(page.locator("#op-dag-panel [data-op-count='4']")).toBeVisible();

  const island = page.locator("#causal-replay-island[data-vue-mounted='true']");
  await expect(island).toBeVisible();
  await expect(island).toHaveAttribute("data-visible-count", "4");

  await writeFile(triggerFile, "diverge\n", "utf8");

  await expect(page.locator("#threads-panel")).toContainText("Leaning approve (clerk edit)");
  await expect(page.locator("#roles-panel [data-reason='not_holder']")).toBeVisible();
  await expect(page.locator("#op-dag-panel [data-op-count='9']")).toBeVisible();
  await expect(island).toHaveAttribute("data-visible-count", "9");
  await expect(island.locator("input[data-replay-scrubber]")).toHaveValue("8");
  await expect(island.locator("[data-causal-replay-root]")).toHaveCount(1);
  await expect(island.locator("canvas[data-causal-replay-canvas]")).toHaveCount(1);
  expect(browserErrors).toEqual([]);

  await testInfo.attach("township-live-projection.png", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(source).toBeVisible();
  await expect(island).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);

  await testInfo.attach("township-live-projection-mobile.png", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});
