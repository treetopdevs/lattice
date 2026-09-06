import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { TreehouseWorkflow } from "../src/treehouse_workflow";
import { parseState } from "../src/treehouse_state";
import type { PreviewNative, Draft } from "../src/treehouse_state";
const evidence =
  process.env.TREEHOUSE_EVIDENCE_DIR ?? "/tmp/treehouse-r12-packaged-green";
const binary = resolve(
  "src-tauri/target/release/bundle/macos/Treehouse.app/Contents/MacOS/treehouse-tauri-shell",
);
const appData = resolve(
  homedir(),
  "Library/Application Support/dev.treetop.lattice.treehouse",
);
const database = resolve(appData, "treehouse-v1.sqlite3");
await mkdir(evidence, { recursive: true });
const replayIndex = process.argv.indexOf("--replay");
const replayDirectory =
  replayIndex >= 0 ? process.argv[replayIndex + 1] : undefined;
if (replayIndex >= 0 && !replayDirectory)
  throw Error("--replay needs prior public evidence");
const priorResult = replayDirectory
  ? JSON.parse(await readFile(resolve(replayDirectory, "result.json"), "utf8"))
  : null;
const priorArtifact = replayDirectory
  ? JSON.parse(
      await readFile(resolve(replayDirectory, "public-preview.json"), "utf8"),
    )
  : null;
function rows(): { key: string; value: string }[] {
  return JSON.parse(
    execFileSync(
      "sqlite3",
      [
        "-readonly",
        "-json",
        database,
        "SELECT key,value FROM kv ORDER BY key;",
      ],
      { encoding: "utf8" },
    ) || "[]",
  );
}
try {
  await access(appData);
  // An empty DB left by the scaffold RED is safe to reopen; never clear existing data.
  const retained = rows();
  if (priorResult) {
    const record = retained.find(
      (r) => r.key === "treehouse:preview:history",
    )?.value;
    assert(record);
    assert.equal(
      createHash("sha256").update(record).digest("hex"),
      priorResult.recordSha256,
      "Only the exact test-owned public history can be replayed",
    );
  } else {
    const frames = execFileSync(
      "sqlite3",
      ["-readonly", database, "SELECT count(*) FROM frames;"],
      { encoding: "utf8" },
    ).trim();
    assert.equal(
      retained.length,
      0,
      "A clean account is required; existing Treehouse records are preserved.",
    );
    assert.equal(frames, "0");
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
execFileSync("swiftc", [
  "test/support/packaged_accessibility.swift",
  "-o",
  `${evidence}/accessibility`,
]);
let app: ChildProcess;
const output: string[] = [];
const launch = () => {
  app = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"] });
  app.stdout!.on("data", (v) => output.push(String(v)));
  app.stderr!.on("data", (v) => output.push(String(v)));
};
const stop = async () => {
  if (app.exitCode !== null) return;
  const done = new Promise<void>((r) => app.once("exit", () => r()));
  app.kill("SIGTERM");
  await done;
};
const ax = (...args: string[]) =>
  execFileSync(`${evidence}/accessibility`, [String(app.pid), ...args], {
    encoding: "utf8",
  });
const wait = async (
  label: string,
  predicate = (dump: string) => dump.includes(label),
) => {
  let dump = "";
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    dump = ax("dump");
    if (predicate(dump)) return dump;
  }
  await writeFile(`${evidence}/failed-ui.json`, dump);
  assert.fail(`Visible state did not appear: ${label}`);
};
const snapshot = () => {
  const captured = rows();
  const record = captured.find(
    (r) => r.key === "treehouse:preview:history",
  )?.value;
  assert(record);
  return { record, rows: captured, state: parseState(record) };
};
async function verified(captured: ReturnType<typeof snapshot>) {
  const reader: PreviewNative = {
    open: async () => ({
      record: captured.record,
      publicKey: captured.state.publicKey,
      keyStatus: "available",
    }),
    initialize: async () => {
      throw Error("read-only");
    },
    commit: async () => {
      throw Error("read-only");
    },
    sign: async () => {
      throw Error("read-only");
    },
    saveDraft: async () => {
      throw Error("read-only");
    },
    loadDraft: async (replica) => {
      const record = captured.rows.find(
        (r) => r.key === `treehouse:preview:draft:${replica}`,
      );
      return record ? (JSON.parse(record.value) as Draft) : null;
    },
  };
  const workflow = new TreehouseWorkflow(reader);
  await workflow.open();
  return workflow;
}
launch();
try {
  if (priorArtifact) {
    await wait("This thread is archived.");
    const before = snapshot();
    const first = await verified(before);
    for (const profile of priorArtifact.profiles) {
      const observed = first.views.get(profile.replica)!;
      assert.deepEqual(observed.state, profile.expect.state);
      assert.deepEqual(observed.posts, profile.expect.posts);
      assert.deepEqual(observed.order, profile.expect.order);
    }
    await writeFile(`${evidence}/before-restart-ui.json`, ax("dump"));
    await stop();
    launch();
    await wait("This thread is archived.");
    const after = snapshot();
    assert.deepEqual(after.rows, before.rows);
    await verified(after);
    await writeFile(`${evidence}/after-restart-ui.json`, ax("dump"));
    await writeFile(
      `${evidence}/public-preview.json`,
      JSON.stringify(priorArtifact, null, 2),
    );
    await writeFile(
      `${evidence}/result.json`,
      JSON.stringify(
        {
          status: "PASS",
          gate: "preserved-history-replay",
          priorEvidence: resolve(replayDirectory!),
          binarySha256: createHash("sha256")
            .update(await readFile(binary))
            .digest("hex"),
          gitSha: execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          sourceState: execFileSync("git", ["status", "--porcelain"], {
            encoding: "utf8",
          }),
          recordSha256: createHash("sha256").update(after.record).digest("hex"),
          publicKey: after.state.publicKey,
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS rebuilt packaged UI: exact retained identity, history, posts and drafts through restart",
    );
  } else {
    const empty = await wait("Create local group");
    assert(empty.includes("Recovery is not set up"));
    await writeFile(`${evidence}/empty-ui.json`, empty);
    ax("set", "Group name", "Canopy");
    ax("press", "Create local group");
    await writeFile(`${evidence}/created-ui.json`, await wait("Thread title"));
    ax("set", "Thread title", "Field notes");
    ax("press", "Create thread");
    await wait("Write a post");
    ax("set", "Write a post", "First note from the native app");
    // Wait for the public SQLite draft, not an app-owned test hook or optimistic label.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (
        rows().some(
          (r) =>
            r.key.includes(":draft:") &&
            JSON.parse(r.value).text === "First note from the native app",
        )
      )
        break;
    }
    assert(
      rows().some(
        (r) =>
          r.key.includes(":draft:") &&
          JSON.parse(r.value).text === "First note from the native app",
      ),
    );
    ax("press", "Post");
    await wait("Edit post 1");
    ax("press", "Edit post 1");
    await wait("Save edit");
    ax("set", "Edit post", "Edited in the native app");
    ax("press", "Save edit");
    await wait("Edited in the native app");
    ax("set", "Write a post", "A saved thought for later");
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (
        rows().some(
          (r) =>
            r.key.includes(":draft:") &&
            JSON.parse(r.value).text === "A saved thought for later",
        )
      )
        break;
    }
    ax("press", "Archive thread");
    await wait("This thread is archived.");
    await writeFile(`${evidence}/before-restart-ui.json`, ax("dump"));
    const before = snapshot();
    const first = await verified(before);
    const thread = first.state.profiles.find(
      (p) => p.product === "Treehouse.Thread",
    )!;
    assert.equal(
      first.views.get(thread.replica)!.posts[0]!.text,
      "Edited in the native app",
    );
    assert.equal(first.views.get(thread.replica)!.state.archived, true);
    assert.equal(
      (await first.draft(thread.replica)).text,
      "A saved thought for later",
    );
    await stop();
    launch();
    await wait("This thread is archived.");
    await wait("Edited in the native app");
    const after = snapshot();
    assert.equal(after.record, before.record);
    assert.deepEqual(after.rows, before.rows);
    await writeFile(`${evidence}/after-restart-ui.json`, ax("dump"));
    const second = await verified(after);
    assert.deepEqual(second.state, first.state);
    const profiles = after.state.profiles.map((p) => {
      const v = second.views.get(p.replica)!;
      return {
        ...p,
        expect: {
          state: v.state,
          posts: v.posts,
          order: v.order,
          quarantine: [...v.quarantineReasons].sort(),
          operationCount: v.operationCount,
        },
      };
    });
    const artifact = {
      version: 1,
      product: "treehouse",
      readiness: "recovery_not_ready",
      publicKey: after.state.publicKey,
      profiles,
    };
    await writeFile(
      `${evidence}/public-preview.json`,
      JSON.stringify(artifact, null, 2),
    );
    await writeFile(
      `${evidence}/result.json`,
      JSON.stringify(
        {
          status: "PASS",
          binarySha256: createHash("sha256")
            .update(await readFile(binary))
            .digest("hex"),
          gitSha: execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          sourceState: execFileSync("git", ["status", "--porcelain"], {
            encoding: "utf8",
          }),
          recordSha256: createHash("sha256").update(after.record).digest("hex"),
          profiles: profiles.length,
          frames: profiles.reduce((n, p) => n + p.frames.length, 0),
          publicKey: after.state.publicKey,
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS real packaged UI: empty create, Thread, durable draft, post, edit, archive and exact restart",
    );
  }
} finally {
  await stop();
  await writeFile(`${evidence}/app.log`, output.join(""));
}
