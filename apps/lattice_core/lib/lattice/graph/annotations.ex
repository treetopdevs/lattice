defmodule Lattice.Graph.Annotations do
  @moduledoc """
  Small registry for demo/research graph nodes that are not discoverable from
  CapStore or Topology alone.

  The authority path still lives in `Lattice.Gateway`. This registry only makes
  explanatory actors, such as a flagship wallet process, visible in snapshots.
  """

  use GenServer

  @known_keys %{
    "id" => :id,
    "kind" => :kind,
    "label" => :label,
    "realm" => :realm,
    "lifecycle_state" => :lifecycle_state,
    "pid" => :pid,
    "from" => :from,
    "to" => :to,
    "status" => :status,
    "reason" => :reason,
    "audit_event_id" => :audit_event_id,
    "audit_event_ids" => :audit_event_ids,
    "cap_id" => :cap_id
  }

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{nodes: %{}, edges: []}, name: __MODULE__)
  end

  def register_node(node) when is_map(node) do
    GenServer.call(__MODULE__, {:register_node, normalize(node)})
  end

  def register_edge(edge) when is_map(edge) do
    GenServer.call(__MODULE__, {:register_edge, normalize(edge)})
  end

  def snapshot, do: GenServer.call(__MODULE__, :snapshot)
  def reset, do: GenServer.call(__MODULE__, :reset)

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call({:register_node, %{id: id} = node}, _from, state) do
    {:reply, :ok, put_in(state, [:nodes, id], node)}
  end

  def handle_call({:register_edge, edge}, _from, state) do
    {:reply, :ok, update_in(state.edges, &dedupe_edge([edge | &1]))}
  end

  def handle_call(:snapshot, _from, state) do
    {:reply, %{nodes: Map.values(state.nodes), edges: Enum.reverse(state.edges)}, state}
  end

  def handle_call(:reset, _from, _state), do: {:reply, :ok, %{nodes: %{}, edges: []}}

  defp dedupe_edge(edges) do
    Enum.uniq_by(edges, fn edge ->
      {edge.from, edge.to, edge.kind, edge[:audit_event_id]}
    end)
  end

  defp normalize(map) do
    Map.new(map, fn
      {key, value} when is_binary(key) -> {Map.get(@known_keys, key, key), normalize_value(value)}
      {key, value} -> {key, normalize_value(value)}
    end)
  end

  defp normalize_value(value) when is_map(value), do: normalize(value)
  defp normalize_value(value) when is_list(value), do: Enum.map(value, &normalize_value/1)
  defp normalize_value(value), do: value
end
