import assert from "node:assert/strict";
import {
  TOWNSHIP_IOS_KEY_REUSE_CONTROL_KEY_ID,
  TOWNSHIP_IOS_KEY_REUSE_PROBE_LOG_PREFIX,
  logTownshipIosKeyReuseProbeFromEnv,
  townshipIosKeyReuseProbeEnabled,
  townshipIosKeyReuseProbeLogLine,
} from "../src/township_ios_key_reuse_probe";
import type { TownshipNativeStatus } from "../src/native_workflow";

console.log("\n▸ Township iOS protected-key relaunch probe contract");

const readyStatus: TownshipNativeStatus = {
  ready: true,
  keyId: "township-resident",
  storageNamespace: "township:zoning-variance-24",
  publicKeyBase64: "+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/8=",
  storageEcho: "native invoke ready",
  signatureBytes: 64,
};
const unavailableStatus: TownshipNativeStatus = {
  ready: false,
  keyId: "township-resident",
  storageNamespace: "township:zoning-variance-24",
  error: "NSOSStatusErrorDomain Code=-34018: Client has neither application-identifier nor keychain-access-groups",
};

assert.equal(townshipIosKeyReuseProbeEnabled({}), false);
assert.equal(
  townshipIosKeyReuseProbeEnabled({ VITE_TOWNSHIP_IOS_KEY_REUSE_PROBE: "true" }),
  false,
  "the probe should require an explicit build-only value",
);
assert.equal(townshipIosKeyReuseProbeEnabled({ VITE_TOWNSHIP_IOS_KEY_REUSE_PROBE: " 1 " }), true);

const readyLine = townshipIosKeyReuseProbeLogLine(readyStatus);
assert.match(readyLine, new RegExp(`^${TOWNSHIP_IOS_KEY_REUSE_PROBE_LOG_PREFIX} `));
assert.match(readyLine, /store=ios_protected_keychain/);
assert.match(readyLine, /slot=primary/);
assert.match(readyLine, /outcome=ready/);
assert.match(readyLine, /key_id=township-resident/);
assert.match(readyLine, /public_key_base64url=[\-_][\-_A-Za-z0-9]+/);
assert.match(readyLine, /signature_bytes=64/);
assert.doesNotMatch(readyLine, /storageNamespace|storageEcho|native invoke ready/);

const controlLine = townshipIosKeyReuseProbeLogLine(
  {
    ...readyStatus,
    keyId: TOWNSHIP_IOS_KEY_REUSE_CONTROL_KEY_ID,
    publicKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  },
  "control",
);
assert.match(controlLine, /slot=control/);
assert.match(controlLine, /key_id=township-ios-key-reuse-control/);
assert.match(controlLine, /public_key_base64url=A{43}/);

const unavailableLine = townshipIosKeyReuseProbeLogLine(unavailableStatus);
assert.match(unavailableLine, /outcome=error/);
assert.match(unavailableLine, /error=NSOSStatusErrorDomain_Code_-34018:_Client_has_neither_application-identifier_nor_keychain-access-groups/);
assert.doesNotMatch(unavailableLine, /\sClient has neither/);

const disabledLogs: string[] = [];
assert.equal(
  await logTownshipIosKeyReuseProbeFromEnv(readyStatus, {}, {
    invoke(command, args) {
      disabledLogs.push(`${command}:${String(args.event)}`);
      return Promise.resolve();
    },
  }),
  false,
);
assert.deepEqual(disabledLogs, []);

const enabledLogs: string[] = [];
assert.equal(
  await logTownshipIosKeyReuseProbeFromEnv(
    readyStatus,
    { VITE_TOWNSHIP_IOS_KEY_REUSE_PROBE: "1" },
    {
      invoke(command, args) {
        assert.equal(command, "lattice_log_probe");
        enabledLogs.push(String(args.event));
        return Promise.resolve();
      },
    },
  ),
  true,
);
assert.deepEqual(enabledLogs, [readyLine]);

console.log("\x1b[32m✓ iOS protected-key relaunch probe contract checks passed\x1b[0m");
