defmodule Lattice.Carrier.WebSocket do
  @moduledoc """
  `Lattice.Carrier` over a **real** WebSocket.

  The connection wraps `Lattice.Transport.WebSocket.Client` — a raw `:gen_tcp`
  client that performs the RFC 6455 handshake and framing against the peer OS
  process's Cowboy listener. Connection setup starts with a server nonce and a
  signed challenge/response that binds it. Every sync callback after that is one JSON
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
  @max_read_pages 1_024
  @max_have_request_bytes 48_000
  @max_cursor_bytes 512

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
    with {:ok, ids} <- read_pages(conn, :frontier, %{type: "frontier"}) do
      {:ok, MapSet.new(ids), conn}
    end
  end

  @impl Lattice.Carrier
  def pull(%__MODULE__{} = conn, %MapSet{} = have) do
    initial = %{type: "pull", have: Enum.sort(have)}

    initial =
      if byte_size(Jason.encode!(initial)) <= @max_have_request_bytes,
        do: initial,
        else: %{type: "pull", have: []}

    with {:ok, ops} <- read_pages(conn, :pull, initial) do
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
    with {:ok, nonce_frame} <- Client.recv_atomic_envelope(conn.client, @recv_timeout),
         {:ok, server_nonce} <-
           Session.verify_nonce_frame(nonce_frame, expected_wire_version: Wire.version()),
         challenge <-
           session.realm
           |> Session.challenge(session.replica,
             server_nonce: server_nonce,
             wire_version: Wire.version()
           )
           |> Session.sign_challenge(session.identity),
         {:ok, %{"type" => "carrier_hello"} = response} <- request(conn, challenge) do
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

  defp read_pages(conn, kind, initial) do
    read_pages(conn, kind, initial, %{cursor: nil, chunks: [], seen: MapSet.new(), pages: 0})
  end

  defp read_pages(conn, kind, initial, state) do
    envelope = if state.cursor, do: Map.put(initial, :cursor, state.cursor), else: initial

    with {:ok, response} <- request(conn, envelope),
         {:ok, entries} <- read_page_entries(response, kind),
         ids = Enum.map(entries, &read_entry_id(&1, kind)),
         :ok <- unique_page_ids(ids, state.seen),
         {:ok, cursor} <- next_read_cursor(response, kind, ids, state),
         :ok <- frontier_page_order(kind, ids, cursor, state.cursor) do
      chunks = [entries | state.chunks]

      cond do
        cursor == nil ->
          {:ok, chunks |> Enum.reverse() |> List.flatten()}

        state.pages + 1 >= @max_read_pages ->
          {:error, :pagination_page_limit}

        true ->
          next = %{
            cursor: cursor,
            chunks: chunks,
            seen: MapSet.union(state.seen, MapSet.new(ids)),
            pages: state.pages + 1
          }

          read_pages(conn, kind, initial, next)
      end
    end
  end

  defp read_page_entries(%{"type" => "ops", "ops" => encoded}, :pull),
    do: Wire.decode_ops(encoded)

  defp read_page_entries(%{"type" => "frontier_result", "ids" => ids}, :frontier)
       when is_list(ids) do
    if Enum.all?(ids, &is_binary/1), do: {:ok, ids}, else: {:error, :malformed_page}
  end

  defp read_page_entries(_response, _kind), do: {:error, :malformed_page}

  defp read_entry_id(%Op{id: id}, :pull), do: id
  defp read_entry_id(id, :frontier), do: id

  defp unique_page_ids(ids, seen) do
    incoming = MapSet.new(ids)

    if MapSet.size(incoming) == length(ids) and MapSet.disjoint?(incoming, seen),
      do: :ok,
      else: {:error, :pagination_no_progress}
  end

  defp next_read_cursor(%{"next_cursor" => cursor}, kind, ids, state) when is_map(cursor) do
    cond do
      not valid_read_cursor?(cursor, kind) ->
        {:error, :malformed_pagination_cursor}

      ids == [] or cursor["offset"] != MapSet.size(state.seen) + length(ids) or
          cursor["after"] != List.last(ids) ->
        {:error, :pagination_no_progress}

      state.cursor != nil and
          Map.take(cursor, ["snapshot", "have"]) != Map.take(state.cursor, ["snapshot", "have"]) ->
        {:error, :pagination_snapshot_changed}

      true ->
        {:ok, cursor}
    end
  end

  defp next_read_cursor(%{"next_cursor" => _invalid}, _kind, _ids, _state),
    do: {:error, :malformed_pagination_cursor}

  defp next_read_cursor(_response, _kind, _ids, _state), do: {:ok, nil}

  defp valid_read_cursor?(cursor, kind) do
    keys = ["version", "after", "snapshot", "offset"] ++ if(kind == :pull, do: ["have"], else: [])

    Enum.sort(Map.keys(cursor)) == Enum.sort(keys) and
      byte_size(Jason.encode!(cursor)) <= @max_cursor_bytes and cursor["version"] == 1 and
      is_integer(cursor["offset"]) and cursor["offset"] > 0 and
      sized_binary?(cursor["after"], 43) and sized_binary?(cursor["snapshot"], 64) and
      (kind != :pull or sized_binary?(cursor["have"], 64))
  end

  defp sized_binary?(value, size), do: is_binary(value) and byte_size(value) == size

  defp frontier_page_order(:frontier, ids, cursor, previous)
       when cursor != nil or previous != nil do
    if ids == Enum.sort(ids) and (previous == nil or ids == [] or hd(ids) > previous["after"]),
      do: :ok,
      else: {:error, :pagination_no_progress}
  end

  defp frontier_page_order(_kind, _ids, _cursor, _previous), do: :ok

  defp request(%__MODULE__{client: client}, msg) do
    with {:ok, envelope} <- Client.request_envelope(client, msg, @recv_timeout) do
      case envelope do
        %{"type" => "error"} = err -> {:error, {:peer_error, Map.get(err, "reason")}}
        other -> {:ok, other}
      end
    end
  end
end
