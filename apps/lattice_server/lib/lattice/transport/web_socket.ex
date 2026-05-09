defmodule Lattice.Transport.WebSocket do
  @moduledoc """
  Cowboy WebSocket boundary for browser tab realms.

  Browser messages are JSON envelopes and are converted into gateway calls. The
  handler never accepts raw pids, registered names, RPC commands, or Erlang
  external term format from the browser.
  """

  @behaviour :cowboy_websocket
  @behaviour Lattice.Transport

  alias Lattice.Transport.WebSocket.Envelope

  @impl Lattice.Transport
  def deliver_call(connection_pid, envelope, timeout) do
    ref = make_ref()
    request_id = "req_" <> Lattice.Realm.random_id(12)
    send(connection_pid, {:lattice_out_call, self(), ref, request_id, envelope})

    receive do
      {:lattice_out_reply, ^ref, reply} -> reply
    after
      timeout -> {:error, :timeout}
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
       grant_targets: Map.get(opts, :grant_targets, %{}),
       auto_story?: Map.get(opts, :auto_story?, true),
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
  def terminate(_reason, _req, %{tab: %{id: tab_id}}) do
    LatticeServer.DemoHub.unregister(tab_id)
    Lattice.disconnect_tab(tab_id)
    :ok
  end

  def terminate(_reason, _req, _state), do: :ok

  defp handle_envelope(%{"type" => "hello"} = envelope, %{tab: nil} = state) do
    identity = Map.get(envelope, "identity", %{})

    {:ok, tab} =
      Lattice.connect_tab(%{
        transport: __MODULE__,
        connection_pid: self(),
        identity: identity,
        metadata: %{transport: "websocket"}
      })

    reply =
      Envelope.encode(%{
        type: "welcome",
        tab_id: tab.id,
        session_id: tab.session_id
      })

    LatticeServer.DemoHub.register(tab, auto_story?: state.auto_story?)

    {:reply, {:text, reply}, %{state | tab: tab}}
  end

  defp handle_envelope(%{"type" => "hello"}, state) do
    reply =
      Envelope.encode(%{type: "welcome", tab_id: state.tab.id, session_id: state.tab.session_id})

    {:reply, {:text, reply}, state}
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
         %{"type" => "call", "cap_id" => cap_id, "payload" => payload},
         %{tab: tab} = state
       )
       when not is_nil(tab) do
    reply =
      case Lattice.call(tab.id, cap_id, payload) do
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
         %{"type" => "cast", "cap_id" => cap_id, "payload" => payload},
         %{tab: tab} = state
       )
       when not is_nil(tab) do
    reply =
      case Lattice.cast(tab.id, cap_id, payload) do
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

  defp handle_envelope(%{"type" => "disconnect"}, %{tab: %{id: tab_id}} = state) do
    LatticeServer.DemoHub.unregister(tab_id)
    Lattice.disconnect_tab(tab_id)
    reply = Envelope.encode(%{type: "disconnect_result", ok: true})
    {:reply, {:text, reply}, %{state | tab: nil}}
  end

  defp handle_envelope(_envelope, state),
    do: reply_error(:denied, :hello_required_or_invalid_envelope, state)

  defp reply_error(type, reason, state) do
    frame = Envelope.encode(%{type: "error", error_type: type, reason: inspect(reason)})
    {:reply, {:text, frame}, state}
  end

  defp parse_ops(ops) when is_list(ops) do
    Enum.flat_map(ops, fn
      "call" -> [:call]
      "cast" -> [:cast]
      :call -> [:call]
      :cast -> [:cast]
      _ -> []
    end)
  end
end
