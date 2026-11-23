import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import {
  createIdentityFromSeedHex,
  MemoryDemoStorage,
} from "../src/lib/custody";
import {
  BrowserEcosystemHost,
  type DemoEndpointsManifest,
} from "../src/lib/browser_host";
import {
  authorToolshedBeacon,
  authorToolshedBorrowGrant,
  authorToolshedRequest,
  authorToolshedShedCommand,
  authorToolshedToolCommand,
  authorTownshipCommand,
  authorTreehouseCommand,
  framesToOps,
  frontierIds,
  inspectReplicaLog,
  observeToolshedShed,
  observeToolshedTool,
  observeTownshipMatter,
  observeTreehouse,
  pickCapabilityForCommand,
  pickRootDelegationId,
  signToolshedCustodyConsent,
} from "../src/lib/products";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const TEST_DEMO_DIR = path.join(REPO_ROOT, "output/demo_ecosystem/live_gate_run");
const BASE_PORT = 4240;
const LIVEVIEW_PORT = 4125;

function spawnLines(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { child: ChildProcess; waitFor: (prefix: string, timeoutMs?: number) => Promise<string> } {
  const child = spawn(cmd, args, {
    cwd: REPO_ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const lines: string[] = [];
  const waiters: { prefix: string; resolve: (line: string) => void }[] = [];

  const handleChunk = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      lines.push(line);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (line.includes(waiters[i]!.prefix)) {
          const w = waiters.splice(i, 1)[0]!;
          w.resolve(line);
        }
      }
    }
  };

  child.stdout?.on("data", handleChunk);
  child.stderr?.on("data", handleChunk);

  const waitFor = (prefix: string, timeoutMs = 30_000): Promise<string> => {
    const existing = lines.find((l) => l.includes(prefix));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for "${prefix}". Last lines:\n${lines.slice(-15).join("\n")}`));
      }, timeoutMs);
      waiters.push({
        prefix,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      });
    });
  };

  return { child, waitFor };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string | (() => string),
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  const msg = typeof label === "function" ? label() : label;
  throw new Error(`Timed out waiting for condition: ${msg}`);
}

const relayProc = spawnLines("scripts/demo_ecosystem_relay.sh", [
  "--reset",
  "--dir",
  TEST_DEMO_DIR,
  "--base-port",
  String(BASE_PORT),
]);

let liveViewProc: ReturnType<typeof spawnLines> | null = null;
const founderHost = new BrowserEcosystemHost({
  storage: new MemoryDemoStorage(),
  webSocket: WebSocket as unknown as typeof globalThis.WebSocket,
  pollMs: 60_000,
});
const neighborHost = new BrowserEcosystemHost({
  storage: new MemoryDemoStorage(),
  webSocket: WebSocket as unknown as typeof globalThis.WebSocket,
  pollMs: 60_000,
});

try {
  await relayProc.waitFor("PILOT_READY", 60_000);

  const manifest: DemoEndpointsManifest = JSON.parse(
    fs.readFileSync(path.join(TEST_DEMO_DIR, "demo-endpoints.json"), "utf8"),
  );

  const founderSeed = fs
    .readFileSync(manifest.participants.founder!.seed_file, "utf8")
    .trim();
  const neighborSeed = fs
    .readFileSync(manifest.participants.neighbor!.seed_file, "utf8")
    .trim();

  const founder = createIdentityFromSeedHex("demo-founder", founderSeed);
  const neighbor = createIdentityFromSeedHex("demo-neighbor", neighborSeed);
  const realmByPubkey = {
    [founder.publicKeyBase64]: founder.realm,
    [neighbor.publicKeyBase64]: neighbor.realm,
  };

  await founderHost.configure(manifest.endpoints, founder, "gate-founder");
  await neighborHost.configure(manifest.endpoints, neighbor, "gate-neighbor");
  await founderHost.goOnline();
  await neighborHost.goOnline();

  const ep = (name: string) => {
    const found = manifest.endpoints.find((e) => e.name === name);
    assert.ok(found, `missing endpoint ${name}`);
    return found;
  };

  // ── 1. Treehouse: online post, offline post + heal, unauthorized quarantine ─
  const threadEp = ep("treehouse_thread");
  await waitUntil(
    () =>
      founderHost.getFrames(threadEp.replica).length >= 4 &&
      neighborHost.getFrames(threadEp.replica).length >= 4,
    "initial treehouse thread pull",
  );

  const founderPostCap = pickCapabilityForCommand(
    "Treehouse.Thread",
    founderHost.getFrames(threadEp.replica),
    founder.publicKeyBase64,
    "post",
    realmByPubkey,
  );
  assert.ok(founderPostCap, "founder post cap");

  await founderHost.appendLocalFrame(
    threadEp.replica,
    await authorTreehouseCommand({
      product: "Treehouse.Thread",
      replica: threadEp.replica,
      deps: frontierIds(founderHost.getFrames(threadEp.replica)),
      signer: founder.signer,
      capId: founderPostCap,
      command: { command: "post", text: "Live push from founder" },
    }),
  );

  // Neighbor receives founder's post via ops_available push (pollMs is 60s)
  await waitUntil(() => {
    const ops = framesToOps(
      "Treehouse.Thread",
      neighborHost.getFrames(threadEp.replica),
      realmByPubkey,
    );
    return observeTreehouse("Treehouse.Thread", ops).posts.some(
      (p) => p.text === "Live push from founder",
    );
  }, "neighbor receives founder Treehouse post by push");

  // Neighbor goes OFFLINE, authors offline post, then goes ONLINE -> founder converges
  await neighborHost.goOffline();
  const neighborPostCap = pickCapabilityForCommand(
    "Treehouse.Thread",
    neighborHost.getFrames(threadEp.replica),
    neighbor.publicKeyBase64,
    "post",
    realmByPubkey,
  );
  assert.ok(neighborPostCap, "neighbor post cap");

  await neighborHost.appendLocalFrame(
    threadEp.replica,
    await authorTreehouseCommand({
      product: "Treehouse.Thread",
      replica: threadEp.replica,
      deps: frontierIds(neighborHost.getFrames(threadEp.replica)),
      signer: neighbor.signer,
      capId: neighborPostCap,
      command: { command: "post", text: "Written while offline on neighbor tab" },
    }),
  );
  assert.equal(neighborHost.getPendingCount(threadEp.replica), 1);

  await neighborHost.goOnline();
  await waitUntil(() => {
    const ops = framesToOps(
      "Treehouse.Thread",
      founderHost.getFrames(threadEp.replica),
      realmByPubkey,
    );
    return observeTreehouse("Treehouse.Thread", ops).posts.some(
      (p) => p.text === "Written while offline on neighbor tab",
    );
  }, "founder converges on neighbor offline Treehouse post");
  assert.equal(neighborHost.getPendingCount(threadEp.replica), 0);

  // ── 2. Township + Live Phoenix LiveView server_push convergence ────────────
  liveViewProc = spawnLines("scripts/demo_ecosystem_township_live.sh", [
    String(LIVEVIEW_PORT),
    TEST_DEMO_DIR,
  ]);
  await liveViewProc.waitFor("TOWNSHIP_DEMO_LIVE_READY", 60_000);

  const matterEp = ep("township_matter");
  const neighborMatterCap = pickCapabilityForCommand(
    "Township.Matter",
    neighborHost.getFrames(matterEp.replica),
    neighbor.publicKeyBase64,
    "post",
    realmByPubkey,
  );
  assert.ok(neighborMatterCap, "neighbor matter post cap");

  const livePostText = "Browser starter comment verified in Phoenix LiveView!";
  await neighborHost.appendLocalFrame(
    matterEp.replica,
    await authorTownshipCommand({
      replica: matterEp.replica,
      deps: frontierIds(neighborHost.getFrames(matterEp.replica)),
      signer: neighbor.signer,
      capId: neighborMatterCap,
      command: { command: "post", text: livePostText },
    }),
  );

  // Wait for founderHost to converge on neighbor's Township post first
  await waitUntil(
    () => {
      const view = observeTownshipMatter(founderHost.getFrames(matterEp.replica), realmByPubkey);
      return view.posts.some((p) => p.text === livePostText);
    },
    () =>
      `founder Township view converges on neighbor post (neighbor pending=${neighborHost.getPendingCount(matterEp.replica)}, neighbor feed=${JSON.stringify(neighborHost.getFeedState().routes.find((r) => r.replica === matterEp.replica))})`,
  );

  // Verify Phoenix LiveView's CarrierProjection receives the browser-authored post via ops_available push!
  await liveViewProc.waitFor(livePostText, 15_000);
  // Also confirm the LiveView endpoint itself is serving HTTP 200.
  const lvRes = await fetch(`http://127.0.0.1:${LIVEVIEW_PORT}/township`);
  assert.equal(lvRes.status, 200);

  // ── 3. Toolshed Shed + Tool (ADR 0007 dual-signed custody + lease + BEAM oracle) ─
  const shedEp = ep("toolshed_shed");
  const toolEp = ep("toolshed_tool");

  const founderBulletinCap = pickCapabilityForCommand(
    "Toolshed.Shed",
    founderHost.getFrames(shedEp.replica),
    founder.publicKeyBase64,
    "post_bulletin",
    realmByPubkey,
  );
  assert.ok(founderBulletinCap, "founder steward bulletin cap");

  await founderHost.appendLocalFrame(
    shedEp.replica,
    await authorToolshedShedCommand({
      replica: shedEp.replica,
      deps: frontierIds(founderHost.getFrames(shedEp.replica)),
      signer: founder.signer,
      capId: founderBulletinCap,
      command: { command: "post_bulletin", text: "Saturday shed cleanup at 9am" },
    }),
  );

  await waitUntil(
    () =>
      observeToolshedShed(neighborHost.getFrames(shedEp.replica), realmByPubkey).bulletin ===
      "Saturday shed cleanup at 9am",
    "neighbor receives Toolshed bulletin",
  );

  // Neighbor sends durable :inbox borrow request
  const borrowReq = await authorToolshedRequest({
    replica: toolEp.replica,
    deps: frontierIds(neighborHost.getFrames(toolEp.replica)),
    signer: neighbor.signer,
    requestKind: "borrow",
  });
  await neighborHost.appendLocalFrame(toolEp.replica, borrowReq);

  await waitUntil(
    () =>
      observeToolshedTool(founderHost.getFrames(toolEp.replica), realmByPubkey).requests.some(
        (r) => r.opId === borrowReq.id && !r.resolved,
      ),
    "founder receives neighbor borrow request",
  );

  // Founder tries unconsented transfer -> quarantined as missing_consent on BOTH peers!
  const custodyCap = pickCapabilityForCommand(
    "Toolshed.Tool",
    founderHost.getFrames(toolEp.replica),
    founder.publicKeyBase64,
    "custody_transfer",
    realmByPubkey,
  );
  assert.ok(custodyCap, "founder custody cap");

  const unconsentedFrame = await authorToolshedToolCommand({
    replica: toolEp.replica,
    deps: frontierIds(founderHost.getFrames(toolEp.replica)),
    signer: founder.signer,
    capId: custodyCap,
    command: {
      command: "custody_transfer",
      toPubkeyBase64: neighbor.publicKeyBase64,
      requestOpId: borrowReq.id,
      consentSigBase64: null,
    },
  });
  await founderHost.appendLocalFrame(toolEp.replica, unconsentedFrame);

  await waitUntil(() => {
    const inspected = inspectReplicaLog(
      "Toolshed.Tool",
      neighborHost.getFrames(toolEp.replica),
      realmByPubkey,
    );
    return inspected.ops.some(
      (o) => o.id === unconsentedFrame.id && o.quarantined && o.reason === "missing_consent",
    );
  }, "neighbor observes unconsented custody_transfer quarantined");

  // Neighbor signs ADR 0007 consent; founder executes dual-signed transfer + due epoch 2 lease
  const consentSig = await signToolshedCustodyConsent({
    replica: toolEp.replica,
    requestOpId: borrowReq.id,
    fromPubkeyBase64: founder.publicKeyBase64,
    recipientSigner: neighbor.signer,
  });
  const dualTransfer = await authorToolshedToolCommand({
    replica: toolEp.replica,
    deps: frontierIds(founderHost.getFrames(toolEp.replica)),
    signer: founder.signer,
    capId: custodyCap,
    command: {
      command: "custody_transfer",
      toPubkeyBase64: neighbor.publicKeyBase64,
      requestOpId: borrowReq.id,
      consentSigBase64: consentSig,
    },
  });
  await founderHost.appendLocalFrame(toolEp.replica, dualTransfer);

  const rootCap = pickRootDelegationId(
    founderHost.getFrames(toolEp.replica),
    founder.publicKeyBase64,
  );
  assert.ok(rootCap, "tool root cap");
  await founderHost.appendLocalFrame(
    toolEp.replica,
    await authorToolshedBorrowGrant({
      replica: toolEp.replica,
      deps: frontierIds(founderHost.getFrames(toolEp.replica)),
      parentDelegationId: rootCap,
      borrowerPubkeyBase64: neighbor.publicKeyBase64,
      expiresEpoch: 2,
      signer: founder.signer,
    }),
  );

  await waitUntil(() => {
    const view = observeToolshedTool(neighborHost.getFrames(toolEp.replica), realmByPubkey);
    return !view.custody.available && view.loan?.dueEpoch === 2 && !view.loan.overdue;
  }, "neighbor observes active leased loan");

  // Founder advances beacon to epoch 3 -> overdue computed!
  await founderHost.appendLocalFrame(
    toolEp.replica,
    await authorToolshedBeacon({
      replica: toolEp.replica,
      deps: frontierIds(founderHost.getFrames(toolEp.replica)),
      epoch: 3,
      signer: founder.signer,
    }),
  );

  await waitUntil(
    () =>
      observeToolshedTool(neighborHost.getFrames(toolEp.replica), realmByPubkey).loan?.overdue ===
      true,
    "neighbor computes overdue loan after epoch 3 beacon",
  );

  // Neighbor requests return, founder resolves return
  const returnReq = await authorToolshedRequest({
    replica: toolEp.replica,
    deps: frontierIds(neighborHost.getFrames(toolEp.replica)),
    signer: neighbor.signer,
    requestKind: "return",
  });
  await neighborHost.appendLocalFrame(toolEp.replica, returnReq);

  await waitUntil(
    () =>
      observeToolshedTool(founderHost.getFrames(toolEp.replica), realmByPubkey).requests.some(
        (r) => r.opId === returnReq.id && r.requestKind === "return",
      ),
    "founder receives return request",
  );

  const returnConsent = await signToolshedCustodyConsent({
    replica: toolEp.replica,
    requestOpId: returnReq.id,
    fromPubkeyBase64: founder.publicKeyBase64,
    recipientSigner: founder.signer,
  });
  await founderHost.appendLocalFrame(
    toolEp.replica,
    await authorToolshedToolCommand({
      replica: toolEp.replica,
      deps: frontierIds(founderHost.getFrames(toolEp.replica)),
      signer: founder.signer,
      capId: custodyCap,
      command: {
        command: "custody_transfer",
        toPubkeyBase64: founder.publicKeyBase64,
        requestOpId: returnReq.id,
        consentSigBase64: returnConsent,
      },
    }),
  );

  await waitUntil(() => {
    const view = observeToolshedTool(neighborHost.getFrames(toolEp.replica), realmByPubkey);
    return view.custody.available && view.requests.every((r) => r.resolved);
  }, "neighbor observes tool returned home");

  // ── 4. Cross-runtime BEAM Oracle Verification on persisted relay logs ──────
  const beamEnv = {
    ...process.env,
    PATH: `${process.env.HOME}/.asdf/installs/erlang/28.3.1/bin:${process.env.HOME}/.asdf/installs/elixir/1.19.5-otp-28/bin:${process.env.PATH ?? ""}`,
  };
  const elixirCheck = `
    Enum.each([Treehouse.Space, Treehouse.Thread, Township.Matter, Toolshed.Shed, Toolshed.Tool], &Code.ensure_loaded!/1)

    {:ok, tool_log} = Lattice.Log.restore(${JSON.stringify(path.join(TEST_DEMO_DIR, "logs/toolshed_tool.log"))})
    model = Toolshed.ReadModel.observe(tool_log)
    true = model.custody.available?
    true = model.loan == nil
    true = length(model.requests) == 2 and Enum.all?(model.requests, & &1.resolved?)
    true = Map.get(model.evidence.reasons, ${JSON.stringify(unconsentedFrame.id)}) == :missing_consent

    {:ok, shed_log} = Lattice.Log.restore(${JSON.stringify(path.join(TEST_DEMO_DIR, "logs/toolshed_shed.log"))})
    true = Lattice.state(Toolshed.Shed, shed_log).bulletin == "Saturday shed cleanup at 9am"

    {:ok, thread_log} = Lattice.Log.restore(${JSON.stringify(path.join(TEST_DEMO_DIR, "logs/treehouse_thread.log"))})
    thread_view = Treehouse.ReadModel.observe(Treehouse.Thread, thread_log)
    true = Enum.any?(thread_view.posts, &(&1.text == "Written while offline on neighbor tab"))

    IO.puts("BEAM_ORACLE_VERIFIED")
  `;
  const beamOut = execFileSync(
    `${process.env.HOME}/.asdf/shims/mix`,
    ["run", "--no-compile", "-e", elixirCheck],
    { cwd: REPO_ROOT, env: beamEnv, encoding: "utf8" },
  );
  assert.ok(beamOut.includes("BEAM_ORACLE_VERIFIED"), `BEAM oracle output: ${beamOut}`);

  console.log(
    "PASS: live_ecosystem_gate green across Treehouse, Township (+ Phoenix LiveView push), Toolshed (ADR 0007 + leases + overdue + return), and BEAM oracle verification!",
  );
} finally {
  await founderHost.dispose();
  await neighborHost.dispose();
  liveViewProc?.child.kill("SIGTERM");
  relayProc.child.stdin?.end();
  relayProc.child.kill("SIGTERM");
  fs.rmSync(TEST_DEMO_DIR, { recursive: true, force: true });
}
