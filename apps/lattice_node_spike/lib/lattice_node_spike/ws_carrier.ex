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

  alias Lattice.Carrier.{Batch, Session, Wire}
  alias Lattice.Transport.WebSocket.Client
  alias LatticeNodeSpike.Wire, as: NodeWire

  @recv_timeout 10_000

  @enforce_keys [:client]
  defstruct [:client, last_push_batches: []]

  @type t :: %__MODULE__{client: pid(), last_push_batches: [map()]}

  @doc "Open a WebSocket to the peer's `/carrier` endpoint."
  @spec connect(keyword()) :: {:ok, t()} | {:error, term()}
  def connect(opts) do
    opts = Keyword.put_new(opts, :path, "/carrier")

    with {:ok, session} <- session_opts(opts),
         {:ok, client} <- Client.connect(opts) do
      conn = %__MODULE__{client: client}

      case authenticate(conn, session) do
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

  @doc "Metadata for the most recent push batches: count and encoded frame bytes."
  @spec last_push_batches(t()) :: [%{count: non_neg_integer(), bytes: non_neg_integer()}]
  def last_push_batches(%__MODULE__{last_push_batches: batches}), do: batches

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
    entries = Enum.map(ops, &encode_entry/1)

    case Batch.chunk(entries,
           max_ops: 64,
           max_bytes: 64_000,
           size_fun: fn {_encoded, bytes} -> bytes end
         ) do
      {:ok, batches} ->
        case push_batches(conn, batches, [], []) do
          {:ok, reports, batch_meta} ->
            {:ok, Batch.merge_reports(reports), %{conn | last_push_batches: batch_meta}}

          {:error, _reason} = error ->
            error
        end

      {:error, _reason} = error ->
        error
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

  defp push_batches(_conn, [], reports, batch_meta) do
    {:ok, Enum.reverse(reports), Enum.reverse(batch_meta)}
  end

  defp push_batches(conn, [batch | rest], reports, batch_meta) do
    encoded = Enum.map(batch, fn {encoded, _bytes} -> encoded end)
    request_frame = %{type: "push", ops: encoded}

    with {:ok, %{"type" => "push_result"} = result} <- request(conn, request_frame),
         {:ok, report} <- Wire.decode_report(result) do
      meta = %{count: length(batch), bytes: request_frame |> Jason.encode!() |> byte_size()}
      push_batches(conn, rest, [report | reports], [meta | batch_meta])
    else
      {:ok, %{"type" => type}} -> {:error, {:unexpected_reply, type}}
      {:ok, other} -> {:error, {:unexpected_reply, other}}
      {:error, _reason} = error -> error
    end
  end

  defp encode_entry(op) do
    encoded = NodeWire.encode(op)
    {encoded, encoded |> Jason.encode!() |> byte_size()}
  end

  defp authenticate(%__MODULE__{} = conn, session) do
    challenge =
      session.realm
      |> Session.challenge(session.replica, wire_version: Wire.version())
      |> Session.sign_challenge(session.identity)

    with {:ok, %{"type" => "carrier_hello"} = response} <- request(conn, challenge) do
      Session.verify_response(challenge, response,
        expected_realm: session.peer_realm,
        expected_pubkey: session.peer_pubkey
      )
    else
      {:ok, %{"type" => type}} -> {:error, {:unexpected_reply, type}}
      {:ok, other} -> {:error, {:unexpected_reply, other}}
      {:error, _reason} = error -> error
    end
  end

  defp session_opts(opts) do
    with {:ok, identity} <- required_opt(opts, :identity),
         {:ok, realm} <- required_opt(opts, :realm),
         {:ok, peer_realm} <- required_opt(opts, :peer_realm),
         {:ok, peer_pubkey} <- required_opt(opts, :peer_pubkey),
         {:ok, replica} <- required_opt(opts, :replica) do
      {:ok,
       %{
         identity: identity,
         realm: realm,
         peer_realm: peer_realm,
         peer_pubkey: peer_pubkey,
         replica: replica
       }}
    end
  end

  defp required_opt(opts, key) do
    case Keyword.fetch(opts, key) do
      {:ok, value} -> {:ok, value}
      :error -> {:error, {:missing_required_opt, key}}
    end
  end

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
