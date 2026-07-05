defmodule Lattice.Carrier.SimNet do
  @moduledoc """
  `Lattice.Carrier` implemented over the simulated `Lattice.Net`.

  This is the conformance anchor for the carrier seam: the same
  `Lattice.Carrier.sync/3` driver that runs over a real transport runs here
  against an in-process peer log, gated by `Lattice.Net.connected?/3` exactly
  like `Lattice.Sim.sync/3` is. Every callback fails with `{:error,
  :partitioned}` while the simulated link is cut — the value-level analogue of
  "the socket is closed".

  The connection value owns the *peer's* log (everything in the simulator is a
  value); after a sync the caller reads it back with `peer_log/1`.
  """

  @behaviour Lattice.Carrier

  alias Lattice.{Log, Net, Sync}

  @enforce_keys [:net, :local_id, :peer_id, :peer_log]
  defstruct [:net, :local_id, :peer_id, :peer_log]

  @type t :: %__MODULE__{
          net: Net.t(),
          local_id: Net.realm(),
          peer_id: Net.realm(),
          peer_log: Log.t()
        }

  @doc "Build a simulated connection from `local_id` to the peer holding `peer_log`."
  @spec connect(Net.t(), Net.realm(), Net.realm(), Log.t()) :: t()
  def connect(%Net{} = net, local_id, peer_id, %Log{} = peer_log) do
    %__MODULE__{net: net, local_id: local_id, peer_id: peer_id, peer_log: peer_log}
  end

  @doc "The peer's log after any pushes applied through this connection."
  @spec peer_log(t()) :: Log.t()
  def peer_log(%__MODULE__{peer_log: peer_log}), do: peer_log

  @impl Lattice.Carrier
  def advertise(%__MODULE__{} = conn, %Log{} = _local_log) do
    with :ok <- gate(conn), do: {:ok, Log.op_ids(conn.peer_log), conn}
  end

  @impl Lattice.Carrier
  def pull(%__MODULE__{} = conn, %MapSet{} = have) do
    with :ok <- gate(conn), do: {:ok, Sync.missing(conn.peer_log, have), conn}
  end

  @impl Lattice.Carrier
  def push(%__MODULE__{} = conn, ops) when is_list(ops) do
    with :ok <- gate(conn) do
      {peer_log, report} = Sync.deliver(conn.peer_log, ops)
      {:ok, report, %{conn | peer_log: peer_log}}
    end
  end

  @impl Lattice.Carrier
  def live(%__MODULE__{} = conn, _payload) do
    # Ephemeral by construction: delivered (here: dropped) without touching a log.
    with :ok <- gate(conn), do: {:ok, conn}
  end

  defp gate(%__MODULE__{net: net, local_id: a, peer_id: b}) do
    if Net.connected?(net, a, b), do: :ok, else: {:error, :partitioned}
  end
end
