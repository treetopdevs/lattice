defmodule Lattice.Flagship do
  @moduledoc """
  Public server for the canonical live process/trust graph demo.

  The scenario itself is defined in `Lattice.Flagship.Scenario`; state transitions
  live in `Lattice.Flagship.Story`; snapshots live in `Lattice.Flagship.Snapshot`.
  This module keeps the GenServer boundary and public API small.
  """

  use GenServer
  import Bitwise

  alias Lattice.Flagship.{Claims, Scenario, Snapshot, Story}

  @action_ids Scenario.action_ids()

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, Story.initial_state(), name: __MODULE__)
  end

  def reset, do: call_action(:reset)
  def connect, do: call_action(:connect)
  def grant, do: call_action(:grant)
  def allowed, do: call_action(:allowed)
  def over_budget, do: call_action(:over_budget)
  def wrong_vendor, do: call_action(:wrong_vendor)
  def stolen, do: call_action(:stolen)
  def revoke, do: call_action(:revoke)
  def replay, do: call_action(:replay)
  def run_all, do: call_action(:run_all)
  def snapshot, do: GenServer.call(__MODULE__, :snapshot)
  def claims, do: Claims.all()
  def actions, do: Scenario.actions()
  def action_token, do: GenServer.call(__MODULE__, :action_token)
  def export(format), do: GenServer.call(__MODULE__, {:export, format})
  def valid_action_token?(token), do: GenServer.call(__MODULE__, {:valid_action_token?, token})

  def consume_action_token?(token),
    do: GenServer.call(__MODULE__, {:consume_action_token?, token})

  def perform(action_name) when is_binary(action_name) do
    with {:ok, action} <- Scenario.action_id(action_name) do
      call_action(action)
    end
  end

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call(action, _from, state) when action in @action_ids do
    state = Story.apply_action(action, state)
    {:reply, {:ok, Snapshot.build(state)}, state}
  end

  def handle_call(:snapshot, _from, state) do
    {:reply, Snapshot.build(state), state}
  end

  def handle_call(:action_token, _from, state) do
    {:reply, state.action_token, state}
  end

  def handle_call({:export, format}, _from, state) do
    snapshot = Snapshot.build(state)

    body =
      case format do
        "mermaid" -> Lattice.Graph.Export.export(snapshot.graph, :mermaid)
        "dot" -> Lattice.Graph.Export.export(snapshot.graph, :dot)
        "claims" -> Jason.encode!(Claims.all(), pretty: true)
        _ -> Jason.encode!(snapshot, pretty: true)
      end

    {:reply, {:ok, body}, state}
  end

  def handle_call({:valid_action_token?, token}, _from, state) do
    {:reply, secure_compare(token, state.action_token), state}
  end

  def handle_call({:consume_action_token?, token}, _from, state) do
    if secure_compare(token, state.action_token) do
      {:reply, true, %{state | action_token: Story.new_action_token()}}
    else
      {:reply, false, state}
    end
  end

  defp call_action(:run_all), do: GenServer.call(__MODULE__, :run_all, 10_000)
  defp call_action(action), do: GenServer.call(__MODULE__, action)

  defp secure_compare(left, right)
       when is_binary(left) and is_binary(right) and byte_size(left) == byte_size(right) do
    left
    |> :binary.bin_to_list()
    |> Enum.zip_reduce(:binary.bin_to_list(right), 0, fn a, b, acc -> bor(acc, bxor(a, b)) end)
    |> Kernel.==(0)
  end

  defp secure_compare(_left, _right), do: false
end
