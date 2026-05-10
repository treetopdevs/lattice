import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { startFlagshipServer } from "./support/lattice-server.mjs";

const root = new URL("../..", import.meta.url).pathname;
let server;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  server = await startFlagshipServer(root);
});

test.afterAll(async () => {
  server?.stop();
});

test("flagship wallet/process graph story is inspectable end to end", async ({ page }) => {
  const stepDelayMs = Number(process.env.LATTICE_E2E_STEP_DELAY_MS || 350);

  await page.goto(server.url);
  await holdForVideo();

  await expect(page.getByRole("heading", { name: "Live process/trust graph inspector" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run full story" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect realms" })).toBeVisible();
  await expect(page.getByRole("link", { name: "JSON" })).toHaveAttribute("href", "/api/flagship/export/json");
  await expect(page.getByRole("link", { name: "Mermaid" })).toHaveAttribute(
    "href",
    "/api/flagship/export/mermaid",
  );
  await expect(page.getByRole("link", { name: "DOT" })).toHaveAttribute("href", "/api/flagship/export/dot");

  await clickStep("Reset");
  await expect(page.getByText("No wallet deliveries yet.")).toBeVisible();

  await clickStep("Connect realms");
  await expect(page.getByText("Wallet, planner, red-team tab")).toBeVisible();
  await expect(page.locator(".node.tab").first()).toBeVisible();

  await clickStep("Issue caveated cap");
  await expect(page.getByText("Wallet issued one caveated cap")).toBeVisible();
  await expect(page.locator(".node.capability").first()).toBeVisible();

  await clickStep("Approve $199 bookshop");
  await expect(page.getByText("$199 bookshop Systems Programming Book")).toBeVisible();
  await expect(page.locator(".edge.allowed").first()).toBeVisible();

  await clickStep("Attempt $425");
  await expect(page.locator("#auditTrail").getByText("amount_exceeds_caveat")).toBeVisible();
  await expect(page.locator(".edge.denied").first()).toBeVisible();

  await clickStep("Attempt wrong vendor");
  await expect(page.locator("#auditTrail").getByText("vendor_not_allowed")).toBeVisible();

  await clickStep("Steal cap from red-team tab");
  await expect(page.locator("#auditTrail").getByText("wrong_owner")).toBeVisible();

  await clickStep("Revoke cap");
  await expect(page.getByText("Wallet consent revoked")).toBeVisible();

  await clickStep("Replay revoked cap");
  await expect(page.locator("#auditTrail").getByText("revoked")).toBeVisible();

  await clickStep("Refresh JSON");
  await expect(page.locator("#rawJson")).toHaveValue(/"graph"/);
  await expect(page.locator("#rawJson")).toHaveValue(/"denied_attempt"/);

  await page.locator(".node.capability").first().click();
  await holdForVideo();
  await expect(page.locator("#detail")).toContainText("capability");

  await clickStep("Reset");
  await clickStep("Run full story");
  await expect(page.getByText("Deny replay")).toBeVisible();
  await expect(page.locator(".claim.implemented").first()).toBeVisible();
  await expect(page.locator(".claim.simulated").first()).toBeVisible();
  await expect(page.locator(".claim.future").first()).toBeVisible();

  await mkdir(`${root}/output/playwright`, { recursive: true });
  await page.screenshot({ path: `${root}/output/playwright/flagship-demo.png`, fullPage: true });

  async function clickStep(name) {
    await page.getByRole("button", { name }).click();
    await holdForVideo();
  }

  async function holdForVideo() {
    await page.waitForTimeout(stepDelayMs);
  }
});
