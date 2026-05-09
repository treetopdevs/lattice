defmodule Lattice.Tab do
  @moduledoc """
  One browser-like realm connected to Lattice.

  Tabs carry identity and lifecycle state, but not ambient authority. Each tab
  has its own session id, capability ids, and owned worker pids.
  """

  alias Lattice.Realm

  @enforce_keys [
    :id,
    :session_id,
    :realm,
    :connection_pid,
    :connection_ref,
    :state,
    :connected_at
  ]
  defstruct [
    :id,
    :session_id,
    :identity,
    :realm,
    :transport,
    :connection_pid,
    :connection_ref,
    issued_caps: MapSet.new(),
    owned_workers: MapSet.new(),
    state: :connected,
    connected_at: nil,
    disconnected_at: nil,
    metadata: %{}
  ]

  @type t :: %__MODULE__{
          id: String.t(),
          session_id: String.t(),
          identity: map(),
          realm: Realm.t(),
          transport: module(),
          connection_pid: pid(),
          connection_ref: reference(),
          issued_caps: MapSet.t(String.t()),
          owned_workers: MapSet.t(pid()),
          state: :connected | :disconnected | :ejected,
          connected_at: integer(),
          disconnected_at: integer() | nil,
          metadata: map()
        }

  def new(attrs) when is_map(attrs) do
    realm = Realm.tab(attrs)
    connection_pid = Map.fetch!(attrs, :connection_pid)

    %__MODULE__{
      id: realm.id,
      session_id: realm.session_id,
      identity: Map.get(attrs, :identity, %{}),
      realm: realm,
      transport: Map.fetch!(attrs, :transport),
      connection_pid: connection_pid,
      connection_ref: Process.monitor(connection_pid),
      state: :connected,
      connected_at: realm.connected_at,
      metadata: realm.metadata
    }
  end

  def put_cap(%__MODULE__{} = tab, cap_id) do
    %{tab | issued_caps: MapSet.put(tab.issued_caps, cap_id)}
  end

  def put_worker(%__MODULE__{} = tab, pid) when is_pid(pid) do
    %{tab | owned_workers: MapSet.put(tab.owned_workers, pid)}
  end

  def remove_worker(%__MODULE__{} = tab, pid) when is_pid(pid) do
    %{tab | owned_workers: MapSet.delete(tab.owned_workers, pid)}
  end

  def close(%__MODULE__{} = tab, state) when state in [:disconnected, :ejected] do
    now = System.monotonic_time(:millisecond)
    Process.demonitor(tab.connection_ref, [:flush])

    %{
      tab
      | state: state,
        disconnected_at: now,
        realm: %{tab.realm | state: state, disconnected_at: now}
    }
  end
end
