import assert from "node:assert/strict";
import {
  assertSimulatorAppReady,
  bootSimulator,
  installApp,
  launchAndProbe,
  run,
  selectSimulator,
  shutdownSimulator,
  terminateApp,
} from "./support/ios_simulator_key_probe";

// Plan 077 destructive reset control. The relaunch and shutdown/boot smoke proves keys persist;
// this control proves that persistence comes from the simulator's Keychain rather than from a
// constant or app-bundled fixture: after `simctl erase`, both protected keys must be regenerated.
//
// Safety: erase only ever targets a throwaway simulator that this script creates with
// `simctl create` and deletes in `finally`. It never erases a user's existing simulator.

console.log("\n▸ Township iOS simulator protected-key erase control (throwaway simulator)");

// A freshly created or erased simulator performs first-boot data migration, which can take
// several minutes; the normal reboot in the reuse smoke stays on the shorter default.
const firstBootTimeoutMs = 600_000;

await assertSimulatorAppReady();

const template = await selectSimulator();
assert.ok(
  template.deviceTypeIdentifier,
  `simulator ${template.udid} did not report a deviceTypeIdentifier`,
);
const throwawayName = `township-077-erase-control-${Date.now()}`;
const createOutput = await run(
  "xcrun",
  ["simctl", "create", throwawayName, template.deviceTypeIdentifier, template.runtime],
  60_000,
);
// From here on the simulator exists, so every failure must reach the cleanup below. `run` joins
// stdout and stderr, so take the UDID out of the output rather than expecting it alone.
let throwawayUdid: string | undefined;

try {
  throwawayUdid = createOutput.match(
    /\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/i,
  )?.[0];
  assert.ok(throwawayUdid, `simctl create returned no UDID: ${createOutput}`);
  assert.notEqual(throwawayUdid, template.udid, "erase control must not target the template simulator");

  await bootSimulator(throwawayUdid, firstBootTimeoutMs);
  await installApp(throwawayUdid);
  const beforeErase = await launchAndProbe(throwawayUdid);
  await terminateApp(throwawayUdid);

  await shutdownSimulator(throwawayUdid);
  await eraseThrowaway(throwawayUdid);
  await bootSimulator(throwawayUdid, firstBootTimeoutMs);
  await installApp(throwawayUdid);
  const afterErase = await launchAndProbe(throwawayUdid);

  assert.notEqual(
    afterErase.primaryPublicKeyBase64Url,
    beforeErase.primaryPublicKeyBase64Url,
    "primary iOS protected key survived simulator erase; persistence is not Keychain-backed",
  );
  assert.notEqual(
    afterErase.controlPublicKeyBase64Url,
    beforeErase.controlPublicKeyBase64Url,
    "control iOS protected key survived simulator erase; persistence is not Keychain-backed",
  );
} finally {
  // The name is unique to this run, so it still identifies the simulator if no UDID was parsed.
  const throwaway = throwawayUdid ?? throwawayName;
  if (throwawayUdid) {
    await terminateApp(throwawayUdid).catch(() => undefined);
    await shutdownSimulator(throwawayUdid).catch(() => undefined);
  }
  await run("xcrun", ["simctl", "delete", throwaway], 60_000).catch((error: unknown) => {
    console.error(`failed to delete throwaway simulator ${throwaway}: ${String(error)}`);
  });
}

console.log("\x1b[32m✓ Township iOS simulator erase regenerated both protected keys\x1b[0m");

async function eraseThrowaway(udid: string): Promise<void> {
  assert.equal(udid, throwawayUdid, "refusing to erase a simulator this control did not create");
  await run("xcrun", ["simctl", "erase", udid], 120_000);
}
