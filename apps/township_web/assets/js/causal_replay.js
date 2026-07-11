import { Graph, layout } from "@dagrejs/dagre"
import { computed, createApp, h, onMounted, ref, watch } from "vue"
import { replayFromDataset } from "./replay_contract"

const nodeWidth = 152
const nodeHeight = 42

export const TownshipCausalReplay = {
  mounted() {
    const replay = replayFromDataset(this.el.dataset)
    const layoutState = layoutReplay(replay)
    const host = this.el
    const mountPoint = document.createElement("div")
    mountPoint.dataset.causalReplayRoot = ""
    host.append(mountPoint)

    this.vueApp = createApp({
      setup() {
        const canvas = ref(null)
        const frameIndex = ref(replay.frames.length - 1)
        const frame = computed(() => replay.frames[frameIndex.value])
        const selectedField = ref(null)
        const selectedOp = ref(null)
        const nodesById = replay.nodesById
        const fieldsById = replay.fieldsById
        const selectedNode = computed(() => nodesById.get(selectedOp.value) || null)
        const highlightedWriters = computed(
          () => fieldsById.get(selectedField.value)?.writers || [],
        )
        const selectedOpVisible = computed(
          () => selectedNode.value && frame.value.visibleIds.includes(selectedNode.value.id),
        )
        const selectedOpReason = computed(
          () => (selectedNode.value && frame.value.quarantine[selectedNode.value.id]) || null,
        )
        const selectedOpStatus = computed(() => {
          if (!selectedNode.value) return null
          if (!selectedOpVisible.value) return "beyond frontier"
          return selectedOpReason.value ? "quarantined" : "honored"
        })

        const renderFrame = (nextFrame) => {
          paintReplay(canvas.value, replay, layoutState, nextFrame, {
            selectedOp: selectedOp.value,
            highlightedWriters: highlightedWriters.value,
          })
          host.dataset.replayFrame = String(nextFrame.index)
          host.dataset.visibleCount = String(nextFrame.visibleIds.length)
          host.dataset.quarantineCount = String(Object.keys(nextFrame.quarantine).length)
          setHostData(host, "selectedField", selectedField.value)
          setHostData(host, "selectedOp", selectedOp.value)
          setHostData(host, "highlightedWriters", highlightedWriters.value.join(","))
        }

        onMounted(() => {
          renderFrame(frame.value)
          host.dataset.vueMounted = "true"
        })

        watch([frame, selectedField, selectedOp], () => renderFrame(frame.value), {
          flush: "post",
        })

        const selectCanvasNode = (event) => {
          const bounds = canvas.value.getBoundingClientRect()
          const x = (event.clientX - bounds.left) * (canvas.value.width / bounds.width)
          const y = (event.clientY - bounds.top) * (canvas.value.height / bounds.height)
          const visible = new Set(frame.value.visibleIds)

          const hit = replay.nodes.find((node) => {
            if (!visible.has(node.id)) return false
            const position = layoutState.positions.get(node.id)
            return (
              Math.abs(position.x - x) <= nodeWidth / 2 &&
              Math.abs(position.y - y) <= nodeHeight / 2
            )
          })

          if (hit) {
            selectedField.value = null
            selectedOp.value = hit.id
          }
        }

        return () =>
          h("div", { class: "causal-replay" }, [
            h("div", { class: "causal-replay__status" }, [
              h("span", { class: "field-label" }, "Causal replay · verified snapshot"),
              h("span", { class: "metric" }, `${replay.frames.length} frames`),
            ]),
            h("div", { class: "causal-replay__transport" }, [
              h("input", {
                type: "range",
                min: 0,
                max: replay.frames.length - 1,
                step: 1,
                value: frameIndex.value,
                "data-replay-scrubber": "",
                "aria-label": "Causal replay frame",
                onInput: (event) => {
                  frameIndex.value = Number(event.target.value)
                },
              }),
              h(
                "output",
                { class: "causal-replay__position", "data-replay-position": "" },
                `${frame.value.index + 1} / ${replay.frames.length}`,
              ),
            ]),
            h("div", { class: "causal-replay__frame-state" }, [
              h("span", { class: "field-label" }, "Summary at frontier"),
              h(
                "strong",
                { "data-replay-summary": "" },
                frame.value.state.summary || "—",
              ),
            ]),
            h("div", { class: "causal-replay__controls" }, [
              h(
                "div",
                {
                  class: "causal-replay__fields",
                  role: "group",
                  "aria-label": "State field provenance",
                },
                replay.fields.map((field) =>
                  h(
                    "button",
                    {
                      type: "button",
                      class: selectedField.value === field.id ? "is-active" : null,
                      "data-replay-field": field.id,
                      "aria-pressed": String(selectedField.value === field.id),
                      onClick: () => {
                        selectedOp.value = null
                        selectedField.value = field.id
                      },
                    },
                    field.label,
                  ),
                ),
              ),
              h(
                "select",
                {
                  value: selectedOp.value || "",
                  "data-replay-op-select": "",
                  "aria-label": "Operation evidence",
                  onChange: (event) => {
                    selectedField.value = null
                    selectedOp.value = event.target.value || null
                  },
                },
                [h("option", { value: "" }, "Operation evidence")].concat(
                  replay.nodes.map((node) =>
                    h("option", { value: node.id }, truncate(node.label, 44)),
                  ),
                ),
              ),
            ]),
            selectionDetail({
              selectedField: selectedField.value,
              selectedNode: selectedNode.value,
              selectedOpStatus: selectedOpStatus.value,
              selectedOpReason: selectedOpReason.value,
              highlightedWriters: highlightedWriters.value,
            }),
            h("div", { class: "causal-replay__viewport" }, [
              h("canvas", {
                ref: canvas,
                class: "causal-replay__canvas",
                width: layoutState.width,
                height: layoutState.height,
                "data-causal-replay-canvas": "",
                "aria-hidden": "true",
                onClick: selectCanvasNode,
              }),
            ]),
          ])
      },
    })

    this.vueApp.mount(mountPoint)
  },

  destroyed() {
    this.vueApp?.unmount()
  },
}

function layoutReplay(replay) {
  const graph = new Graph()
  graph.setGraph({ rankdir: "TB", nodesep: 18, ranksep: 28, marginx: 24, marginy: 24 })
  graph.setDefaultEdgeLabel(() => ({}))

  for (const node of replay.nodes) {
    graph.setNode(node.id, { width: nodeWidth, height: nodeHeight })
  }

  for (const edge of replay.edges) {
    graph.setEdge(edge.from, edge.to)
  }

  layout(graph)

  const dimensions = graph.graph()
  const positions = new Map(
    replay.nodes.map((node) => {
      const position = graph.node(node.id)
      return [node.id, { x: position.x, y: position.y }]
    }),
  )

  return {
    width: Math.max(620, Math.ceil(dimensions.width + 48)),
    height: Math.max(320, Math.ceil(dimensions.height + 48)),
    positions,
  }
}

function paintReplay(canvas, replay, layoutState, frame, selection) {
  const context = canvas.getContext("2d")
  const visible = new Set(frame.visibleIds)

  context.fillStyle = "#fbfcfa"
  context.fillRect(0, 0, canvas.width, canvas.height)

  for (const edge of replay.edges) {
    if (!visible.has(edge.from) || !visible.has(edge.to)) continue
    const from = layoutState.positions.get(edge.from)
    const to = layoutState.positions.get(edge.to)

    context.beginPath()
    context.moveTo(from.x, from.y + nodeHeight / 2)
    context.bezierCurveTo(from.x, from.y + nodeHeight, to.x, to.y - nodeHeight, to.x, to.y - nodeHeight / 2)
    context.strokeStyle = "#aab7b2"
    context.lineWidth = 1.5
    context.stroke()
  }

  for (const node of replay.nodes) {
    if (!visible.has(node.id)) continue
    drawNode(
      context,
      node,
      layoutState.positions.get(node.id),
      frame.quarantine[node.id],
      node.id === selection.selectedOp || selection.highlightedWriters.includes(node.id),
    )
  }
}

function drawNode(context, node, position, frameReason, highlighted) {
  const left = position.x - nodeWidth / 2
  const top = position.y - nodeHeight / 2
  const quarantined = Boolean(frameReason)

  context.fillStyle = quarantined ? "#fff0ed" : node.kind === "authority" ? "#f2efff" : "#e9f6f2"
  context.strokeStyle = highlighted
    ? "#bd5d12"
    : quarantined
      ? "#c23b32"
      : node.kind === "authority"
        ? "#594a93"
        : "#0e6b5b"
  context.lineWidth = highlighted || quarantined ? 2.75 : 1.75
  context.fillRect(left, top, nodeWidth, nodeHeight)
  context.strokeRect(left, top, nodeWidth, nodeHeight)

  context.fillStyle = "#172521"
  context.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace"
  context.fillText(truncate(node.label, 24), left + 8, top + 16)
  context.fillStyle = quarantined ? "#c23b32" : "#4e5f59"
  context.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace"
  context.fillText(`${node.author} · h${node.height}`, left + 8, top + 31)
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}

function selectionDetail({
  selectedField,
  selectedNode,
  selectedOpStatus,
  selectedOpReason,
  highlightedWriters,
}) {
  let content

  if (selectedField) {
    content = [
      h("strong", `${highlightedWriters.length} writing ops`),
      h(
        "span",
        highlightedWriters.length > 0
          ? highlightedWriters.map((id) => id.slice(0, 8)).join(" · ")
          : "No writes in this snapshot",
      ),
    ]
  } else if (selectedNode) {
    content = [
      h("dl", { class: "causal-replay__selection-details" }, [
        detail("Status", selectedOpStatus, "data-selected-op-status"),
        detail("Reason", selectedOpReason || "—", "data-selected-op-reason"),
        detail("Author", selectedNode.author, "data-selected-op-author"),
        detail("Field", selectedNode.field || "—", "data-selected-op-field"),
      ]),
    ]
  } else {
    content = [
      h("strong", "No focused evidence"),
      h("span", `${highlightedWriters.length} highlighted writers`),
    ]
  }

  return h(
    "div",
    {
      class: "causal-replay__selection",
      "data-replay-selection": "",
      "aria-live": "polite",
    },
    content,
  )
}

function detail(label, value, attribute) {
  return h("div", [h("dt", label), h("dd", { [attribute]: "" }, value)])
}

function setHostData(host, key, value) {
  if (value) host.dataset[key] = value
  else delete host.dataset[key]
}
