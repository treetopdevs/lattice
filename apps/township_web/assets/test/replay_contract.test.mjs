import assert from "node:assert/strict"
import test from "node:test"

import {
  REPLAY_SCHEMA,
  normalizeReplayPayload,
  replayFromDataset,
} from "../js/replay_contract.js"

function validPayload() {
  return {
    schema: REPLAY_SCHEMA,
    nodes: [
      {
        id: "op-1",
        label: "genesis",
        author: "clerk",
        kind: "authority",
        height: 0,
        field: null,
      },
    ],
    edges: [],
    fields: [{ id: "title", label: "Title", writers: [] }],
    frames: [
      {
        index: 0,
        head: "op-1",
        visible_ids: ["op-1"],
        frontier: ["op-1"],
        state: {
          title: "",
          summary: "",
          posts: [],
          members: [],
          clerk_locked: false,
        },
        holders: { clerk: "clerk-key" },
        quarantine: {},
      },
    ],
  }
}

test("normalizes the server payload before drawing code reads it", () => {
  const replay = normalizeReplayPayload(validPayload())

  assert.equal(replay.schema, REPLAY_SCHEMA)
  assert.deepEqual(replay.frames[0].visibleIds, ["op-1"])
  assert.equal("visible_ids" in replay.frames[0], false)
  assert.deepEqual(replay.fieldsById.get("title").writers, [])
  assert.equal(replay.nodesById.get("op-1").kind, "authority")
})

test("parses the host dataset through the same normalizer", () => {
  const payload = validPayload()
  const replay = replayFromDataset({
    replaySchema: REPLAY_SCHEMA,
    replay: JSON.stringify(payload),
  })

  assert.equal(replay.frames[0].head, "op-1")
})

test("rejects malformed frames and references instead of leaving them to the renderer", () => {
  const unknownVisibleId = validPayload()
  unknownVisibleId.frames[0].visible_ids = ["missing"]

  assert.throws(
    () => normalizeReplayPayload(unknownVisibleId),
    /frame 0 visible_ids references unknown node missing/,
  )

  const malformed = validPayload()
  malformed.frames[0].quarantine = []
  assert.throws(() => normalizeReplayPayload(malformed), /frame 0 quarantine must be an object/)
})
