defmodule Lattice.Transport.WebSocket do
  @moduledoc """
  Cowboy WebSocket boundary for browser tab realms.

  Browser messages are JSON envelopes and are converted into gateway calls. The
  handler never accepts raw pids, registered names, RPC commands, or Erlang
  external term format from the browser.
  """

  @behaviour :cowboy_websocket
  @behaviour Lattice.Transport

  alias Lattice.Cap
  alias Lattice.Transport.WebSocket.Envelope
  alias LatticeServer.{ResumeProxy, ResumeToken}

  @impl Lattice.Transport
  def deliver_call(connection_pid, envelope, timeout) do
    ref = make_ref()
    request_id = "req_" <> Lattice.Realm.random_id(12)
    send(connection_pid, {:lattice_out_call, self(), ref, request_id, envelope})

    receive do
      {:lattice_out_reply, ^ref, reply} -> reply
    after
      timeout ->
        send(connection_pid, {:lattice_out_cancel, request_id})
        {:error, :timeout}
    end
  end

  @impl Lattice.Transport
  def deliver_cast(connection_pid, envelope) do
    send(connection_pid, {:lattice_out_cast, envelope})
    :ok
  end

  @impl :cowboy_websocket
  def init(req, opts) do
    {:cowboy_websocket, req,
     %{
       tab: nil,
       client_id: nil,
       grant_targets: Map.get(opts, :grant_targets, %{}),
       auto_story?: Map.get(opts, :auto_story?, true),
       resume_proxy_ttl_ms: Map.get(opts, :resume_proxy_ttl_ms, 15_000),
       resume_buffer_size: Map.get(opts, :resume_buffer_size, 64),
       pending: %{},
       caps: %{}
     }}
  end

  @impl :cowboy_websocket
  def websocket_init(state), do: {:ok, state}

  @impl :cowboy_websocket
  def websocket_handle({:text, text}, state) do
    case Envelope.parse(text) do
      {:ok, envelope} -> handle_envelope(envelope, state)
      {:error, reason} -> reply_error(:malformed, reason, state)
    end
  end

  def websocket_handle(_frame, state), do: reply_error(:malformed, :unsupported_frame, state)

  @impl :cowboy_websocket
  def websocket_info({:lattice_out_call, caller, ref, request_id, envelope}, state) do
    pending = Map.put(state.pending, request_id, {caller, ref})

    frame =
      Envelope.encode(%{
        type: "tab_call",
        request_id: request_id,
        payload: Map.get(envelope, :payload, %{}),
        from_tab_id: Map.get(envelope, :from_tab_id)
      })

    {:reply, {:text, frame}, %{state | pending: pending}}
  end

  def websocket_info({:lattice_out_cancel, request_id}, state) do
    {:ok, %{state | pending: Map.delete(state.pending, request_id)}}
  end

  def websocket_info({:lattice_out_cast, envelope}, state) do
    frame =
      Envelope.encode(%{
        type: "tab_cast",
        payload: Map.get(envelope, :payload, %{}),
        from_tab_id: Map.get(envelope, :from_tab_id)
      })

    {:reply, {:text, frame}, state}
  end

  def websocket_info({:lattice_demo_push, frame}, state) do
    {:reply, {:text, Envelope.encode(frame)}, state}
  end

  def websocket_info(_message, state), do: {:ok, state}

  @impl :cowboy_websocket
  def terminate(_reason, _req, state) do
    cleanup_connection(state)
    :ok
  end

  defp handle_envelope(%{"type" => "hello"} = envelope, %{tab: nil} = state) do
    identity = Map.get(envelope, "identity", %{})
    requested_client_id = client_id_from(envelope) || state.client_id

    {:ok, tab} =
      Lattice.connect_tab(%{
        transport: __MODULE__,
        connection_pid: self(),
        identity: identity,
        metadata:
          %{transport: "websocket"}
          |> maybe_put(:client_id, requested_client_id)
      })

    client_id = requested_client_id || tab.id
    {:ok, _proxy} = attach_resume_proxy(client_id, state)

    reply =
      Envelope.encode(%{
        type: "welcome",
        tab_id: tab.id,
        session_id: tab.session_id,
        client_id: client_id
      })

    LatticeServer.DemoHub.register(tab, auto_story?: state.auto_story?)

    {:reply, {:text, reply}, %{state | tab: tab, client_id: client_id}}
  end

  defp handle_envelope(%{"type" => "hello"}, state) do
    client_id = state.client_id || state.tab.id
    {:ok, _proxy} = attach_resume_proxy(client_id, state)

    reply =
      Envelope.encode(%{
        type: "welcome",
        tab_id: state.tab.id,
        session_id: state.tab.session_id,
        client_id: client_id
      })

    {:reply, {:text, reply}, %{state | client_id: client_id}}
  end

  defp handle_envelope(%{"type" => "resume", "jwt" => jwt} = envelope, state) do
    with {:ok, from_seq} <- parse_resume_seq(Map.get(envelope, "seq", 0)),
         {:ok, claims} <- ResumeToken.consume(jwt),
         client_id when is_binary(client_id) <- claims["sub"] do
      resume_client(client_id, from_seq, state)
    else
      {:error, reason} ->
        reply_error(:resume_denied, reason, state)

      _other ->
        reply_error(:resume_denied, :invalid_claims, state)
    end
  end

  defp handle_envelope(%{"type" => "state_request"}, %{tab: tab} = state)
       when not is_nil(tab) do
    {:reply, {:text, Envelope.encode(LatticeServer.DemoHub.snapshot())}, state}
  end

  defp handle_envelope(%{"type" => "grant_request", "target" => target}, %{tab: tab} = state)
       when not is_nil(tab) do
    case Map.fetch(state.grant_targets, target) do
      {:ok, server_target} ->
        ops = parse_ops(Map.get(state.grant_targets, {target, :ops}, ["call", "cast"]))

        case Lattice.grant(tab.id, server_target, ops, audit: %{requested_by: "websocket_demo"}) do
          {:ok, cap} ->
            LatticeServer.DemoHub.event(:grant, %{
              tab_id: tab.id,
              cap_id: cap.id,
              target: target
            })

            reply =
              Envelope.encode(%{
                type: "grant",
                cap: Lattice.external_cap(cap)
              })

            {:reply, {:text, reply}, %{state | caps: Map.put(state.caps, target, cap.id)}}

          {:error, reason} ->
            reply_error(:grant_denied, reason, state)
        end

      :error ->
        LatticeServer.DemoHub.event(:deny, %{
          tab_id: tab.id,
          target: target,
          reason: :unknown_grant_target
        })

        Lattice.Audit.record(:deny, %{
          tab_id: tab.id,
          reason: :unknown_grant_target,
          target: target
        })

        reply_error(:grant_denied, :unknown_target, state)
    end
  end

  defp handle_envelope(
         %{"type" => "call", "cap_id" => cap_id, "payload" => payload} = envelope,
         %{tab: tab} = state
       )
       when not is_nil(tab) do
    reply =
      case gateway_call(tab.id, cap_id, payload, Map.get(envelope, "target")) do
        {:ok, result} ->
          LatticeServer.DemoHub.event(:call, %{
            tab_id: tab.id,
            cap_id: cap_id,
            op: Map.get(payload, "op") || Map.get(payload, :op) || "call"
          })

          %{type: "call_result", ok: true, result: result}

        {:error, reason} ->
          LatticeServer.DemoHub.event(:deny, %{
            tab_id: tab.id,
            cap_id: cap_id,
            reason: inspect(reason)
          })

          %{type: "call_result", ok: false, error: inspect(reason)}
      end

    {:reply, {:text, Envelope.encode(reply)}, state}
  end

  defp handle_envelope(
         %{"type" => "cast", "cap_id" => cap_id, "payload" => payload} = envelope,
         %{tab: tab} = state
       )
       when not is_nil(tab) do
    reply =
      case gateway_cast(tab.id, cap_id, payload, Map.get(envelope, "target")) do
        :ok ->
          LatticeServer.DemoHub.event(:cast, %{tab_id: tab.id, cap_id: cap_id})
          %{type: "cast_result", ok: true}

        {:error, reason} ->
          LatticeServer.DemoHub.event(:deny, %{
            tab_id: tab.id,
            cap_id: cap_id,
            reason: inspect(reason)
          })

          %{type: "cast_result", ok: false, error: inspect(reason)}
      end

    {:reply, {:text, Envelope.encode(reply)}, state}
  end

  defp handle_envelope(
         %{"type" => "tab_render_result", "request_id" => request_id, "result" => result},
         state
       ) do
    case Map.pop(state.pending, request_id) do
      {{caller, ref}, pending} ->
        LatticeServer.DemoHub.event(:tab_render_result, %{tab_id: state.tab && state.tab.id})
        send(caller, {:lattice_out_reply, ref, {:ok, result}})
        {:ok, %{state | pending: pending}}

      {nil, _pending} ->
        reply_error(:unknown_request, request_id, state)
    end
  end

  defp handle_envelope(%{"type" => "disconnect"}, %{tab: %{id: _tab_id}} = state) do
    cleanup_connection(state)
    reply = Envelope.encode(%{type: "disconnect_result", ok: true})
    {:reply, {:text, reply}, %{state | tab: nil, client_id: nil, pending: %{}}}
  end

  defp handle_envelope(_envelope, state),
    do: reply_error(:denied, :hello_required_or_invalid_envelope, state)

  defp reply_error(type, reason, state) do
    frame = Envelope.encode(%{type: "error", error_type: type, reason: inspect(reason)})
    {:reply, {:text, frame}, state}
  end

  defp gateway_call(tab_id, cap_id, payload, requested_target) do
    with :ok <- reject_target_override(tab_id, cap_id, requested_target) do
      Lattice.call(tab_id, cap_id, payload)
    end
  end

  defp gateway_cast(tab_id, cap_id, payload, requested_target) do
    with :ok <- reject_target_override(tab_id, cap_id, requested_target) do
      Lattice.cast(tab_id, cap_id, payload)
    end
  end

  defp reject_target_override(_tab_id, _cap_id, nil), do: :ok

  defp reject_target_override(tab_id, cap_id, requested_target)
       when is_binary(requested_target) do
    case Lattice.CapStore.get(cap_id) do
      {:ok, cap} ->
        if requested_target in Cap.target_labels(cap.target) do
          :ok
        else
          Lattice.Audit.record(:deny, %{
            tab_id: tab_id,
            cap_id: cap.id,
            requested_target: requested_target,
            actual_target: inspect(cap.target),
            reason: :target_mismatch
          })

          {:error, :target_mismatch}
        end

      :error ->
        {:error, :unknown_cap}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp reject_target_override(tab_id, _cap_id, requested_target) do
    Lattice.Audit.record(:deny, %{
      tab_id: tab_id,
      requested_target: inspect(requested_target),
      reason: :malformed_target
    })

    {:error, :malformed_target}
  end

  defp parse_ops(ops) when is_list(ops) do
    Enum.map(ops, &Cap.normalize_op/1)
  end

  defp resume_client(client_id, from_seq, state) do
    state = %{state | client_id: client_id}

    case ResumeProxy.resume(client_id, from_seq) do
      {:ok, missed, latest_seq} ->
        {:ok, _proxy} = attach_resume_proxy(client_id, state)

        frames =
          [
            %{type: "resume_ok", replayed: length(missed), latest_seq: latest_seq}
            | missed
          ]
          |> Enum.map(&{:text, Envelope.encode(&1)})

        {:reply, frames, state}

      {:error, :out_of_window, latest_seq} ->
        {:ok, _proxy} = attach_resume_proxy(client_id, state)

        reply =
          Envelope.encode(%{
            type: "rehydrate",
            reason: "out_of_window",
            latest_seq: latest_seq
          })

        {:reply, {:text, reply}, state}

      {:error, :not_found} ->
        {:ok, _proxy} = attach_resume_proxy(client_id, state)

        reply =
          Envelope.encode(%{
            type: "rehydrate",
            reason: "resume_window_missing",
            latest_seq: 0
          })

        {:reply, {:text, reply}, state}
    end
  end

  defp attach_resume_proxy(client_id, state) do
    ResumeProxy.attach(client_id, self(),
      ttl_ms: state.resume_proxy_ttl_ms,
      buffer_size: state.resume_buffer_size
    )
  end

  defp cleanup_connection(%{client_id: client_id, tab: tab}) do
    ResumeProxy.detach(client_id, self())

    case tab do
      %{id: tab_id} ->
        LatticeServer.DemoHub.unregister(tab_id)
        Lattice.disconnect_tab(tab_id)

      _other ->
        :ok
    end
  end

  defp client_id_from(%{"client_id" => client_id}) when is_binary(client_id),
    do: clean_client_id(client_id)

  defp client_id_from(%{"identity" => %{"client_id" => client_id}}) when is_binary(client_id),
    do: clean_client_id(client_id)

  defp client_id_from(_envelope), do: nil

  defp clean_client_id(client_id) do
    client_id = String.trim(client_id)

    cond do
      byte_size(client_id) < 8 -> nil
      byte_size(client_id) > 128 -> nil
      String.match?(client_id, ~r/^[A-Za-z0-9_.:-]+$/) -> client_id
      true -> nil
    end
  end

  defp parse_resume_seq(seq) when is_integer(seq) and seq >= 0, do: {:ok, seq}

  defp parse_resume_seq(seq) when is_binary(seq) do
    case Integer.parse(seq) do
      {parsed, ""} when parsed >= 0 -> {:ok, parsed}
      _other -> {:error, :invalid_resume_seq}
    end
  end

  defp parse_resume_seq(_seq), do: {:error, :invalid_resume_seq}

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
