import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const instrumentUrl = "http://localhost:4115/township";
const triggerFile = "/tmp/lattice-township-stable-server-trigger";

test("stable carrier restart patches fresh to stale to fresh without transferring participant custody", async ({ page }) => {
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));

  await page.goto(instrumentUrl, { waitUntil: "domcontentloaded" });

  const source = page.locator("#source-status[data-source='carrier']");
  const island = page.locator("#causal-replay-island[data-vue-mounted='true']");
  const participantForm = page.locator("#participant-post-form[phx-submit='prepare_post']");

  await expect(source).toHaveAttribute("data-freshness", "fresh");
  await expect(page.locator("#op-dag-panel [data-op-count='13']")).toBeVisible();
  await expect(island).toHaveAttribute("data-visible-count", "13");
  await expect(island.locator("[data-causal-replay-root]")).toHaveCount(1);
  await expect(participantForm).toHaveCount(1);
  await expect(page.locator("#participant-post-handoff")).toHaveCount(0);
  expect(await liveViewEvents(page)).toEqual(["prepare_post"]);

  await writeFile(triggerFile, "stop\n", "utf8");

  await expect(source).toHaveAttribute("data-freshness", "stale");
  await expect(page.locator("#op-dag-panel [data-op-count='13']")).toBeVisible();
  await expect(island).toHaveAttribute("data-visible-count", "13");
  await expect(island.locator("[data-causal-replay-root]")).toHaveCount(1);
  await expect(participantForm).toHaveCount(0);
  expect(await liveViewEvents(page)).toEqual([]);

  await writeFile(triggerFile, "restart\n", "utf8");

  await expect(source).toHaveAttribute("data-freshness", "fresh");
  await expect(page.locator("#op-dag-panel [data-op-count='13']")).toBeVisible();
  await expect(island).toHaveAttribute("data-visible-count", "13");
  await expect(island.locator("[data-causal-replay-root]")).toHaveCount(1);
  await expect(participantForm).toHaveCount(1);
  expect(await liveViewEvents(page)).toEqual(["prepare_post"]);
  expect(browserErrors).toEqual([]);
});

async function liveViewEvents(page) {
  return page.locator("[phx-submit],[phx-click]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("phx-submit") ?? element.getAttribute("phx-click")),
  );
}
