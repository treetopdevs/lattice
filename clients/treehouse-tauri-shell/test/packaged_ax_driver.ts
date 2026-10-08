import assert from "node:assert/strict";
import { createAxDriver, preflightArtifact } from "./support/packaged_ax";
import type { AxExec, AxNode } from "./support/packaged_ax";

// Plan 181 S5c1 (folding S5c0). The accessibility driver's logic, tested against an in-memory fake of the
// helper so it runs everywhere, with no Accessibility permission and no app. The real transfer proof is the
// packaged run on the hosted macOS job: this test only proves that the preflight round-trips byte-exactly
// when the transfer works, names the method and stops when it does not, and that lookup retries are bounded
// to the missing-control exit code.

console.log("\n▸ Treehouse packaged accessibility driver (fake helper)");

const node = (role: string, label: string, value = "", enabled = true): AxNode => ({
  role,
  title: "",
  description: label,
  value,
  enabled: String(enabled),
});

class FakeUi {
  fields = new Map<string, string>();
  buttons = new Map<string, boolean>();
  texts: string[] = [];
  calls: { args: string[]; input?: string }[] = [];
  /** Corrupts every stored value, as a lossy transfer would. */
  corrupt: ((value: string) => string) | null = null;
  /** Throws this exit status for the next N calls that name a control. */
  missing = 0;
  failWith: number | null = null;
  exec: AxExec = (args, input) => {
    this.calls.push({ args, ...(input === undefined ? {} : { input }) });
    const [mode, label] = args;
    if (mode === "dump")
      return JSON.stringify([
        ...[...this.fields].map(([name, value]) => node("AXTextArea", name, value)),
        ...[...this.buttons].map(([name, enabled]) => node("AXButton", name, "", enabled)),
        ...this.texts.map((text) => ({ role: "AXStaticText", title: "", description: "", value: text, enabled: "true" })),
      ]);
    if (this.missing > 0) {
      this.missing--;
      throw Object.assign(new Error("Enabled visible control not found"), { status: 3 });
    }
    if (this.failWith !== null) throw Object.assign(new Error("refused"), { status: this.failWith });
    if (mode === "paste" || mode === "chunked") {
      assert(this.fields.has(label!), "pasted into a control that exists");
      this.fields.set(label!, this.corrupt ? this.corrupt(input!) : input!);
      return "";
    }
    if (mode === "press") return "";
    throw Object.assign(new Error("usage"), { status: 2 });
  };
}

const driverOf = (ui: FakeUi, extra: Partial<Parameters<typeof createAxDriver>[0]> = {}) =>
  createAxDriver({ exec: ui.exec, sleep: async () => {}, ...extra });

// The preflight artifact is deterministic, ASCII, the requested length, and distinct per round.
{
  const [a, b] = [preflightArtifact(1, 8192), preflightArtifact(2, 8192)];
  assert.equal(a.length, 8192);
  assert.equal(preflightArtifact(1, 8192), a);
  assert.notEqual(a, b);
  assert(/^[\x20-\x7e]+$/.test(a), "printable ASCII only");
  assert(/["{}:]/.test(a) && /[A-Za-z0-9_-]/.test(a), "carries punctuation and base64url characters");
  console.log("PASS preflight artifacts are deterministic printable ASCII of the requested length");
}

// Twenty 8 KiB round trips pass when the transfer is exact, and nothing but the field is touched.
{
  const ui = new FakeUi();
  ui.fields.set("Paste offer", "");
  await driverOf(ui).transferPreflight("Paste offer");
  const pastes = ui.calls.filter((c) => c.args[0] === "paste");
  assert.equal(pastes.length, 20);
  assert(pastes.every((c) => c.input!.length === 8192 && c.args[1] === "Paste offer"));
  assert.equal(new Set(pastes.map((c) => c.input)).size, 20, "every round carries a different artifact");
  assert(ui.calls.every((c) => ["dump", "paste"].includes(c.args[0]!)), "no other action was issued");
  console.log("PASS the transfer preflight round-trips 20 distinct 8 KiB artifacts");
}

// A lossy transfer stops the preflight with a diagnostic naming the method, and never prints the artifact.
for (const method of ["paste"] as const) {
  const ui = new FakeUi();
  ui.fields.set("Paste offer", "");
  ui.corrupt = (value) => value.slice(0, 4096);
  const driver = driverOf(ui, { transfer: method });
  await assert.rejects(
    driver.transferPreflight("Paste offer"),
    (error: Error) => {
      assert.match(error.message, new RegExp(`^G-AX transfer check failed: method=${method} round=1/20 `));
      assert(!error.message.includes(preflightArtifact(1, 8192).slice(0, 64)), "the artifact text is not echoed");
      return true;
    },
  );
  assert.equal(ui.calls.filter((c) => c.args[0] === method).length, 1, "the preflight stops at the first failing round");
}
console.log("PASS a lossy transfer stops the preflight with a G-AX diagnostic that names the method");

// One flipped character late in the artifact is also caught (the readback is compared in full).
{
  const ui = new FakeUi();
  ui.fields.set("Paste offer", "");
  ui.corrupt = (value) => value.slice(0, -1) + (value.endsWith("A") ? "B" : "A");
  await assert.rejects(driverOf(ui).transferPreflight("Paste offer"), /readback differs at index 8191/);
  console.log("PASS a single wrong final character fails the byte-exact readback");
}

// Lookup retries: only exit status 3 (control not found, nothing issued) is retried, and only so often.
{
  const ui = new FakeUi();
  ui.buttons.set("Sync", true);
  ui.missing = 2;
  await driverOf(ui).press("Sync");
  assert.equal(ui.calls.filter((c) => c.args[0] === "press").length, 3);

  const refused = new FakeUi();
  refused.buttons.set("Sync", true);
  refused.failWith = 4;
  await assert.rejects(driverOf(refused).press("Sync"), /refused/);
  assert.equal(refused.calls.filter((c) => c.args[0] === "press").length, 1, "a refused action is not retried");

  const gone = new FakeUi();
  gone.missing = 1000;
  await assert.rejects(driverOf(gone, { attempts: 5 }).press("Sync"), /not found/);
  assert.equal(gone.calls.filter((c) => c.args[0] === "press").length, 5);
  console.log("PASS only a missing control is retried, and the retry is bounded");
}

// put verifies the value in the dump, and read, isEnabled and textVisible read the same dump.
{
  const ui = new FakeUi();
  ui.fields.set("Group name", "");
  ui.buttons.set("Post", false);
  ui.texts.push("A visible post");
  const driver = driverOf(ui, { attempts: 3 });
  await driver.put("Group name", "Canopy");
  assert.equal(await driver.read("Group name"), "Canopy");
  assert.equal(await driver.isEnabled("Post"), false);
  ui.buttons.set("Post", true);
  assert.equal(await driver.isEnabled("Post"), true);
  assert.equal(await driver.textVisible("A visible post"), true);
  assert.equal(await driver.textVisible("never shown"), false);
  ui.corrupt = () => "wrong";
  await assert.rejects(driver.put("Group name", "Other"), /Visible state did not appear/);
  await assert.rejects(driver.waitFor("missing text", async () => false), /Visible state did not appear: missing text/);
  console.log("PASS put verifies the dump; read, isEnabled and textVisible agree with it");
}
