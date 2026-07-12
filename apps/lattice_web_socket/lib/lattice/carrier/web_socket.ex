defmodule Lattice.Carrier.WebSocket do
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
  alias Lattice.Carrier.Telemetry
  alias Lattice.Op
  alias Lattice.Transport.WebSocket.Client

  @recv_timeout 10_000
  @max_push_ops 64
  @max_push_bytes 64_000

  @enforce_keys [:client]
  defstruct [
    :client,
    :subscription_ref,
    :subscription_owner,
    :subscription_generation,
    last_push_batches: []
  ]

  @type t :: %__MODULE__{
          client: pid(),
          subscription_ref: reference() | nil,
          subscription_owner: pid() | nil,
          subscription_generation: non_neg_integer() | nil,
          last_push_batches: [map()]
        }

  @doc "Open a WebSocket to the peer's `/carrier` endpoint."
  @spec connect(keyword()) :: {:ok, t()} | {:error, term()}
  def connect(opts) do
    opts = Keyword.put_new(opts, :path, "/carrier")

    with {:ok, session} <- session_opts(opts),
         {:ok, client} <- Client.connect(opts) do
      conn = %__MODULE__{client: client}

      case authenticate(conn, session) do
        :ok ->
          Telemetry.execute(
            [:lattice, :carrier, :connect],
            %{},
            %{realm: session.realm, peer_realm: session.peer_realm}
          )

          {:ok, conn}

        {:error, reason} = error ->
          Telemetry.execute(
            [:lattice, :carrier, :auth_failure],
            %{},
            %{
              reason: reason,
              realm: session.realm,
              peer_realm: session.peer_realm,
              side: :client
            }
          )

          _ = Client.close(client)
          error
      end
    end
  end

  @doc "Close the socket — the physical partition."
  @spec close(t()) :: :ok
  def close(%__MODULE__{client: client}), do: Client.close(client)

  @doc "Subscribe an owner to authenticated carrier availability hints."
  @spec subscribe(t(), pid()) ::
          {:ok, %{ref: reference(), generation: non_neg_integer()}, t()} | {:error, term()}
  def subscribe(%__MODULE__{subscription_ref: nil} = conn, owner) when is_pid(owner) do
    subscribe(conn, owner, make_ref())
  end

  def subscribe(%__MODULE__{}, _owner), do: {:error, :already_subscribed}

  @doc "Subscribe with an owner-preallocated local reference."
  @spec subscribe(t(), pid(), reference()) ::
          {:ok, %{ref: reference(), generation: non_neg_integer()}, t()} | {:error, term()}
  def subscribe(%__MODULE__{subscription_ref: nil} = conn, owner, subscription)
      when is_pid(owner) and is_reference(subscription) do
    case Client.subscribe(conn.client, "ops_available", owner,
           tag: :lattice_carrier,
           subscription: subscription
         ) do
      {:ok, subscription} ->
        subscribe_remote(conn, owner, subscription)

      {:error, _reason} = error ->
        error
    end
  end

  def subscribe(%__MODULE__{}, _owner, _subscription), do: {:error, :already_subscribed}

  @doc "Remove the authenticated availability subscription from both peers."
  @spec unsubscribe(t()) :: {:ok, t()} | {:error, term()}
  def unsubscribe(%__MODULE__{subscription_ref: nil} = conn), do: {:ok, conn}

  def unsubscribe(%__MODULE__{} = conn) do
    result = request(conn, %{type: "unsubscribe"})
    :ok = Client.unsubscribe(conn.client, conn.subscription_ref)
    conn = clear_subscription(conn)

    case result do
      {:ok, %{"type" => "unsubscribe_result"}} -> {:ok, conn}
      {:ok, %{"type" => type}} -> {:error, {:unexpected_reply, type}}
      {:ok, other} -> {:error, {:unexpected_reply, other}}
      {:error, _reason} = error -> error
    end
  end

  @doc "Return the local subscription reference and server baseline generation."
  @spec subscription(t()) :: {:ok, %{ref: reference(), generation: non_neg_integer()}} | :none
  def subscription(%__MODULE__{subscription_ref: nil}), do: :none

  def subscription(%__MODULE__{} = conn) do
    {:ok, %{ref: conn.subscription_ref, generation: conn.subscription_generation}}
  end

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

  @doc "Submit one already-signed op to an explicitly relay-enabled peer."
  @spec relay(t(), Op.t()) :: {:ok, Lattice.Sync.report(), t()} | {:error, term()}
  def relay(%__MODULE__{} = conn, %Op{} = op) do
    with {:ok, %{"type" => "relay_result"} = result} <-
           request(conn, %{type: "relay", op: Wire.encode_op(op)}),
         {:ok, report} <- Wire.decode_report(result) do
      {:ok, report, conn}
    else
      {:ok, %{"type" => type}} -> {:error, {:unexpected_reply, type}}
      {:ok, other} -> {:error, {:unexpected_reply, other}}
      {:error, _reason} = error -> error
    end
  end

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
         {:ok, ops} <- Wire.decode_ops(encoded) do
      {:ok, ops, conn}
    end
  end

  @impl Lattice.Carrier
  def push(%__MODULE__{} = conn, ops) when is_list(ops) do
    entries = Enum.map(ops, &encode_entry/1)

    case Batch.chunk(entries,
           max_ops: @max_push_ops,
           max_bytes: push_payload_budget(),
           size_fun: &push_entry_budget_bytes/1
         ) do
      {:ok, batches} ->
        case push_batches(conn, batches, [], []) do
          {:ok, reports, batch_meta} ->
            {:ok, Batch.merge_reports(reports), %{conn | last_push_batches: batch_meta}}

          {:error, _reason} = error ->
            error
        end

      {:error, reason} ->
        {:error, push_chunk_error(reason)}
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
    encoded = Wire.encode_op(op)
    {encoded, encoded |> Jason.encode!() |> byte_size()}
  end

  defp push_payload_budget, do: @max_push_bytes - push_frame_overhead()

  defp push_frame_overhead do
    %{type: "push", ops: []}
    |> Jason.encode!()
    |> byte_size()
  end

  defp push_entry_budget_bytes({_encoded, bytes}), do: bytes + 1

  defp push_chunk_error({:oversized_item, size, _budget}) do
    {:oversized_item, size + push_frame_overhead(), @max_push_bytes}
  end

  defp push_chunk_error(reason), do: reason

  defp subscribe_remote(conn, owner, subscription) do
    case request(conn, %{type: "subscribe"}) do
      {:ok, %{"type" => "subscribe_result"} = result} ->
        case decode_availability(result) do
          {:ok, availability} ->
            conn = %{
              conn
              | subscription_ref: subscription,
                subscription_owner: owner,
                subscription_generation: availability.generation
            }

            {:ok, %{ref: subscription, generation: availability.generation}, conn}

          {:error, _reason} = error ->
            :ok = Client.unsubscribe(conn.client, subscription)
            error
        end

      {:ok, %{"type" => type}} ->
        :ok = Client.unsubscribe(conn.client, subscription)
        {:error, {:unexpected_reply, type}}

      {:ok, other} ->
        :ok = Client.unsubscribe(conn.client, subscription)
        {:error, {:unexpected_reply, other}}

      {:error, _reason} = error ->
        :ok = Client.unsubscribe(conn.client, subscription)
        error
    end
  end

  defp decode_availability(%{
         "generation" => generation,
         "frontier" => frontier,
         "frontier_truncated" => truncated
       })
       when is_integer(generation) and generation >= 0 and is_list(frontier) and
              is_boolean(truncated) do
    if Enum.all?(frontier, &is_binary/1) do
      {:ok, %{generation: generation, frontier: frontier, frontier_truncated: truncated}}
    else
      {:error, :malformed_availability}
    end
  end

  defp decode_availability(_result), do: {:error, :malformed_availability}

  defp clear_subscription(conn) do
    %{conn | subscription_ref: nil, subscription_owner: nil, subscription_generation: nil}
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
    with {:ok, envelope} <- Client.request_envelope(client, msg, @recv_timeout) do
      case envelope do
        %{"type" => "error"} = err -> {:error, {:peer_error, Map.get(err, "reason")}}
        other -> {:ok, other}
      end
    end
  end
end
