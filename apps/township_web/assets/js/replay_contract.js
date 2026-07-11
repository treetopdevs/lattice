export const REPLAY_SCHEMA = "township-causal-replay-v1"

export function normalizeReplayPayload(raw) {
  const payload = requireObject(raw, "replay payload")

  if (payload.schema !== REPLAY_SCHEMA) {
    throw new Error(`unsupported causal replay schema ${payload.schema}`)
  }

  const nodes = requireArray(payload.nodes, "nodes").map(normalizeNode)
  const nodesById = indexById(nodes, "node")
  const edges = requireArray(payload.edges, "edges").map((edge, index) =>
    normalizeEdge(edge, index, nodesById),
  )
  const fields = requireArray(payload.fields, "fields").map((field, index) =>
    normalizeField(field, index, nodesById),
  )
  const fieldsById = indexById(fields, "field")
  const frames = requireArray(payload.frames, "frames").map((frame, index) =>
    normalizeFrame(frame, index, nodesById),
  )

  if (frames.length === 0) throw new Error("frames must not be empty")

  return {
    schema: REPLAY_SCHEMA,
    nodes,
    edges,
    fields,
    frames,
    nodesById,
    fieldsById,
  }
}

export function replayFromDataset(dataset) {
  if (dataset.replaySchema !== REPLAY_SCHEMA) {
    throw new Error(`unsupported causal replay schema ${dataset.replaySchema}`)
  }

  if (typeof dataset.replay !== "string") {
    throw new Error("causal replay dataset is missing replay JSON")
  }

  let raw

  try {
    raw = JSON.parse(dataset.replay)
  } catch (_error) {
    throw new Error("causal replay dataset contains invalid JSON")
  }

  return normalizeReplayPayload(raw)
}

function normalizeNode(raw, index) {
  const node = requireObject(raw, `node ${index}`)

  return {
    id: requireString(node.id, `node ${index} id`),
    label: requireString(node.label, `node ${index} label`),
    author: requireString(node.author, `node ${index} author`),
    kind: requireString(node.kind, `node ${index} kind`),
    height: requireNonNegativeInteger(node.height, `node ${index} height`),
    field: requireNullableString(node.field, `node ${index} field`),
  }
}

function normalizeEdge(raw, index, nodesById) {
  const edge = requireObject(raw, `edge ${index}`)
  const from = requireString(edge.from, `edge ${index} from`)
  const to = requireString(edge.to, `edge ${index} to`)

  requireKnownNode(nodesById, from, `edge ${index} from`)
  requireKnownNode(nodesById, to, `edge ${index} to`)

  return { from, to }
}

function normalizeField(raw, index, nodesById) {
  const field = requireObject(raw, `field ${index}`)
  const id = requireString(field.id, `field ${index} id`)
  const writers = requireStringArray(field.writers, `field ${index} writers`)

  for (const writer of writers) {
    requireKnownNode(nodesById, writer, `field ${index} writers`)
  }

  return {
    id,
    label: requireString(field.label, `field ${index} label`),
    writers,
  }
}

function normalizeFrame(raw, index, nodesById) {
  const frame = requireObject(raw, `frame ${index}`)

  if (frame.index !== index) {
    throw new Error(`frame ${index} index must equal ${index}`)
  }

  const head = requireString(frame.head, `frame ${index} head`)
  const visibleIds = requireStringArray(frame.visible_ids, `frame ${index} visible_ids`)
  const frontier = requireStringArray(frame.frontier, `frame ${index} frontier`)
  const quarantine = requireObject(frame.quarantine, `frame ${index} quarantine`)

  requireKnownNode(nodesById, head, `frame ${index} head`)

  for (const id of visibleIds) {
    requireKnownNode(nodesById, id, `frame ${index} visible_ids`)
  }

  if (!visibleIds.includes(head)) {
    throw new Error(`frame ${index} head ${head} must be visible`)
  }

  for (const id of frontier) {
    requireKnownNode(nodesById, id, `frame ${index} frontier`)
  }

  for (const [id, reason] of Object.entries(quarantine)) {
    requireKnownNode(nodesById, id, `frame ${index} quarantine`)
    requireString(reason, `frame ${index} quarantine reason for ${id}`)
  }

  return {
    index,
    head,
    visibleIds,
    frontier,
    state: normalizeState(frame.state, index),
    holders: normalizeStringMap(frame.holders, `frame ${index} holders`, true),
    quarantine: { ...quarantine },
  }
}

function normalizeState(raw, frameIndex) {
  const state = requireObject(raw, `frame ${frameIndex} state`)

  if (typeof state.clerk_locked !== "boolean") {
    throw new Error(`frame ${frameIndex} state clerk_locked must be a boolean`)
  }

  return {
    title: requireString(state.title, `frame ${frameIndex} state title`),
    summary: requireString(state.summary, `frame ${frameIndex} state summary`),
    posts: requireStringArray(state.posts, `frame ${frameIndex} state posts`),
    members: requireStringArray(state.members, `frame ${frameIndex} state members`),
    clerkLocked: state.clerk_locked,
  }
}

function normalizeStringMap(raw, label, nullable) {
  const value = requireObject(raw, label)

  for (const [key, item] of Object.entries(value)) {
    requireString(key, `${label} key`)
    if (!(nullable && item === null)) requireString(item, `${label} value for ${key}`)
  }

  return { ...value }
}

function indexById(values, label) {
  const index = new Map()

  for (const value of values) {
    if (index.has(value.id)) throw new Error(`duplicate ${label} id ${value.id}`)
    index.set(value.id, value)
  }

  return index
}

function requireKnownNode(nodesById, id, label) {
  if (!nodesById.has(id)) throw new Error(`${label} references unknown node ${id}`)
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }

  return value
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function requireString(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  return value
}

function requireNullableString(value, label) {
  if (value === null) return null
  return requireString(value, label)
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }

  return value
}

function requireStringArray(value, label) {
  return requireArray(value, label).map((item, index) =>
    requireString(item, `${label} item ${index}`),
  )
}
