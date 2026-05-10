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

  def delegate(parent_cap_or_id, to_tab_id, opts \\ []) do
    opts =
      case Keyword.fetch(opts, :target) do
        {:ok, target} -> Keyword.put(opts, :target, normalize_target(target))
        :error -> opts
      end

    CapStore.delegate(parent_cap_or_id, to_tab_id, opts)
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
    Topology.reset()
    CapStore.reset()
    Audit.reset()
  end

  def external_cap(%Cap{} = cap), do: Cap.external(cap)

  def normalize_target({:tab, tab_id}) when is_binary(tab_id), do: {:tab, tab_id}
  def normalize_target({:server, pid}) when is_pid(pid), do: {:server_pid, pid}
  def normalize_target({:server, name}) when is_atom(name), do: {:server_name, name}
  def normalize_target(pid) when is_pid(pid), do: {:server_pid, pid}
  def normalize_target(name) when is_atom(name), do: {:server_name, name}
end
