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

  def encode!(payload) when is_map(payload) do
    case validate(payload) do
      :ok -> Jason.encode!(payload)
      {:error, reason} -> raise ArgumentError, "invalid Township replay payload: #{reason}"
    end
  end

  def encode!(_invalid) do
    raise ArgumentError, "invalid Township replay payload"
  end

  @doc "Validate the complete cross-runtime replay contract."
  @spec validate(term()) :: :ok | {:error, String.t()}
  def validate(%{
        "schema" => @schema,
        "nodes" => nodes,
        "edges" => edges,
        "frames" => frames,
        "fields" => fields
      })
      when is_list(nodes) and is_list(edges) and is_list(frames) and is_list(fields) do
    with :ok <- nonempty_frames(frames),
         {:ok, node_ids} <- validate_nodes(nodes),
         :ok <- validate_edges(edges, node_ids),
         :ok <- validate_fields(fields, node_ids),
         :ok <- validate_frames(frames, node_ids) do
      :ok
    end
  end

  def validate(%{"schema" => schema}) when schema != @schema,
    do: {:error, "unsupported schema #{inspect(schema)}"}

  def validate(_payload), do: {:error, "top-level contract mismatch"}

  defp nonempty_frames([]), do: {:error, "frames must not be empty"}
  defp nonempty_frames(_frames), do: :ok

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

  defp validate_nodes(nodes) do
    nodes
    |> Enum.with_index()
    |> Enum.reduce_while({:ok, MapSet.new()}, fn {node, index}, {:ok, ids} ->
      with %{
             "id" => id,
             "label" => label,
             "author" => author,
             "kind" => kind,
             "height" => height,
             "field" => field
           } <- node,
           true <- is_binary(id),
           true <- is_binary(label),
           true <- is_binary(author),
           true <- is_binary(kind),
           true <- is_integer(height) and height >= 0,
           true <- is_nil(field) or is_binary(field),
           false <- MapSet.member?(ids, id) do
        {:cont, {:ok, MapSet.put(ids, id)}}
      else
        true -> {:halt, {:error, "duplicate node id #{inspect(node["id"])}"}}
        _invalid -> {:halt, {:error, "node #{index} contract mismatch"}}
      end
    end)
  end

  defp validate_edges(edges, node_ids) do
    edges
    |> Enum.with_index()
    |> Enum.reduce_while(:ok, fn
      {%{"from" => from, "to" => to}, index}, :ok
      when is_binary(from) and is_binary(to) ->
        with :ok <- known_node(node_ids, from, "edge #{index} from"),
             :ok <- known_node(node_ids, to, "edge #{index} to") do
          {:cont, :ok}
        else
          {:error, _reason} = error -> {:halt, error}
        end

      {_edge, index}, :ok ->
        {:halt, {:error, "edge #{index} contract mismatch"}}
    end)
  end

  defp validate_fields(fields, node_ids) do
    fields
    |> Enum.with_index()
    |> Enum.reduce_while({:ok, MapSet.new()}, fn {field, index}, {:ok, field_ids} ->
      with %{"id" => id, "label" => label, "writers" => writers} <- field,
           true <- is_binary(id) and is_binary(label),
           :ok <- string_list(writers, "field #{index} writers"),
           false <- MapSet.member?(field_ids, id),
           :ok <- known_nodes(node_ids, writers, "field #{index} writers") do
        {:cont, {:ok, MapSet.put(field_ids, id)}}
      else
        true -> {:halt, {:error, "duplicate field id #{inspect(field["id"])}"}}
        {:error, _reason} = error -> {:halt, error}
        _invalid -> {:halt, {:error, "field #{index} contract mismatch"}}
      end
    end)
    |> case do
      {:ok, _field_ids} -> :ok
      {:error, _reason} = error -> error
    end
  end

  defp validate_frames(frames, node_ids) do
    frames
    |> Enum.with_index()
    |> Enum.reduce_while(:ok, fn {frame, index}, :ok ->
      case validate_frame(frame, index, node_ids) do
        :ok -> {:cont, :ok}
        {:error, _reason} = error -> {:halt, error}
      end
    end)
  end

  defp validate_frame(frame, index, node_ids) do
    with %{
           "index" => ^index,
           "head" => head,
           "visible_ids" => visible_ids,
           "frontier" => frontier,
           "state" => state,
           "holders" => holders,
           "quarantine" => quarantine
         } <- frame,
         true <- is_binary(head),
         :ok <- string_list(visible_ids, "frame #{index} visible_ids"),
         :ok <- string_list(frontier, "frame #{index} frontier"),
         :ok <- known_node(node_ids, head, "frame #{index} head"),
         :ok <- known_nodes(node_ids, visible_ids, "frame #{index} visible_ids"),
         true <- head in visible_ids || {:error, "frame #{index} head #{head} must be visible"},
         :ok <- known_nodes(node_ids, frontier, "frame #{index} frontier"),
         :ok <- validate_state(state, index),
         :ok <- validate_holders(holders, index),
         :ok <- validate_quarantine(quarantine, index, node_ids) do
      :ok
    else
      {:error, _reason} = error -> error
      _invalid -> {:error, "frame #{index} contract mismatch"}
    end
  end

  defp validate_state(
         %{
           "title" => title,
           "summary" => summary,
           "posts" => posts,
           "members" => members,
           "clerk_locked" => clerk_locked
         },
         index
       )
       when is_binary(title) and is_binary(summary) and is_boolean(clerk_locked) do
    with :ok <- string_list(posts, "frame #{index} state posts"),
         :ok <- string_list(members, "frame #{index} state members"),
         do: :ok
  end

  defp validate_state(_state, index), do: {:error, "frame #{index} state contract mismatch"}

  defp validate_holders(holders, index) when is_map(holders) do
    if Enum.all?(holders, fn {role, holder} ->
         is_binary(role) and (is_nil(holder) or is_binary(holder))
       end),
       do: :ok,
       else: {:error, "frame #{index} holders contract mismatch"}
  end

  defp validate_holders(_holders, index),
    do: {:error, "frame #{index} holders contract mismatch"}

  defp validate_quarantine(quarantine, index, node_ids) when is_map(quarantine) do
    quarantine
    |> Enum.reduce_while(:ok, fn
      {id, reason}, :ok when is_binary(id) and is_binary(reason) ->
        case known_node(node_ids, id, "frame #{index} quarantine") do
          :ok -> {:cont, :ok}
          {:error, _reason} = error -> {:halt, error}
        end

      _entry, :ok ->
        {:halt, {:error, "frame #{index} quarantine contract mismatch"}}
    end)
  end

  defp validate_quarantine(_quarantine, index, _node_ids),
    do: {:error, "frame #{index} quarantine contract mismatch"}

  defp string_list(values, _label) when is_list(values) do
    if Enum.all?(values, &is_binary/1), do: :ok, else: {:error, "list items must be strings"}
  end

  defp string_list(_values, label), do: {:error, "#{label} must be a list of strings"}

  defp known_nodes(node_ids, ids, label) do
    case Enum.find(ids, &(not MapSet.member?(node_ids, &1))) do
      nil -> :ok
      id -> {:error, "#{label} references unknown node #{id}"}
    end
  end

  defp known_node(node_ids, id, label) do
    if MapSet.member?(node_ids, id),
      do: :ok,
      else: {:error, "#{label} references unknown node #{id}"}
  end
end
