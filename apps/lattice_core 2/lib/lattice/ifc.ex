defmodule Lattice.IFC do
  @moduledoc """
  Dynamic information-flow-control prototype.

  Labels are runtime metadata, not a type-system proof. `transfer/4` records
  allowed and denied attempts so tests, demos, and graph policy can inspect the
  flow lattice.
  """

  use GenServer

  @labels [:public, :internal, :confidential, :secret]

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{labels: %{}, flows: []}, name: __MODULE__)
  end

  def label(subject, label) when label in @labels do
    GenServer.call(__MODULE__, {:label, subject_id(subject), label})
  end

  def transfer(from, to, payload, opts \\ []) do
    GenServer.call(__MODULE__, {:transfer, subject_id(from), subject_id(to), payload, opts})
  end

  def snapshot, do: GenServer.call(__MODULE__, :snapshot)
  def reset, do: GenServer.call(__MODULE__, :reset)

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call({:label, subject, label}, _from, state) do
    {:reply, :ok, put_in(state, [:labels, subject], label)}
  end

  def handle_call({:transfer, from, to, payload, opts}, _from, state) do
    from_label = Keyword.get(opts, :from_label) || Map.get(state.labels, from, :public)
    to_label = Keyword.get(opts, :to_label) || Map.get(state.labels, to, :public)
    payload_label = Keyword.get(opts, :label, from_label)
    allowed? = allowed?(payload_label, to_label)

    flow = %{
      id: length(state.flows) + 1,
      from: from,
      to: to,
      from_label: from_label,
      to_label: to_label,
      payload_label: payload_label,
      allowed?: allowed?,
      at: System.monotonic_time(:millisecond)
    }

    state = update_in(state.flows, &(&1 ++ [flow]))

    if allowed? do
      Lattice.Audit.record(:ifc_flow, Map.take(flow, [:from, :to, :payload_label, :to_label]))
      {:reply, {:ok, payload}, state}
    else
      Lattice.Audit.record(:ifc_deny, Map.take(flow, [:from, :to, :payload_label, :to_label]))
      {:reply, {:error, :ifc_violation}, state}
    end
  end

  def handle_call(:snapshot, _from, state), do: {:reply, state, state}
  def handle_call(:reset, _from, _state), do: {:reply, :ok, %{labels: %{}, flows: []}}

  def allowed?(source_label, target_label), do: rank(source_label) <= rank(target_label)
  def labels, do: @labels

  defp rank(label), do: Enum.find_index(@labels, &(&1 == label)) || 0

  defp subject_id(pid) when is_pid(pid), do: inspect(pid)
  defp subject_id(value) when is_binary(value), do: value
  defp subject_id(value) when is_atom(value), do: Atom.to_string(value)
  defp subject_id(%{id: id}), do: id
  defp subject_id(value), do: inspect(value)
end
