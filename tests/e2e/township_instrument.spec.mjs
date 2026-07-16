import { expect, test } from "@playwright/test";

const instrumentUrl = process.env.TOWNSHIP_INSTRUMENT_URL ?? "http://localhost:4113/township";
const clerkSummaryId = "OxXIdyqabZIje-nnS_wRb-7FkrWosSPTypufH9jOwAU";
const residentSummaryId = "mBzANgvpJ_zpcDy-QZP4mjfJCwzeIAD_h5Hq-PguWkg";
const staleReopenId = "H32KUYuAjLsX6RSoXWwSYKUZSivCavpQ7i38_EInp6k";
const panelSelectors = [
  "#threads-panel",
  "#roles-panel",
  "#members-panel",
  "#attest-panel",
  "#trust-graph-panel",
  "#op-dag-panel",
];

test("Township instrument connects its LiveSocket and renders the desktop evidence grid", async ({ page }, testInfo) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto(instrumentUrl, { waitUntil: "domcontentloaded" });

  await expect(page.locator("#source-status[data-verified='true']")).toBeVisible();
  await expect(page.locator("#instrument-unavailable")).toHaveCount(0);
  await expectLiveSocket(page);

  const replayIsland = page.locator("#causal-replay-island[data-vue-mounted='true']");
  await expect(replayIsland).toBeVisible();
  const replayCanvas = replayIsland.locator("canvas[data-causal-replay-canvas]");
  await expect(replayCanvas).toBeVisible();
  await expectCanvasPainted(replayCanvas);
  const transitionDurations = await replayIsland
    .locator("button[data-replay-field]")
    .first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(transitionDurations.split(", ")).toEqual(["0.12s", "0.12s", "0.12s"]);

  for (const selector of panelSelectors) {
    await expect(page.locator(selector)).toBeVisible();
  }

  await expect(page.locator("#attest-panel")).toContainText("W4 · stubbed");
  await expect(page.locator("#members-panel [data-empty='denied-members']")).toBeVisible();
  expect(await page.locator(".instrument-grid").evaluate((element) => getComputedStyle(element).display)).toBe("grid");
  await expectNoHorizontalOverflow(page);
  await expectNoPanelOverlap(page);
  expect(browserErrors).toEqual([]);

  await attachScreenshot(page, testInfo, "township-instrument-desktop.png");
});

test("Township instrument stays connected and coherent on a narrow viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const browserErrors = collectBrowserErrors(page);
  await page.goto(instrumentUrl, { waitUntil: "domcontentloaded" });

  await expectLiveSocket(page);
  await expect(page.locator("#source-status[data-verified='true']")).toBeVisible();

  const replayIsland = page.locator("#causal-replay-island[data-vue-mounted='true']");
  await expect(replayIsland).toBeVisible();
  await expectCanvasPainted(replayIsland.locator("canvas[data-causal-replay-canvas]"));

  for (const selector of panelSelectors) {
    await expect(page.locator(selector)).toBeVisible();
  }

  const mobileGrid = await page.locator(".instrument-grid").evaluate((element) => {
    const styles = getComputedStyle(element);
    return { display: styles.display, columns: styles.gridTemplateColumns };
  });
  expect(mobileGrid.display).toBe("grid");
  expect(mobileGrid.columns).not.toBe("none");
  expect(mobileGrid.columns.trim().split(/\s+/)).toHaveLength(1);

  await expectNoHorizontalOverflow(page);
  await expectNoPanelOverlap(page);
  expect(browserErrors).toEqual([]);

  await attachScreenshot(page, testInfo, "township-instrument-mobile.png");
});

test("causal replay scrubs server-derived frames without leaving the browser", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto(instrumentUrl, { waitUntil: "domcontentloaded" });

  const island = page.locator("#causal-replay-island[data-vue-mounted='true']");
  await expect(island).toBeVisible();

  const scrubber = island.locator("input[data-replay-scrubber]");
  await expect(scrubber).toHaveValue("12");
  await expect(island.locator("[data-replay-summary]")).toHaveText("Leaning approve (clerk edit)");
  await expect(island).toHaveAttribute("data-visible-count", "13");
  await expect(island).toHaveAttribute("data-quarantine-count", "1");

  await scrubber.fill("0");
  await expect(island).toHaveAttribute("data-replay-frame", "0");
  await expect(island).toHaveAttribute("data-visible-count", "1");
  await expect(island).toHaveAttribute("data-quarantine-count", "0");
  await expect(island.locator("[data-replay-summary]")).toHaveText("—");

  await scrubber.fill("12");
  await expect(island).toHaveAttribute("data-replay-frame", "12");
  await expect(island).toHaveAttribute("data-quarantine-count", "1");
  expect(browserErrors).toEqual([]);
});

test("causal replay links fields to ops and keeps verdicts frame-local", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto(instrumentUrl, { waitUntil: "domcontentloaded" });

  const island = page.locator("#causal-replay-island[data-vue-mounted='true']");
  await expect(island).toBeVisible();
  const selectionRegion = await island.locator("[data-replay-selection]").elementHandle();
  expect(selectionRegion).not.toBeNull();

  await island.locator("button[data-replay-field='summary']").click();
  await expect(island).toHaveAttribute("data-selected-field", "summary");
  await expect(island).toHaveAttribute(
    "data-highlighted-writers",
    `${clerkSummaryId},${residentSummaryId}`,
  );
  await expect(island.locator("[data-replay-selection]")).toContainText("2 writing ops");

  await island.locator("select[data-replay-op-select]").selectOption(staleReopenId);
  const updatedSelectionRegion = await island.locator("[data-replay-selection]").elementHandle();
  expect(
    await selectionRegion.evaluate((initial, updated) => initial === updated, updatedSelectionRegion),
  ).toBe(true);
  await expect(island).toHaveAttribute("data-selected-op", staleReopenId);
  await expect(island.locator("[data-selected-op-status]")).toHaveText("quarantined");
  await expect(island.locator("[data-selected-op-reason]")).toHaveText("not_holder");
  await expect(island.locator("[data-selected-op-author]")).toHaveText("r9qi1OBHt24b");
  await expect(island.locator("[data-selected-op-field]")).toHaveText("clerk_locked");

  await island.locator("input[data-replay-scrubber]").fill("11");
  await expect(island.locator("[data-selected-op-status]")).toHaveText("beyond frontier");
  await expect(island.locator("[data-selected-op-reason]")).toHaveText("—");

  await island.locator("input[data-replay-scrubber]").fill("12");
  await expect(island.locator("[data-selected-op-status]")).toHaveText("quarantined");
  expect(browserErrors).toEqual([]);
});

test("verified operation evidence remains available without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  try {
    await page.goto(instrumentUrl, { waitUntil: "domcontentloaded" });

    await expect(page.locator("#source-status[data-verified='true']")).toBeVisible();
    await expect(page.locator("[data-causal-replay-fallback]")).toBeVisible();
    await expect(page.locator("#causal-replay-island canvas")).toHaveCount(0);
    await expect(page.locator("#op-dag-panel .op-rail [data-op-node]")).toHaveCount(13);
    await expectNoHorizontalOverflow(page);
  } finally {
    await context.close();
  }
});

test("causal replay honors a reduced-motion browser preference", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  const browserErrors = collectBrowserErrors(page);

  try {
    await page.goto(instrumentUrl, { waitUntil: "domcontentloaded" });

    const island = page.locator("#causal-replay-island[data-vue-mounted='true']");
    await expect(island).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

    const transitionDuration = await island
      .locator("button[data-replay-field]")
      .first()
      .evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(transitionDuration).toBe("0s");
    expect(browserErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

function collectBrowserErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  return errors;
}

async function expectLiveSocket(page) {
  await expect
    .poll(() => page.evaluate(() => Boolean(window.liveSocket?.isConnected?.())))
    .toBe(true);
}

async function expectNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

async function expectCanvasPainted(canvas) {
  const pixels = await canvas.evaluate((element) => {
    const context = element.getContext("2d");
    const { data } = context.getImageData(0, 0, element.width, element.height);
    let painted = 0;

    for (let offset = 0; offset < data.length; offset += 4) {
      const alpha = data[offset + 3];
      const nearWhite = data[offset] > 246 && data[offset + 1] > 246 && data[offset + 2] > 246;
      if (alpha > 0 && !nearWhite) painted += 1;
    }

    return { painted, width: element.width, height: element.height };
  });

  expect(pixels.width).toBeGreaterThan(100);
  expect(pixels.height).toBeGreaterThan(100);
  expect(pixels.painted).toBeGreaterThan(250);
}

async function expectNoPanelOverlap(page) {
  const boxes = [];
  for (const selector of panelSelectors) {
    const box = await page.locator(selector).boundingBox();
    expect(box, `${selector} should have a layout box`).not.toBeNull();
    boxes.push({ selector, ...box });
  }

  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      expect(overlapArea(boxes[left], boxes[right]), `${boxes[left].selector} overlaps ${boxes[right].selector}`).toBe(0);
    }
  }
}

function overlapArea(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

async function attachScreenshot(page, testInfo, name) {
  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach(name, { body: screenshot, contentType: "image/png" });
}
