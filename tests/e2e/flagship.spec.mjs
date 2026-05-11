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
  const actionLabels = await loadActionLabels();
  await expect(page.getByRole("button", { name: actionLabels.run_all })).toBeVisible();
  await expect(page.getByRole("button", { name: actionLabels.connect })).toBeVisible();
  await expect(page.getByText("Presenter mode")).toBeVisible();
  await expect(page.getByRole("link", { name: "JSON" })).toHaveAttribute("href", "/api/flagship/export/json");
  await expect(page.getByRole("link", { name: "Mermaid" })).toHaveAttribute(
    "href",
    "/api/flagship/export/mermaid",
  );
  await expect(page.getByRole("link", { name: "DOT" })).toHaveAttribute("href", "/api/flagship/export/dot");
  await expect(page.getByRole("link", { name: "Claims" })).toHaveAttribute("href", "/api/flagship/claims");

  await clickAction("reset");
  await expect(page.getByText("No wallet deliveries yet.")).toBeVisible();

  await clickAction("connect");
  await expect(page.getByText("Wallet, planner, red-team tab")).toBeVisible();
  await expect(page.getByText("zero ambient authority")).toBeVisible();
  await expect(page.locator(".node.tab").first()).toBeVisible();

  await clickAction("grant");
  await expect(page.getByText("Wallet issued one caveated cap")).toBeVisible();
  await expect(page.locator(".node.capability").first()).toBeVisible();

  await clickAction("allowed");
  await expect(page.getByText("$199 bookshop Systems Programming Book")).toBeVisible();
  await waitForDecisionEdge({ kind: "invokes", status: "allowed" });
  await expect(page.locator(".edge.allowed").first()).toBeVisible();

  await clickAction("over_budget");
  await waitForDecisionEdge({ kind: "denied_attempt", reason: "amount_exceeds_caveat" });
  await expect(page.locator(".edge.denied").first()).toBeVisible();

  await clickAction("wrong_vendor");
  await waitForDecisionEdge({ kind: "denied_attempt", reason: "vendor_not_allowed" });

  await clickAction("stolen");
  await waitForDecisionEdge({ kind: "denied_attempt", reason: "wrong_owner" });

  await clickAction("revoke");
  await expect(page.getByText("Wallet consent revoked")).toBeVisible();

  await clickAction("replay");
  await waitForDecisionEdge({ kind: "denied_attempt", reason: "revoked" });

  await page.getByRole("button", { name: "Refresh JSON" }).click();
  await holdForVideo();
  await expect(page.locator("#rawJson")).toHaveValue(/"graph"/);
  await expect(page.locator("#rawJson")).toHaveValue(/"denied_attempt"/);

  await page.locator(".node.capability").first().click();
  await holdForVideo();
  await expect(page.locator("#detail")).toContainText("capability");
  await expect(page.locator("#detail")).toContainText("Caveats");

  await page.locator("#edgeList button").filter({ hasText: "amount_exceeds_caveat" }).first().click();
  await holdForVideo();
  await expect(page.locator("#detail")).toContainText("Denial reason");

  await clickAction("reset");
  await clickAction("run_all");
  await waitForExpectedResults();
  await expect(page.locator("#storySteps").getByText("Deny replay")).toBeVisible();
  await expect(page.locator("#nextAction")).toContainText("inspect");
  await expect(page.locator("#claimsSource")).toContainText("code-owned claims");
  await expect(page.locator(".claim.implemented").first()).toBeVisible();
  await expect(page.locator(".claim.simulated").first()).toBeVisible();
  await expect(page.locator(".claim.future").first()).toBeVisible();

  await mkdir(`${root}/output/playwright`, { recursive: true });
  await page.screenshot({ path: `${root}/output/playwright/flagship-demo.png`, fullPage: true });

  async function clickAction(action) {
    await page.getByRole("button", { name: actionLabels[action] }).click();
    await waitForAction(action);
    await holdForVideo();
  }

  async function waitForAction(action) {
    await expect
      .poll(
        () =>
          page.evaluate((actionName) => {
            const current = window.__latticeSnapshot;
            if (!current) return false;
            if (actionName === "reset") return current.wallet?.delivery_count === 0 && current.cap == null;
            if (actionName === "run_all") return current.current_step === "replay" && Boolean(current.results?.replay);
            return current.current_step === actionName;
          }, action),
        { timeout: 5_000 },
      )
      .toBe(true);
  }

  async function waitForDecisionEdge(expected) {
    await expect
      .poll(
        () =>
          page.evaluate((expectedEdge) => {
            return (window.__latticeSnapshot?.graph?.edges || []).some((edge) => {
              const kindMatches = !expectedEdge.kind || edge.kind === expectedEdge.kind;
              const statusMatches = !expectedEdge.status || edge.status === expectedEdge.status;
              const reasonMatches =
                !expectedEdge.reason || String(edge.reason || "").includes(expectedEdge.reason);
              return kindMatches && statusMatches && reasonMatches;
            });
          }, expected),
        { timeout: 5_000 },
      )
      .toBe(true);
  }

  async function waitForExpectedResults() {
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const current = window.__latticeSnapshot;
            if (!current) return false;

            return current.story
              .filter((step) => step.expected_result)
              .every((step) => {
                const result = current.results?.[step.id];
                if (!result) return false;

                const expected = step.expected_result;
                const okMatches = result.result?.ok === expected.ok;
                const deliveryMatches =
                  result["delivered_to_wallet?"] === expected["delivered_to_wallet?"];
                const expectedMatches = Object.entries(expected).every(
                  ([key, value]) => result.expected_result?.[key] === value,
                );
                const errorMatches = !expected.error || result.result?.error === expected.error;

                return (
                  okMatches &&
                  deliveryMatches &&
                  expectedMatches &&
                  errorMatches
                );
              });
          }),
        { timeout: 5_000 },
      )
      .toBe(true);
  }

  async function loadActionLabels() {
    return page.evaluate(async () => {
      const response = await fetch("/api/flagship/snapshot");
      const snapshot = await response.json();
      return Object.fromEntries(snapshot.actions.map((action) => [action.action, action.label]));
    });
  }

  async function holdForVideo() {
    await page.waitForTimeout(stepDelayMs);
  }
});
