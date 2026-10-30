import assert from "node:assert/strict";
import {
  assertSimulatorAppReady,
  bootSimulator,
  installApp,
  launchAndProbe,
  selectSimulator,
  shutdownSimulator,
  terminateApp,
  waitForBoot,
} from "./support/ios_simulator_key_probe";

// Plan 077: two independently named protected Keychain keys must differ, survive a process
// terminate/relaunch, and survive a full simulator shutdown/boot cycle. Uses xcrun simctl only;
// the destructive erase control lives in tauri_ios_key_erase_control_smoke.ts and never runs here.

console.log("\n▸ Township iOS simulator protected-key relaunch + shutdown/boot smoke");

await assertSimulatorAppReady();

const simulator = await selectSimulator();
const initiallyBooted = simulator.state === "Booted";
const bootedBySmoke = !initiallyBooted;

try {
  if (bootedBySmoke) {
    await bootSimulator(simulator.udid);
  } else {
    await waitForBoot(simulator.udid);
  }
  await terminateApp(simulator.udid).catch(() => undefined);
  await installApp(simulator.udid);

  const first = await launchAndProbe(simulator.udid);
  await terminateApp(simulator.udid);
  const second = await launchAndProbe(simulator.udid);
  const publicKeyAfterRelaunch = second.primaryPublicKeyBase64Url;
  const controlPublicKeyAfterRelaunch = second.controlPublicKeyBase64Url;

  assert.notEqual(second.pid, first.pid, "iOS app process id did not change after terminate/relaunch");
  assert.notEqual(
    first.primaryPublicKeyBase64Url,
    first.controlPublicKeyBase64Url,
    "independently named iOS protected keys should not collapse to one constant key",
  );
  assert.equal(
    publicKeyAfterRelaunch,
    first.primaryPublicKeyBase64Url,
    "primary iOS protected key changed after process relaunch",
  );
  assert.equal(
    controlPublicKeyAfterRelaunch,
    first.controlPublicKeyBase64Url,
    "control iOS protected key changed after process relaunch",
  );
  console.log("  ✓ both protected keys survived process terminate/relaunch");

  // Full simulator shutdown/boot cycle. The strict shutdown waits for the Shutdown state, so the
  // third launch is a fresh process in a freshly booted simulator. That sequence, not a PID
  // comparison, is the freshness proof: PIDs may legally be reused across boots.
  await terminateApp(simulator.udid);
  await shutdownSimulator(simulator.udid);
  await bootSimulator(simulator.udid);
  const third = await launchAndProbe(simulator.udid);
  const publicKeyAfterBootCycle = third.primaryPublicKeyBase64Url;
  const controlPublicKeyAfterBootCycle = third.controlPublicKeyBase64Url;

  assert.equal(
    publicKeyAfterBootCycle,
    first.primaryPublicKeyBase64Url,
    "primary iOS protected key changed after simulator shutdown/boot",
  );
  assert.equal(
    controlPublicKeyAfterBootCycle,
    first.controlPublicKeyBase64Url,
    "control iOS protected key changed after simulator shutdown/boot",
  );
  console.log("  ✓ both protected keys survived simulator shutdown/boot");
} finally {
  await terminateApp(simulator.udid).catch(() => undefined);
  if (bootedBySmoke) {
    await shutdownSimulator(simulator.udid).catch(() => undefined);
  } else {
    // A failure mid-cycle can leave a simulator the user had booted shut down; boot it again.
    await bootSimulator(simulator.udid).catch(() => undefined);
  }
}

console.log(
  "\x1b[32m✓ Township iOS simulator protected keys survived process relaunch and simulator shutdown/boot\x1b[0m",
);
