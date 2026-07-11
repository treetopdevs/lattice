import { expect, test } from "@playwright/test";

const instrumentUrl = process.env.TOWNSHIP_INSTRUMENT_URL ?? "http://localhost:4113/township";
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
