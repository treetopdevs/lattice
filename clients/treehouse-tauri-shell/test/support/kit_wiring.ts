import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CarrierPeerError } from "@treetopdevs/lattice-client";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import { FakeClock, FakeRelay } from "@treetopdevs/lattice-shell-kit/testing";

// Plan 186 wiring acceptance: the kit and the shell resolve one lattice-client copy. Run under
// `tsx --preserve-symlinks` from the shell directory. A peer error raised inside the kit must be an
// instance of the class the shell imports; a second copy would split `instanceof`.

const kitPeers = resolve(process.cwd(), "../lattice-shell-kit/node_modules/@treetopdevs");
assert.equal(
  existsSync(kitPeers),
  false,
  `${kitPeers} exists: under --preserve-symlinks the kit would load its own lattice-client copy. ` +
    "The kit lists lattice-client as a peer only and installs with legacy-peer-deps; remove that directory.",
);

const relay = new FakeRelay(new FakeClock(), "kit-wiring");
relay.errors.set("*", "unavailable");
const thrown = await relay.deliver({ id: "kit-wiring" } as unknown as CarrierOpFrame).then(
  () => undefined,
  (error: unknown) => error,
);
assert.ok(thrown instanceof CarrierPeerError, `kit threw a CarrierPeerError from another lattice-client copy: ${String(thrown)}`);
assert.equal(thrown.reason, "unavailable");
console.log("kit wiring: one lattice-client copy");
