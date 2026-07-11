defmodule Township.ReplayPayload do
  @moduledoc """
  Versioned, JSON-safe causal replay contract for a Township matter log.

  The payload contains server-derived order, visibility, state, authority
  verdicts, and field attribution. Consumers may normalize its shape for local
  rendering, but never infer those facts independently.
  """

  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Graph.ReplicaSnapshot
  alias Township.Matter

  @schema "township-causal-replay-v1"
  @fields [
    {"title", "Title"},
    {"summary", "Summary"},
    {"posts", "Deliberation"},
    {"members", "Members"},
    {"clerk_locked", "Clerk locked"}
  ]

  @type payload :: %{
          required(String.t()) => term()
        }

  @doc "Current replay payload schema identifier."
  @spec schema() :: String.t()
  def schema, do: @schema

  @doc "Build the replay payload from one authoritative matter log."
  @spec build(Log.t()) :: payload()
  def build(%Log{} = log) do
    ordered_ops = Log.topo_ops(log)
    graph = ReplicaSnapshot.build(Matter, log)

    %{
      "schema" => @schema,
      "nodes" => replay_nodes(graph.nodes, log),
      "edges" => Enum.map(graph.edges, &stringify_keys/1),
      "frames" => replay_frames(log, ordered_ops),
      "fields" => replay_fields(ordered_ops)
    }
  end

  @doc "Encode a valid replay payload, or build and encode one from a log."
  @spec encode!(payload() | Log.t()) :: String.t()
  def encode!(%Log{} = log), do: log |> build() |> encode!()

  def encode!(
        %{
          "schema" => @schema,
          "nodes" => nodes,
          "edges" => edges,
          "frames" => frames,
          "fields" => fields
        } = payload
      )
      when is_list(nodes) and is_list(edges) and is_list(frames) and is_list(fields) do
    Jason.encode!(payload)
  end

  def encode!(_invalid) do
    raise ArgumentError, "invalid Township replay payload"
  end

  defp replay_nodes(nodes, log) do
    Enum.map(nodes, fn node ->
      {:ok, op} = Log.fetch(log, node.id)

      node
      |> Map.put(:field, operation_field(op))
      |> stringify_keys()
    end)
  end

  defp replay_frames(log, ordered_ops) do
    ordered_ops
    |> Enum.with_index()
    |> Enum.map(fn {head, index} ->
      prefix = Enum.take(ordered_ops, index + 1)
      sub_log = Log.from_ops(log.replica, Map.new(prefix, &{&1.id, &1}))
      frontier = Log.frontier(sub_log)
      analysis = Authority.analyze(Matter, sub_log)

      %{
        "index" => index,
        "head" => head.id,
        "visible_ids" => sub_log |> Log.op_ids() |> Enum.sort(),
        "frontier" => frontier,
        "state" => Matter |> Lattice.state_at(log, frontier) |> state_view(),
        "holders" => json_holders(analysis.holders),
        "quarantine" => json_reasons(analysis.reasons)
      }
    end)
  end

  defp replay_fields(ordered_ops) do
    writers =
      Enum.reduce(ordered_ops, %{}, fn op, acc ->
        case operation_field(op) do
          nil -> acc
          field -> Map.update(acc, field, [op.id], &(&1 ++ [op.id]))
        end
      end)

    Enum.map(@fields, fn {id, label} ->
      %{"id" => id, "label" => label, "writers" => Map.get(writers, id, [])}
    end)
  end

  defp operation_field(%Op{kind: :command, body: {command, args}}) when is_list(args) do
    case Matter.__apply_command__(command, args) |> Enum.map(&elem(&1, 0)) |> Enum.uniq() do
      [field] -> replay_field_id(field)
      _other -> nil
    end
  rescue
    ArgumentError -> nil
  end

  defp operation_field(%Op{}), do: nil

  defp replay_field_id(field) do
    field
    |> Atom.to_string()
    |> String.trim_trailing("?")
  end

  defp state_view(state) do
    %{
      "title" => state.title,
      "summary" => state.summary,
      "posts" => state.posts,
      "members" => Enum.sort(state.members),
      "clerk_locked" => state.clerk_locked?
    }
  end

  defp json_holders(holders) do
    Map.new(holders, fn {role, pubkey} ->
      {Atom.to_string(role), pubkey && Identity.fingerprint(pubkey)}
    end)
  end

  defp json_reasons(reasons) do
    Map.new(reasons, fn {id, reason} -> {id, Atom.to_string(reason)} end)
  end

  defp stringify_keys(map) do
    Map.new(map, fn {key, value} -> {Atom.to_string(key), value} end)
  end
end
