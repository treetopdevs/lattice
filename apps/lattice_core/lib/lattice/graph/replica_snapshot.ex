defmodule Lattice.Graph.ReplicaSnapshot do
  @moduledoc """
  Read-only visualization of a v2 Replica op-log as a causal DAG (plan 012).

  The v1 inspector (`Lattice.Graph.Snapshot`) draws the live trust graph of the
  process world; this module is its v2 sibling: it draws one `Lattice.Log` — the
  hash-DAG of signed ops that *is* a Replica — with the authority verdicts
  overlaid. It is a pure consumer of `Log`/`Dag`/`Authority` and can never affect
  engine determinism.

  ## Design decisions

    * **Node = one admitted op.** `id` is the op id; the label shows a short
      hash, the op `kind`, and a compact body summary. Ops structurally
      quarantined at accept time (bad signature) never enter `Log.ops/1` and are
      not rendered.
    * **Edge = one dependency link, drawn dependency → dependent.** This reverses
      the raw `op.deps` pointer direction so `graph TD` / `digraph` renderers lay
      the DAG out top-to-bottom in causal order (roots at top, frontier at the
      bottom). Purely a rendering choice; the edge count still equals the total
      number of in-log deps.
    * **Status overlay from `Authority.analyze/2`.** An op in `reasons` gets
      `status: "quarantined"` plus its reason and a distinct style; every other
      op is `"honored"`. Final `holders` (role → author fingerprint) ride on the
      graph value and render as a legend — the analysis exposes only the final
      holder per role, not per-op holders, and this module does not extend it.
    * **Layout hint.** Each node carries its `Dag.heights/1` causal height;
      nodes are sorted by `{height, id}` so all outputs are deterministic.
    * **Export reuse vs. local Mermaid.** The graph value is shaped for
      `Lattice.Graph.Export` (nodes with `id`/`kind`/`label`, edges with
      `from`/`to`/`kind`), so `:json` and `:dot` delegate to it unchanged. The
      v1 Mermaid renderer cannot express per-node status (no `classDef`), so
      `:mermaid` is rendered by a small local function instead of changing
      `export.ex` — the divergence the plan's STOP condition prescribes.
    * **DAG + quarantine only.** The reduced state is not drawn alongside the
      DAG; `scripts/lattice2_demo.exs` already narrates state, and mixing the
      two would blur what the diagram proves (open question resolved for now).
  """

  alias Lattice.{Authority, Dag, Identity, Log, Op}
  alias Lattice.Graph.{AuthorityBody, Export}

  @label_summary_width 32

  @type node_entry :: %{
          id: Op.id(),
          kind: String.t(),
          label: String.t(),
          status: String.t(),
          reason: String.t() | nil,
          height: non_neg_integer(),
          author: String.t()
        }
  @type edge_entry :: %{from: Op.id(), to: Op.id(), kind: String.t()}
  @type graph :: %{
          replica: String.t(),
          nodes: [node_entry()],
          edges: [edge_entry()],
          holders: %{atom() => String.t() | nil},
          frontier: [Op.id()]
        }

  @doc """
  Build the graph value for `log` interpreted by Replica `module`.

  Deterministic: depends only on the op set (nodes sorted by causal height then
  id, edges by `{from, to}`), never on arrival order.
  """
  @spec build(module(), Log.t()) :: graph()
  def build(module, %Log{} = log) do
    ops = Log.ops(log)
    heights = Dag.heights(ops)
    analysis = Authority.analyze(module, log)

    nodes =
      ops
      |> Map.values()
      |> Enum.map(&node_entry(&1, heights, analysis.reasons))
      |> Enum.sort_by(&{&1.height, &1.id})

    edges =
      ops
      |> Map.values()
      |> Enum.flat_map(fn op ->
        for dep <- op.deps,
            Map.has_key?(ops, dep),
            do: %{from: dep, to: op.id, kind: "dep"}
      end)
      |> Enum.sort_by(&{&1.from, &1.to})

    %{
      replica: log.replica,
      nodes: nodes,
      edges: edges,
      holders:
        Map.new(analysis.holders, fn {role, pub} ->
          {role, pub && Identity.fingerprint(pub)}
        end),
      frontier: Log.frontier(log)
    }
  end

  @doc """
  Render a graph built by `build/2`.

  `:json` and `:dot` delegate to `Lattice.Graph.Export`; `:mermaid` is rendered
  locally so quarantined ops get a distinct `classDef` style (see moduledoc).
  """
  @spec export(graph(), :mermaid | :dot | :json | String.t()) :: String.t()
  def export(graph, :mermaid), do: to_mermaid(graph)
  def export(graph, "mermaid"), do: to_mermaid(graph)
  def export(graph, format), do: Export.export(graph, format)

  @doc "Render the graph as Mermaid `graph TD` with quarantine/holder overlays."
  @spec to_mermaid(graph()) :: String.t()
  def to_mermaid(graph) do
    holder_lines =
      for {role, fp} <- Enum.sort(graph.holders) do
        "  %% holder #{inspect(role)}: #{fp || "(none)"}"
      end

    node_lines =
      Enum.map(graph.nodes, fn node ->
        ~s(  #{mermaid_id(node.id)}["#{mermaid_escape(node.label)}"]:::#{node.status})
      end)

    edge_lines =
      Enum.map(graph.edges, fn edge ->
        "  #{mermaid_id(edge.from)} --> #{mermaid_id(edge.to)}"
      end)

    class_lines = [
      "  classDef honored fill:#eef7ee,stroke:#2e7d32,color:#1b5e20",
      "  classDef quarantined fill:#fdecea,stroke:#c62828,color:#b71c1c,stroke-dasharray: 4 3"
    ]

    Enum.join(["graph TD"] ++ holder_lines ++ node_lines ++ edge_lines ++ class_lines, "\n")
  end

  # --- Nodes ----------------------------------------------------------------

  defp node_entry(%Op{} = op, heights, reasons) do
    {status, reason} =
      case Map.fetch(reasons, op.id) do
        {:ok, reason} -> {"quarantined", Atom.to_string(reason)}
        :error -> {"honored", nil}
      end

    %{
      id: op.id,
      kind: Atom.to_string(op.kind),
      label: label(op, status, reason),
      status: status,
      reason: reason,
      height: Map.fetch!(heights, op.id),
      author: Identity.fingerprint(op.author)
    }
  end

  defp label(op, "quarantined", reason),
    do: "#{label(op, "honored", nil)} QUARANTINED(#{reason})"

  defp label(op, _status, _reason),
    do: "#{short(op.id)} #{op.kind} #{summary(op.body)}"

  # Row 309: every body is parsed by the one total reader before rendering, so
  # an admitted but ill-shaped field becomes a marker instead of a crash.
  defp summary(body), do: body |> AuthorityBody.parse() |> render()

  defp render({:genesis, _dview}), do: "genesis"
  defp render({:grant, dview}), do: "grant -> #{audience_fp(dview)}"

  defp render({:transfer, role, dview, tick}),
    do: "transfer #{role_text(role)} -> #{audience_fp(dview)} @t#{tick_text(tick)}"

  defp render({:succeed, role, _dview, {:witnessed, _certificate}}),
    do: "succeed #{role_text(role)} via witnessed recovery"

  defp render({:succeed, role, _dview, tick}),
    do: "succeed #{role_text(role)} @t#{tick_text(tick)}"

  defp render({:heartbeat, role, tick}), do: "heartbeat #{role_text(role)} @t#{tick_text(tick)}"
  # A shortened target that is not valid UTF-8 would leak raw bytes into the
  # label and break the JSON export; delegation ids are base64url text. Only the
  # shown prefix is checked, so a label that rendered before still renders.
  defp render({:revoke, {:ok, target}}) do
    shown = short(target)
    if String.valid?(shown), do: "revoke #{shown}", else: "revoke (malformed)"
  end

  defp render({:revoke, {:malformed, _target}}), do: "revoke (malformed)"
  defp render({:request, ref}), do: "request #{inspect(ref)}"
  defp render({:command, cmd, args}), do: "#{inspect(cmd)} #{truncate(inspect(args))}"
  defp render({:other, body}), do: truncate(inspect(body))

  defp audience_fp(%{audience: {:ok, pub}}), do: Identity.fingerprint(pub)
  defp audience_fp(_dview), do: "(malformed)"

  defp role_text({:name, raw, _text}), do: inspect(raw)
  defp role_text({:malformed, raw}), do: inspect(raw)

  defp tick_text({:tick, tick}), do: Integer.to_string(tick)
  defp tick_text({:malformed, tick}), do: truncate(inspect(tick))

  defp truncate(text) do
    if String.length(text) > @label_summary_width,
      do: String.slice(text, 0, @label_summary_width) <> "…",
      else: text
  end

  defp short(id) when is_binary(id), do: String.slice(id, 0, 8)

  # --- Mermaid helpers (mirrors Lattice.Graph.Export's id sanitization) ------

  defp mermaid_id(id) do
    id
    |> String.replace(~r/[^a-zA-Z0-9_]/, "_")
    |> then(&("n_" <> &1))
  end

  # Mermaid quoted labels cannot contain double quotes; single quotes are safe.
  defp mermaid_escape(label), do: String.replace(label, "\"", "'")
end
