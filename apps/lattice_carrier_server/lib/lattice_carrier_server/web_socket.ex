defmodule LatticeCarrierServer.WebSocket do
  @moduledoc false

  @behaviour :cowboy_websocket

  alias Lattice.Carrier.{Session, Telemetry, Wire}
  alias LatticeCarrierServer.Holder

  @max_frame_size 64_000
  @availability_coalesce_ms 50
  @authentication_timeout_ms 5_000
  @authenticated_idle_timeout_ms 120_000
  # Match the existing 120-per-10-second server budget: a participant may drain a
  # 120-op outbox immediately, while a sustained flood is held to 12 relay frames/s.
  @relay_burst_capacity 120
  @relay_refill_tokens_per_second 12
  @relay_token_units 1_000
  @relay_capacity_units @relay_burst_capacity * @relay_token_units
  @relay_refill_units_per_millisecond div(
                                        @relay_refill_tokens_per_second * @relay_token_units,
                                        1_000
                                      )

  @spec authentication_timeout_ms() :: pos_integer()
  def authentication_timeout_ms, do: @authentication_timeout_ms

  @spec authenticated_idle_timeout_ms() :: pos_integer()
  def authenticated_idle_timeout_ms, do: @authenticated_idle_timeout_ms

  @impl :cowboy_websocket
  def init(req, state) do
    {:cowboy_websocket, req, state,
     %{idle_timeout: @authenticated_idle_timeout_ms, max_frame_size: @max_frame_size}}
  end

  @impl :cowboy_websocket
  def websocket_init(state) do
    timer = Process.send_after(self(), :authentication_deadline, @authentication_timeout_ms)
    nonce_frame = Session.nonce_frame(wire_version: Wire.version())

    {:reply, {:text, Jason.encode!(nonce_frame)},
     state
     |> Map.put(:authentication_timer, timer)
     |> Map.put(:server_nonce, nonce_frame["nonce"])
     |> Map.put(:relay_token_units, @relay_capacity_units)
     |> Map.put(:relay_refilled_at_ms, System.monotonic_time(:millisecond))}
  end

  @impl :cowboy_websocket
  def websocket_handle({:text, text}, state) do
    {reply, state} =
      case Jason.decode(text) do
        {:ok, %{"type" => "carrier_challenge"} = challenge} ->
          authenticate(challenge, state)

        {:ok, %{"type" => type} = message} ->
          authenticated_message(type, message, state)

        _other ->
          {%{type: "error", reason: "malformed"}, state}
      end

    {:reply, {:text, Jason.encode!(reply)}, state}
  end

  def websocket_handle(_frame, state) do
    {:reply, {:text, Jason.encode!(%{type: "error", reason: "unsupported_frame"})}, state}
  end

  @impl :cowboy_websocket
  def websocket_info(
        {:lattice_carrier_ops_available, holder, availability},
        %{subscribed?: true, subscription_holder: holder} = state
      ) do
    {:ok, queue_availability(state, acknowledge_availability(holder, availability))}
  end

  def websocket_info(:flush_ops_available, state) do
    case Map.get(state, :pending_availability) do
      nil ->
        {:ok, Map.delete(state, :availability_timer)}

      availability ->
        frame = availability |> Map.put(:type, "ops_available") |> Jason.encode!()

        {:reply, {:text, frame},
         state
         |> Map.delete(:availability_timer)
         |> Map.delete(:pending_availability)}
    end
  end

  def websocket_info(:authentication_deadline, %{authenticated?: false} = state) do
    {:stop, Map.delete(state, :authentication_timer)}
  end

  def websocket_info(:authentication_deadline, state) do
    {:ok, Map.delete(state, :authentication_timer)}
  end

  def websocket_info(_message, state), do: {:ok, state}

  defp authenticate(challenge, state) do
    with %{"local_realm" => peer_realm, "replica" => replica} <- challenge,
         {:ok, peer_pubkey} <- Map.fetch(state.trusted_peers, peer_realm),
         {identity, ^replica} <- Holder.session_context(state.holder),
         :ok <-
           Session.verify_challenge(challenge,
             expected_realm: peer_realm,
             expected_pubkey: peer_pubkey,
             expected_server_nonce: state.server_nonce,
             expected_wire_version: Wire.version()
           ) do
      response = Session.respond(challenge, identity, identity.realm_id)

      {response,
       state
       |> reset_subscription()
       |> cancel_authentication_deadline()
       |> Map.put(:authenticated?, true)
       |> Map.put(:peer_realm, peer_realm)
       |> Map.put(:realm, identity.realm_id)}
    else
      reason -> authentication_failure(reason, challenge, state)
    end
  end

  defp authentication_failure(reason, challenge, state) do
    peer_realm = Map.get(challenge, "local_realm")

    Telemetry.execute(
      [:lattice, :carrier, :auth_failure],
      %{},
      %{
        reason: auth_failure_reason(reason),
        expected_realm: peer_realm,
        peer_realm: peer_realm,
        side: :server
      }
    )

    {%{type: "error", reason: "unauthenticated"}, state}
  end

  defp auth_failure_reason({:error, reason}), do: reason
  defp auth_failure_reason(:error), do: :unknown_peer
  defp auth_failure_reason({_identity, _replica}), do: :wrong_replica
  defp auth_failure_reason(_reason), do: :malformed_session

  defp authenticated_message(type, message, %{authenticated?: true} = state) do
    authenticated_request(type, message, state)
  end

  defp authenticated_message(_type, _message, state) do
    {%{type: "error", reason: "unauthenticated"}, state}
  end

  defp authenticated_request("subscribe", _message, state) do
    {:ok, availability} = Holder.subscribe(state.holder, self())

    {Map.put(availability, :type, "subscribe_result"),
     state
     |> Map.put(:subscribed?, true)
     |> Map.put(:subscription_holder, GenServer.whereis(state.holder))}
  end

  defp authenticated_request("unsubscribe", _message, state) do
    :ok = Holder.unsubscribe(state.holder, self())

    {%{type: "unsubscribe_result"},
     state
     |> cancel_pending_availability()
     |> Map.put(:subscribed?, false)
     |> Map.delete(:subscription_holder)}
  end

  defp authenticated_request("relay", message, state) do
    case take_relay_token(state) do
      {:ok, state} -> {handle_message("relay", message, state), state}
      {:error, state} -> {%{type: "error", reason: "rate_limited"}, state}
    end
  end

  defp authenticated_request(type, message, state) do
    {handle_message(type, message, state), state}
  end

  defp take_relay_token(state) do
    now_ms = System.monotonic_time(:millisecond)
    elapsed_ms = max(now_ms - state.relay_refilled_at_ms, 0)

    available_units =
      min(
        @relay_capacity_units,
        state.relay_token_units + elapsed_ms * @relay_refill_units_per_millisecond
      )

    state =
      state
      |> Map.put(:relay_token_units, available_units)
      |> Map.put(:relay_refilled_at_ms, now_ms)

    if available_units >= @relay_token_units do
      {:ok, Map.put(state, :relay_token_units, available_units - @relay_token_units)}
    else
      {:error, state}
    end
  end

  defp handle_message("frontier", _message, state) do
    %{type: "frontier_result", ids: Holder.op_ids(state.holder)}
  end

  defp handle_message("pull", %{"have" => have}, state) when is_list(have) do
    ops = state.holder |> Holder.missing_for(have) |> Enum.map(&Wire.encode_op/1)
    %{type: "ops", ops: ops}
  end

  defp handle_message("state", _message, state) do
    case Holder.state_report(state.holder) do
      {:ok, report} -> Map.put(report, :type, "state_result")
      {:error, :read_only} -> %{type: "error", reason: "read_only"}
    end
  end

  defp handle_message("relay", %{"op" => encoded_op}, state) do
    with {:ok, op} <- Wire.decode_op(encoded_op),
         {:ok, report} <- Holder.relay(state.holder, state.peer_realm, op) do
      report |> Wire.encode_report() |> Map.put("type", "relay_result")
    else
      {:error, :read_only} ->
        %{type: "error", reason: "read_only"}

      {:error, :malformed_op} ->
        %{type: "error", reason: "malformed"}

      {:error, {:persistence_failed, _reason} = reason} ->
        Telemetry.execute(
          [:lattice, :carrier, :relay_failure],
          %{},
          %{reason: reason, peer_realm: state.peer_realm, side: :server}
        )

        %{type: "error", reason: "unavailable"}
    end
  end

  defp handle_message("relay", _message, _state) do
    %{type: "error", reason: "malformed"}
  end

  defp handle_message(_type, _message, _state) do
    %{type: "error", reason: "read_only"}
  end

  defp queue_availability(state, availability) do
    pending = Map.get(state, :pending_availability)

    latest =
      if pending == nil or availability.generation > pending.generation,
        do: availability,
        else: pending

    state = Map.put(state, :pending_availability, latest)

    if Map.has_key?(state, :availability_timer) do
      state
    else
      Map.put(
        state,
        :availability_timer,
        Process.send_after(self(), :flush_ops_available, @availability_coalesce_ms)
      )
    end
  end

  defp acknowledge_availability(holder, availability) do
    case Holder.acknowledge(holder, self(), availability.generation) do
      {:ok, nil} -> availability
      {:ok, latest} -> latest
    end
  catch
    :exit, _reason -> availability
  end

  defp cancel_pending_availability(state) do
    if timer = Map.get(state, :availability_timer) do
      Process.cancel_timer(timer)
    end

    state
    |> Map.delete(:availability_timer)
    |> Map.delete(:pending_availability)
  end

  defp reset_subscription(state) do
    if Map.get(state, :subscribed?, false) do
      :ok = Holder.unsubscribe(state.holder, self())
    end

    state
    |> cancel_pending_availability()
    |> Map.put(:subscribed?, false)
    |> Map.delete(:subscription_holder)
  end

  defp cancel_authentication_deadline(state) do
    if timer = Map.get(state, :authentication_timer) do
      Process.cancel_timer(timer)
    end

    Map.delete(state, :authentication_timer)
  end

  @impl :cowboy_websocket
  def terminate(reason, _req, state) do
    unsubscribe_on_terminate(state)

    if state.authenticated? do
      Telemetry.execute(
        [:lattice, :carrier, :disconnect],
        %{},
        %{
          realm: state.realm,
          peer_realm: state.peer_realm,
          reason: disconnect_reason(reason),
          side: :server
        }
      )
    end

    :ok
  end

  defp unsubscribe_on_terminate(%{subscribed?: true} = state) do
    Holder.unsubscribe(state.holder, self())
  catch
    :exit, _reason -> :ok
  end

  defp unsubscribe_on_terminate(_state), do: :ok

  defp disconnect_reason({:remote, code, _payload}), do: {:remote, code}
  defp disconnect_reason({:error, reason}), do: {:error, reason}
  defp disconnect_reason(reason) when is_atom(reason), do: reason
  defp disconnect_reason(_reason), do: :other
end
