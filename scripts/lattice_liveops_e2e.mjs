#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { freePort, startServer } from "../tests/e2e/support/lattice-server.mjs";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.LATTICE_LIVEOPS_PORT || (await freePort()));
const outDir = process.env.LATTICE_LIVEOPS_OUT || path.join(root, "output/liveops");

await fs.mkdir(outDir, { recursive: true });

const server = await startServer({
  root,
  command: "mix",
  args: ["lattice.liveops", String(port)],
  port,
});
const url = server.url;

const contexts = [];
let browser;

try {
  browser = await launchBrowser();

  const producer = await openRole(browser, "producer", { recordVideo: true });
  const graphics = await openRole(browser, "graphics_operator");
  const camera = await openRole(browser, "remote_camera");
  const observer = await openRole(browser, "observer");

  for (const page of [producer.page, graphics.page, camera.page, observer.page]) {
    await expect(page.getByTestId("connection-state")).toHaveText("online", { timeout: 10_000 });
  }

  await expect(producer.page.getByTestId("actor-producer")).toBeVisible({ timeout: 10_000 });
  await expect(producer.page.getByTestId("actor-graphics_operator")).toBeVisible();
  await expect(producer.page.getByTestId("actor-remote_camera")).toBeVisible();
  await expect(producer.page.getByTestId("actor-observer")).toBeVisible();
  await expect(producer.page.getByTestId("device-camera_feed")).toBeVisible();
  await expect(producer.page.getByTestId("device-graphics_renderer")).toBeVisible();
  await expect(producer.page.getByTestId("device-tally_light")).toBeVisible();
  await expect(producer.page.getByTestId("device-preview_monitor")).toBeVisible();

  await graphics.page.getByTestId("action-publish").click();
  await expect(graphics.page.getByTestId("event-liveops_denied").first()).toBeVisible({
    timeout: 10_000,
  });

  await graphics.page.getByTestId("action-preview").click();
  await expect(producer.page.getByTestId("event-liveops_operation_pulse").first()).toContainText(
    "preview overlay",
    { timeout: 10_000 },
  );

  await graphics.page.getByTestId("action-request-publish").click();
  await expect(producer.page.getByTestId("action-approve")).toBeEnabled({ timeout: 10_000 });
  await producer.page.getByTestId("action-approve").click();

  await expect(graphics.page.getByTestId("cap-publish").first()).toBeVisible({ timeout: 10_000 });
  await expect(graphics.page.getByTestId("cap-publish").first()).toHaveAttribute(
    "data-expires-in",
    /\d+/,
  );

  await graphics.page.getByTestId("action-publish").click();
  await expect(producer.page.getByTestId("on-air-text")).toContainText("on air", {
    timeout: 10_000,
  });
  await expect(graphics.page.getByTestId("cap-publish").first()).toHaveAttribute(
    "data-status",
    "revoked",
    { timeout: 10_000 },
  );

  await graphics.page.getByTestId("action-replay-publish").click();
  await expect(graphics.page.getByTestId("event-liveops_denied").first()).toBeVisible({
    timeout: 10_000,
  });

  await graphics.page.getByTestId("action-request-publish").click();
  await expect(producer.page.getByTestId("action-approve-expired")).toBeEnabled({
    timeout: 10_000,
  });
  await producer.page.getByTestId("action-approve-expired").click();
  await expect(graphics.page.getByTestId("cap-publish").first()).toBeVisible({ timeout: 10_000 });
  await graphics.page.getByTestId("action-publish").click();
  await expect(graphics.page.getByTestId("event-liveops_denied").first()).toBeVisible({
    timeout: 10_000,
  });

  await observer.page.getByTestId("action-observer-publish").click();
  await expect(observer.page.getByTestId("event-liveops_denied").first()).toBeVisible({
    timeout: 10_000,
  });

  await camera.page.getByTestId("action-camera-frame").click();
  await camera.page.getByTestId("action-tally").click();
  await expect(producer.page.getByTestId("event-liveops_device_operation").first()).toBeVisible({
    timeout: 10_000,
  });

  await camera.page.getByTestId("action-disconnect").click();
  await expect(producer.page.getByTestId("device-camera_feed")).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(producer.page.getByTestId("actor-remote_camera")).toHaveCount(0);

  await camera.page.getByTestId("action-connect").click();
  await expect(camera.page.getByTestId("connection-state")).toHaveText("online", {
    timeout: 10_000,
  });
  await expect(producer.page.getByTestId("actor-remote_camera")).toBeVisible({
    timeout: 10_000,
  });
  await camera.page.getByTestId("action-stale-camera").click();
  await expect(camera.page.getByTestId("event-liveops_denied").first()).toBeVisible({
    timeout: 10_000,
  });

  const screenshotPath = path.join(outDir, "liveops-stage.png");
  await producer.page.screenshot({ path: screenshotPath, fullPage: true });

  const summary = {
    url,
    screenshot: screenshotPath,
    roles: ["producer", "graphics_operator", "remote_camera", "observer"],
    assertions: [
      "role nodes appeared",
      "device actors appeared",
      "publish denied before approval",
      "approval granted a short-lived publish cap",
      "publish succeeded after approval",
      "replay after revoke denied",
      "expired approval denied",
      "wrong-role publish denied",
      "device operations emitted",
      "disconnect cleanup removed actor and devices",
      "reconnect stale cap denied",
    ],
  };

  await fs.writeFile(path.join(outDir, "liveops-e2e-summary.json"), JSON.stringify(summary, null, 2));

  console.log(`Lattice LiveOps E2E passed at ${url}`);
  console.log(`screenshot: ${screenshotPath}`);
} finally {
  for (const context of contexts.reverse()) await context.close().catch(() => {});
  if (browser) await browser.close();
  await server.stop();
}

async function openRole(browser, role, opts = {}) {
  const context = await browser.newContext(
    opts.recordVideo
      ? {
          recordVideo: {
            dir: outDir,
            size: { width: 1280, height: 900 },
          },
        }
      : {},
  );
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${url}?role=${encodeURIComponent(role)}`);
  return { context, page };
}

async function launchBrowser() {
  const channel = process.env.PLAYWRIGHT_CHANNEL || "chrome";

  try {
    return await chromium.launch({ channel, headless: true });
  } catch (error) {
    if (process.env.PLAYWRIGHT_CHANNEL) throw error;
    return chromium.launch({ headless: true });
  }
}
