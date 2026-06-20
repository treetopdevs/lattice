defmodule Lattice do
  @moduledoc """
  Public facade for the Lattice POC.

  Lattice gives tabs zero implicit authority. A browser/tab realm can only call
  or cast through capabilities issued to that exact tab and validated by
  `Lattice.Gateway`.
  """

  alias Lattice.{Audit, Cap, CapStore, Gateway, Topology}

  def connect_tab(attrs), do: Topology.connect_tab(attrs)

  def disconnect_tab(tab_id) do
    with {:ok, closed_tab} <- Topology.disconnect_tab(tab_id),
         :ok <- CapStore.revoke_tab(tab_id, :normal) do
      {:ok, closed_tab}
    end
  end

  def eject(tab_id, reason) do
    with {:ok, closed_tab} <- Topology.eject(tab_id, reason),
         :ok <- CapStore.revoke_tab(tab_id, reason) do
      {:ok, closed_tab}
    end
  end

  def grant(tab_id, target, ops, opts \\ []) do
    CapStore.grant(tab_id, normalize_target(target), ops, opts)
  end

  def delegate(parent_cap_or_id, to_tab_id, opts \\ [])

  def delegate(from_tab_id, parent_cap_or_id, to_tab_id)
      when is_binary(from_tab_id) and is_binary(to_tab_id) do
    delegate(from_tab_id, parent_cap_or_id, to_tab_id, [])
  end

  def delegate(%Cap{owner_tab_id: owner_tab_id} = parent_cap, to_tab_id, opts)
      when is_list(opts) do
    delegate(owner_tab_id, parent_cap, to_tab_id, opts)
  end

  def delegate(parent_cap_or_id, to_tab_id, opts) when is_list(opts) do
    case Keyword.fetch(opts, :from_tab_id) do
      {:ok, from_tab_id} ->
        opts = Keyword.delete(opts, :from_tab_id)
        delegate(from_tab_id, parent_cap_or_id, to_tab_id, opts)

      :error ->
        CapStore.delegate(nil, parent_cap_or_id, to_tab_id, opts)
    end
  end

  def delegate(from_tab_id, parent_cap_or_id, to_tab_id, opts) when is_binary(from_tab_id) do
    opts =
      case Keyword.fetch(opts, :target) do
        {:ok, target} -> Keyword.put(opts, :target, normalize_target(target))
        :error -> opts
      end

    CapStore.delegate(from_tab_id, parent_cap_or_id, to_tab_id, opts)
  end

  def revoke(cap_or_id, reason \\ :manual), do: CapStore.revoke(cap_or_id, reason)
  def call(tab_id, cap_or_id, payload), do: Gateway.call(tab_id, cap_or_id, payload)
  def cast(tab_id, cap_or_id, payload), do: Gateway.cast(tab_id, cap_or_id, payload)

  def spawn_linked(tab_id, module, args, opts \\ []) do
    child_spec = %{
      id: {module, make_ref()},
      start: {module, :start_link, [tab_id, args, opts]},
      restart: :temporary
    }

    with true <- Topology.tab_connected?(tab_id) || {:error, :tab_not_connected},
         {:ok, pid} <- DynamicSupervisor.start_child(Lattice.TabWorkerSupervisor, child_spec),
         :ok <- Topology.register_worker(tab_id, pid) do
      {:ok, pid}
    end
  end

  def bridge(from_tab_id, to_tab_id, opts) when is_list(opts) do
    ops = Keyword.get(opts, :ops, [:call])
    bridge(from_tab_id, to_tab_id, ops, opts)
  end

  def bridge(from_tab_id, to_tab_id, ops, opts) do
    target = {:tab, to_tab_id}

    with {:ok, cap} <- grant(from_tab_id, target, ops, opts),
         {:ok, _bridge} <- Topology.create_bridge(from_tab_id, to_tab_id, cap) do
      {:ok, cap}
    end
  end

  def audit_events, do: Audit.events()

  def diagnostics do
    %{
      topology: Topology.snapshot(),
      caps: CapStore.snapshot(),
      audit_count: length(Audit.events())
    }
  end

  def reset! do
    Lattice.IFC.reset()
    Lattice.Graph.Annotations.reset()
    Lattice.LiveOps.reset()
    Topology.reset()
    CapStore.reset()
    Audit.reset()
    Lattice.Clock.reset()
    Lattice.Registry.reset()
  end

  def external_cap(%Cap{} = cap), do: Cap.external(cap)

  # ===================================================================
  # Lattice 2.0 — Replicas on a capability-attested log.
  #
  # The v1 facade (connect_tab/grant/call/... above) is preserved. The 2.0 model
  # lives in `Lattice.{Op,Log,Sync,Net,Clock,Crdt,Authority,Replica,Reduce,
  # Registry,Materializer,Promise,Live,Sim}`. Functions whose v1 names/arities
  # would collide (`call/3`, `grant/4`) are reached through `Lattice.Registry`
  # and the in-log delegation ops; the rest are surfaced here. Nothing assumes
  # in-process locality — realms are addressed by id, so `Lattice.Net` can be
  # swapped for a real carrier (see docs/path_to_real.md).
  # ===================================================================

  @doc "Materialize a replica on a realm (live process); returns `{:ok, state}`."
  def materialize(realm, replica), do: Lattice.Registry.materialize(realm, replica)

  @doc "Send a realm's materialization dormant (its log persists)."
  def go_dormant(realm, replica), do: Lattice.Registry.go_dormant(realm, replica)

  @doc "Permanently tombstone a replica (an op; blocks rematerialization everywhere)."
  def tombstone(realm, replica), do: Lattice.Registry.tombstone(realm, replica)

  @doc "Subscribe the calling process to a materialization's lifecycle + messages."
  def monitor(realm, replica), do: Lattice.Registry.monitor(realm, replica, self())

  @doc "Durably send `payload` between realms; delivered on the target's next materialization."
  def send_durable(from_realm, {to_realm, replica}, payload),
    do: Lattice.Registry.deliver(from_realm, to_realm, replica, payload)

  @doc "Await a durable promise from `realm`'s log: `{:ok, result}` or `:pending`."
  def await(realm, %Lattice.Promise{replica: replica} = promise),
    do: Lattice.Registry.await(realm, replica, promise)

  @doc """
  Reproduce historical state as of a causal `frontier` (a list of op ids), applying
  the authority quarantine that held within that causal slice. Behavior 17.
  """
  def state_at(module, %Lattice.Log{} = log, frontier) do
    reachable = Lattice.Dag.reachable(Lattice.Log.ops(log), List.wrap(frontier))
    sub_ops = Map.take(Lattice.Log.ops(log), MapSet.to_list(reachable))
    sub_log = Lattice.Log.from_ops(log.replica, sub_ops)
    quarantine = Lattice.Authority.quarantine(module, sub_log)
    Lattice.Reduce.reduce(module, sub_log, quarantine: quarantine)
  end

  def normalize_target({:tab, tab_id}) when is_binary(tab_id), do: {:tab, tab_id}
  def normalize_target({:server, pid}) when is_pid(pid), do: {:server_pid, pid}
  def normalize_target({:server, name}) when is_atom(name), do: {:server_name, name}
  def normalize_target(pid) when is_pid(pid), do: {:server_pid, pid}
  def normalize_target(name) when is_atom(name), do: {:server_name, name}
end
