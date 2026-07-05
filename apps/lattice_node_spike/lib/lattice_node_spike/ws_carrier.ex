defmodule LatticeNodeSpike.WsCarrier do
  @moduledoc """
  `Lattice.Carrier` over a **real** WebSocket.

  The connection wraps `Lattice.Transport.WebSocket.Client` — a raw `:gen_tcp`
  client that performs the RFC 6455 handshake and framing against the peer OS
  process's Cowboy listener. Connection setup starts with a signed
  challenge/response. Every sync callback after that is one JSON
  request/response round trip; ops travel through the shared JSON-safe carrier
  wire frame shape.

  `Lattice.Carrier.sync/3` drives this module and `Lattice.Carrier.SimNet`
  identically — that interchangeability is the seam the spike proves.
  """

  @behaviour Lattice.Carrier

  alias Lattice.Carrier.{Session, Wire}
  alias Lattice.Transport.WebSocket.Client
  alias LatticeNodeSpike.Scenario
  alias LatticeNodeSpike.Wire, as: NodeWire

  @recv_timeout 10_000

  @enforce_keys [:client]
  defstruct [:client]

  @type t :: %__MODULE__{client: pid()}

  @doc "Open a WebSocket to the peer's `/carrier` endpoint."
  @spec connect(keyword()) :: {:ok, t()} | {:error, term()}
  def connect(opts) do
    opts = Keyword.put_new(opts, :path, "/carrier")

    with {:ok, client} <- Client.connect(opts) do
      conn = %__MODULE__{client: client}

      case authenticate(conn, opts) do
        :ok ->
          {:ok, conn}

        {:error, _reason} = error ->
          _ = Client.close(client)
          error
      end
    end
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
         {:ok, ops} <- NodeWire.decode_all(encoded) do
      {:ok, ops, conn}
    end
  end

  @impl Lattice.Carrier
  def push(%__MODULE__{} = conn, ops) when is_list(ops) do
    encoded = Enum.map(ops, &NodeWire.encode/1)

    with {:ok, %{"type" => "push_result"} = result} <-
           request(conn, %{type: "push", ops: encoded}) do
      {:ok, Wire.decode_report(result), conn}
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

  defp authenticate(%__MODULE__{} = conn, opts) do
    identity =
      Keyword.get_lazy(opts, :identity, fn ->
        peer_identity(Keyword.get(opts, :realm, "node_b"))
      end)

    realm = Keyword.get(opts, :realm, identity.realm_id)
    peer_realm = Keyword.get(opts, :peer_realm, "node_a")
    replica = Keyword.get(opts, :replica, Scenario.replica())
    peer_pubkey = Keyword.get_lazy(opts, :peer_pubkey, fn -> peer_identity(peer_realm).pub end)

    challenge = Session.challenge(realm, replica, wire_version: Wire.version())

    with {:ok, %{"type" => "carrier_hello"} = response} <- request(conn, challenge) do
      Session.verify_response(challenge, response,
        expected_realm: peer_realm,
        expected_pubkey: peer_pubkey
      )
    end
  end

  defp peer_identity(realm), do: Lattice.Identity.from_seed(realm, "carrier-spike")

  defp request(%__MODULE__{client: client}, msg) do
    with :ok <- Client.send_envelope(client, msg),
         {:ok, envelope} <- Client.recv_envelope(client, @recv_timeout) do
      case envelope do
        %{"type" => "error"} = err -> {:error, {:peer_error, Map.get(err, "reason")}}
        other -> {:ok, other}
      end
    end
  end
end
