defmodule LatticeNodeSpike.Peer do
  @moduledoc """
  Holds one realm's `Lattice.Log` inside the peer OS process.

  The peer starts holding only the deterministic shared prefix
  (`Scenario.base_sim/0`). When the first WebSocket connection *closes* — the
  physical partition — it authors its offline commands (`Scenario.diverge/2`),
  so divergence happens strictly while no socket exists. All op application
  goes through `Lattice.Sync.deliver/2`, i.e. the same `Lattice.Log.accept/2`
  path as everywhere else; live payloads never touch the log.
  """

  use GenServer

  alias Lattice.{Log, Sync}
  alias LatticeNodeSpike.Scenario

  # --- Client API (called from the WebSocket handler) -----------------------

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc "Sorted list of all op ids in the peer's log (the POC frontier advert)."
  def op_ids(peer), do: GenServer.call(peer, :op_ids)

  @doc "Ops the peer holds that a caller with `have_ids` lacks, in causal order."
  def missing_for(peer, have_ids), do: GenServer.call(peer, {:missing_for, have_ids})

  @doc "Apply pushed ops through `Lattice.Sync.deliver/2`; returns the report."
  def deliver(peer, ops), do: GenServer.call(peer, {:deliver, ops})

  @doc "Accept an ephemeral payload. Never logged; returns the (unchanged) log size."
  def live(peer, payload), do: GenServer.call(peer, {:live, payload})

  @doc "Current phase: `:base` (pre-partition) or `:diverged`."
  def status(peer), do: GenServer.call(peer, :status)

  @doc "Reduced-state bytes + log facts for the byte-identity assertions."
  def state_report(peer), do: GenServer.call(peer, :state_report)

  @doc "Socket closed: author the offline commands (once)."
  def socket_closed(peer), do: GenServer.cast(peer, :socket_closed)

  # --- GenServer -------------------------------------------------------------

  @impl GenServer
  def init(opts) do
    realm = Keyword.fetch!(opts, :realm)
    {:ok, %{realm: realm, sim: Scenario.base_sim(), phase: :base, live_seen: 0}}
  end

  @impl GenServer
  def handle_call(:op_ids, _from, state) do
    {:reply, state |> log() |> Log.op_ids() |> Enum.sort(), state}
  end

  def handle_call({:missing_for, have_ids}, _from, state) do
    {:reply, Sync.missing(log(state), MapSet.new(have_ids)), state}
  end

  def handle_call({:deliver, ops}, _from, state) do
    {new_log, report} = Sync.deliver(log(state), ops)
    {:reply, report, put_log(state, new_log)}
  end

  def handle_call({:live, _payload}, _from, state) do
    state = %{state | live_seen: state.live_seen + 1}
    {:reply, %{live_seen: state.live_seen, log_size: Log.size(log(state))}, state}
  end

  def handle_call(:status, _from, state) do
    {:reply, state.phase, state}
  end

  def handle_call(:state_report, _from, state) do
    log = log(state)

    report = %{
      state_b64: log |> Scenario.state_bytes() |> Base.encode64(),
      op_ids: log |> Log.op_ids() |> Enum.sort(),
      frontier: Log.frontier(log),
      structural_quarantine:
        Enum.map(Log.quarantine(log), fn %{op: op, reason: reason} ->
          [op.id, Atom.to_string(reason)]
        end),
      log_size: Log.size(log)
    }

    {:reply, report, state}
  end

  @impl GenServer
  def handle_cast(:socket_closed, %{phase: :base} = state) do
    {:noreply, %{state | sim: Scenario.diverge(state.sim, state.realm), phase: :diverged}}
  end

  def handle_cast(:socket_closed, state), do: {:noreply, state}

  defp log(%{sim: sim, realm: realm}), do: Lattice.Sim.log(sim, realm)

  defp put_log(%{sim: sim, realm: realm} = state, new_log) do
    %{state | sim: %{sim | logs: Map.put(sim.logs, realm, new_log)}}
  end
end
