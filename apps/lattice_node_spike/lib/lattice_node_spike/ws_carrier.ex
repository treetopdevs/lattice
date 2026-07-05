defmodule LatticeNodeSpike.WsCarrier do
  @moduledoc """
  `Lattice.Carrier` over a **real** WebSocket.

  The connection wraps `Lattice.Transport.WebSocket.Client` — a raw `:gen_tcp`
  client that performs the RFC 6455 handshake and framing against the peer OS
  process's Cowboy listener. Every callback is one JSON request/response round
  trip; ops travel as Base64 `:erlang.term_to_binary` (`LatticeNodeSpike.Wire`).

  `Lattice.Carrier.sync/3` drives this module and `Lattice.Carrier.SimNet`
  identically — that interchangeability is the seam the spike proves.
  """

  @behaviour Lattice.Carrier

  alias Lattice.Transport.WebSocket.Client
  alias LatticeNodeSpike.Wire

  @recv_timeout 10_000

  @enforce_keys [:client]
  defstruct [:client]

  @type t :: %__MODULE__{client: pid()}

  @doc "Open a WebSocket to the peer's `/carrier` endpoint."
  @spec connect(keyword()) :: {:ok, t()} | {:error, term()}
  def connect(opts) do
    opts = Keyword.put_new(opts, :path, "/carrier")
    with {:ok, client} <- Client.connect(opts), do: {:ok, %__MODULE__{client: client}}
  end

  @doc "Close the socket — the physical partition."
  @spec close(t()) :: :ok
  def close(%__MODULE__{client: client}), do: Client.close(client)

  @doc "Peer scenario phase (`base` | `diverged`), for heal coordination."
  @spec status(t()) :: {:ok, String.t()} | {:error, term()}
  def status(%__MODULE__{} = conn) do
    with {:ok, %{"type" => "status_result", "phase" => phase}} <-
           request(conn, %{type: "status"}) do
      {:ok, phase}
    end
  end

  @doc "Peer's reduced-state bytes + log facts for the byte-identity assertions."
  @spec state_report(t()) :: {:ok, map()} | {:error, term()}
  def state_report(%__MODULE__{} = conn) do
    with {:ok, %{"type" => "state_result"} = report} <- request(conn, %{type: "state"}) do
      {:ok, report}
    end
  end

  @doc "Graceful peer shutdown (the peer OS process halts after replying)."
  @spec shutdown(t()) :: {:ok, map()} | {:error, term()}
  def shutdown(%__MODULE__{} = conn), do: request(conn, %{type: "shutdown"})

  # --- Lattice.Carrier callbacks ---------------------------------------------

  @impl Lattice.Carrier
  def advertise(%__MODULE__{} = conn, _local_log) do
    with {:ok, %{"type" => "frontier_result", "ids" => ids}} <-
           request(conn, %{type: "frontier"}) do
      {:ok, MapSet.new(ids), conn}
    end
  end

  @impl Lattice.Carrier
  def pull(%__MODULE__{} = conn, %MapSet{} = have) do
    with {:ok, %{"type" => "ops", "ops" => encoded}} <-
           request(conn, %{type: "pull", have: Enum.sort(have)}),
         {:ok, ops} <- Wire.decode_all(encoded) do
      {:ok, ops, conn}
    end
  end

  @impl Lattice.Carrier
  def push(%__MODULE__{} = conn, ops) when is_list(ops) do
    encoded = Enum.map(ops, &Wire.encode/1)

    with {:ok, %{"type" => "push_result"} = result} <-
           request(conn, %{type: "push", ops: encoded}) do
      {:ok, decode_report(result), conn}
    end
  end

  @impl Lattice.Carrier
  def live(%__MODULE__{} = conn, payload) do
    with {:ok, %{"type" => "live_result"}} <-
           request(conn, %{type: "live", payload: payload}) do
      {:ok, conn}
    end
  end

  # --- Internals ---------------------------------------------------------------

  defp request(%__MODULE__{client: client}, msg) do
    with :ok <- Client.send_envelope(client, msg),
         {:ok, envelope} <- Client.recv_envelope(client, @recv_timeout) do
      case envelope do
        %{"type" => "error"} = err -> {:error, {:peer_error, Map.get(err, "reason")}}
        other -> {:ok, other}
      end
    end
  end

  defp decode_report(result) do
    %{
      accepted: Map.get(result, "accepted", []),
      quarantined: decode_reason_pairs(Map.get(result, "quarantined", [])),
      rejected: decode_reason_pairs(Map.get(result, "rejected", [])),
      pending: Map.get(result, "pending", [])
    }
  end

  # Reasons on the wire are strings; they map back onto the fixed set of atoms
  # `Lattice.Log.accept/2` emits (all of which exist in this VM already).
  defp decode_reason_pairs(pairs) do
    Enum.map(pairs, fn [id, reason] -> {id, String.to_existing_atom(reason)} end)
  end
end
