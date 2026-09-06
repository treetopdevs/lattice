defmodule Lattice.Transport.WebSocket.Client do
  @moduledoc """
  Minimal real WebSocket client shared by carrier, server, test, and demo callers.

  This speaks the WebSocket wire protocol over `:gen_tcp`. It is intentionally
  small, but it is not an in-process transport shortcut: messages cross the same
  Cowboy WebSocket boundary as a browser tab.

  TCP connection and HTTP upgrade share a finite setup deadline. Upgrade headers
  are limited to the same 64,000-byte budget as WebSocket payloads.
  """

  use GenServer
  import Bitwise

  alias Lattice.Transport.WebSocket.Envelope

  @guid "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
  @call_timeout_slack 1_000
  @default_connect_timeout 5_000
  @max_frame_size 64_000
  @max_notification_types 32

  @doc "Start a client with one finite `:connect_timeout` covering TCP and HTTP upgrade setup."
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def connect(opts) do
    with {:ok, pid} <- start_link(opts), do: {:ok, pid}
  end

  def send_envelope(pid, envelope) when is_map(envelope) do
    GenServer.call(pid, {:send, envelope})
  end

  def send_raw_text(pid, text) when is_binary(text) do
    GenServer.call(pid, {:send_raw_text, text})
  end

  def recv_envelope(pid, timeout \\ 5_000) do
    GenServer.call(pid, {:recv, timeout}, timeout + @call_timeout_slack)
  end

  def recv_atomic_envelope(pid, timeout \\ 5_000) do
    GenServer.call(pid, {:recv_atomic, timeout}, timeout + @call_timeout_slack)
  end

  def request_envelope(pid, envelope, timeout \\ 5_000)
      when is_map(envelope) and is_integer(timeout) and timeout > 0 do
    GenServer.call(pid, {:request, envelope, timeout}, timeout + @call_timeout_slack)
  end

  def subscribe(pid, type, subscriber, opts \\ [])
      when is_binary(type) and is_pid(subscriber) and is_list(opts) do
    subscription = Keyword.get_lazy(opts, :subscription, &make_ref/0)

    if is_reference(subscription) do
      GenServer.call(
        pid,
        {:subscribe, type, subscriber, Keyword.get(opts, :tag, :lattice_web_socket), subscription}
      )
    else
      {:error, :invalid_subscription}
    end
  end

  def unsubscribe(pid, subscription), do: GenServer.call(pid, {:unsubscribe, subscription})

  def close(pid), do: GenServer.call(pid, :close)

  @impl true
  def init(opts) do
    host = Keyword.get(opts, :hostname, Keyword.get(opts, :host, "localhost"))
    port = Keyword.fetch!(opts, :port)
    path = Keyword.get(opts, :path, "/ws")
    connect_timeout = Keyword.get(opts, :connect_timeout, @default_connect_timeout)

    with :ok <- validate_connect_timeout(connect_timeout),
         deadline = System.monotonic_time(:millisecond) + connect_timeout,
         {:ok, socket} <-
           :gen_tcp.connect(
             String.to_charlist(host),
             port,
             [:binary, active: false, packet: :raw],
             connect_timeout
           ),
         {:ok, buffer} <- handshake(socket, host, port, path, deadline),
         :ok <- :inet.setopts(socket, active: :once) do
      state = %{
        socket: socket,
        buffer: buffer,
        mode: nil,
        request_waiter: nil,
        receive_waiter: nil,
        receive_queue: :queue.new(),
        subscriptions: %{},
        notification_types: MapSet.new(),
        closed_reason: nil
      }

      if buffer != <<>>, do: send(self(), :drain_buffer)
      {:ok, state}
    else
      {:error, reason} -> {:stop, reason}
    end
  end

  @impl true
  def handle_call({:send, envelope}, _from, state) do
    stream_send(state, Envelope.encode(envelope))
  end

  def handle_call({:send_raw_text, text}, _from, state) do
    stream_send(state, text)
  end

  def handle_call({:recv, timeout}, from, state) do
    with {:ok, state} <- enter_mode(state, :stream),
         :ok <- ensure_open(state) do
      receive_envelope(state, from, timeout)
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:recv_atomic, timeout}, from, state) do
    with {:ok, state} <- enter_mode(state, :atomic),
         :ok <- ensure_open(state),
         :ok <- ensure_request_available(state) do
      receive_envelope(state, from, timeout)
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:request, envelope, timeout}, from, state) do
    with {:ok, state} <- enter_mode(state, :atomic),
         :ok <- ensure_open(state),
         :ok <- ensure_request_available(state),
         :ok <- :gen_tcp.send(state.socket, encode_client_text_frame(Envelope.encode(envelope))) do
      token = make_ref()
      timer = Process.send_after(self(), {:request_timeout, token}, timeout)
      waiter = %{from: from, timer: timer, token: token}
      {:noreply, %{state | request_waiter: waiter}}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:subscribe, type, subscriber, tag, subscription}, _from, state) do
    with {:ok, state} <- enter_mode(state, :atomic),
         :ok <- ensure_open(state),
         :ok <- ensure_notification_type_available(state, type),
         :ok <- ensure_subscription_available(state, subscription) do
      entry = %{
        type: type,
        subscriber: subscriber,
        tag: tag,
        monitor: Process.monitor(subscriber)
      }

      {:reply, {:ok, subscription},
       %{
         state
         | subscriptions: Map.put(state.subscriptions, subscription, entry),
           notification_types: MapSet.put(state.notification_types, type)
       }}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:unsubscribe, subscription}, _from, state) do
    with {:ok, state} <- enter_mode(state, :atomic) do
      {:reply, :ok, remove_subscription(state, subscription)}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call(:close, _from, state) do
    {:stop, :normal, :ok, transition_closed(state, :closed)}
  end

  @impl true
  def handle_info({:tcp, socket, chunk}, %{socket: socket} = state) do
    state = %{state | buffer: state.buffer <> chunk}
    {:noreply, state |> drain_frames() |> rearm_socket()}
  end

  def handle_info({:tcp_closed, socket}, %{socket: socket} = state) do
    {:noreply, transition_closed(state, :closed)}
  end

  def handle_info({:tcp_error, socket, reason}, %{socket: socket} = state) do
    {:noreply, transition_closed(state, reason)}
  end

  def handle_info({:request_timeout, token}, %{request_waiter: %{token: token} = waiter} = state) do
    GenServer.reply(waiter.from, {:error, :timeout})
    state = %{state | request_waiter: nil}
    {:noreply, transition_closed(state, :timeout)}
  end

  def handle_info({:receive_timeout, token}, %{receive_waiter: %{token: token} = waiter} = state) do
    GenServer.reply(waiter.from, {:error, :timeout})
    {:noreply, %{state | receive_waiter: nil}}
  end

  def handle_info({:DOWN, monitor, :process, subscriber, _reason}, state) do
    subscriptions =
      Map.reject(state.subscriptions, fn {_subscription, entry} ->
        entry.monitor == monitor and entry.subscriber == subscriber
      end)

    {:noreply, %{state | subscriptions: subscriptions}}
  end

  def handle_info(:drain_buffer, state) do
    {:noreply, drain_frames(state)}
  end

  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    if state.socket, do: :gen_tcp.close(state.socket)
    :ok
  end

  defp validate_connect_timeout(timeout) when is_integer(timeout) and timeout > 0, do: :ok
  defp validate_connect_timeout(_timeout), do: {:error, :invalid_connect_timeout}

  defp handshake(socket, host, port, path, deadline) do
    key = :crypto.strong_rand_bytes(16) |> Base.encode64()

    request = [
      "GET #{path} HTTP/1.1\r\n",
      "Host: #{host}:#{port}\r\n",
      "Upgrade: websocket\r\n",
      "Connection: Upgrade\r\n",
      "Sec-WebSocket-Key: #{key}\r\n",
      "Sec-WebSocket-Version: 13\r\n",
      "\r\n"
    ]

    with :ok <- :gen_tcp.send(socket, request),
         {:ok, response, rest} <- recv_until_headers(socket, <<>>, deadline),
         :ok <- validate_handshake(response, key) do
      {:ok, rest}
    end
  end

  defp recv_until_headers(socket, acc, deadline) do
    with remaining when remaining > 0 <- deadline - System.monotonic_time(:millisecond) do
      case :binary.match(acc, "\r\n\r\n") do
        {index, 4} when index + 4 <= @max_frame_size ->
          header_size = index + 4
          <<headers::binary-size(header_size), rest::binary>> = acc
          {:ok, headers, rest}

        {_index, 4} ->
          {:error, :upgrade_headers_too_large}

        :nomatch when byte_size(acc) >= @max_frame_size ->
          {:error, :upgrade_headers_too_large}

        :nomatch ->
          case :gen_tcp.recv(socket, 0, remaining) do
            {:ok, chunk} -> recv_until_headers(socket, acc <> chunk, deadline)
            {:error, reason} -> {:error, reason}
          end
      end
    else
      _expired -> {:error, :timeout}
    end
  end

  defp validate_handshake(response, key) do
    accept = :crypto.hash(:sha, key <> @guid) |> Base.encode64()

    cond do
      not String.starts_with?(response, "HTTP/1.1 101") ->
        {:error, :websocket_upgrade_failed}

      not String.contains?(String.downcase(response), "upgrade: websocket") ->
        {:error, :missing_websocket_upgrade}

      not String.contains?(
        String.downcase(response),
        "sec-websocket-accept: #{String.downcase(accept)}"
      ) ->
        {:error, :bad_websocket_accept}

      true ->
        :ok
    end
  end

  defp stream_send(state, text) do
    with {:ok, state} <- enter_mode(state, :stream),
         :ok <- ensure_open(state) do
      case :gen_tcp.send(state.socket, encode_client_text_frame(text)) do
        :ok -> {:reply, :ok, state}
        {:error, reason} -> {:reply, {:error, reason}, transition_closed(state, reason)}
      end
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  defp enter_mode(%{mode: nil} = state, mode), do: {:ok, %{state | mode: mode}}
  defp enter_mode(%{mode: mode} = state, mode), do: {:ok, state}
  defp enter_mode(_state, _mode), do: {:error, :client_mode_conflict}

  defp ensure_open(%{socket: socket, closed_reason: nil}) when is_port(socket), do: :ok
  defp ensure_open(_state), do: {:error, :closed}

  defp ensure_request_available(%{request_waiter: nil}), do: :ok
  defp ensure_request_available(_state), do: {:error, :request_in_progress}

  defp receive_envelope(state, from, timeout) do
    case :queue.out(state.receive_queue) do
      {{:value, envelope}, queue} ->
        state = %{state | receive_queue: queue}
        {:reply, {:ok, envelope}, resume_input(state)}

      {:empty, _queue} when state.receive_waiter == nil ->
        token = make_ref()
        timer = Process.send_after(self(), {:receive_timeout, token}, timeout)
        waiter = %{from: from, timer: timer, token: token}
        state = %{state | receive_waiter: waiter}
        {:noreply, resume_input(state)}

      {:empty, _queue} ->
        {:reply, {:error, :receive_in_progress}, state}
    end
  end

  defp ensure_notification_type_available(state, type) do
    if MapSet.member?(state.notification_types, type) or
         MapSet.size(state.notification_types) < @max_notification_types do
      :ok
    else
      {:error, :too_many_notification_types}
    end
  end

  defp ensure_subscription_available(state, subscription) do
    if Map.has_key?(state.subscriptions, subscription),
      do: {:error, :subscription_conflict},
      else: :ok
  end

  defp drain_frames(%{closed_reason: reason} = state) when reason != nil, do: state

  defp drain_frames(state) do
    if stream_backpressured?(state), do: state, else: drain_next_frame(state)
  end

  defp drain_next_frame(state) do
    case parse_server_frame(state.buffer) do
      :more ->
        state

      {:ok, frame, rest} ->
        state = %{state | buffer: rest}

        case handle_server_frame(frame, state) do
          {:ok, state} -> drain_frames(state)
          {:close, reason, state} -> transition_closed(state, reason)
        end

      {:error, reason} ->
        transition_closed(state, {:protocol_error, reason})
    end
  end

  defp parse_server_frame(buffer) when byte_size(buffer) < 2, do: :more

  defp parse_server_frame(<<first, second, rest::binary>>) do
    fin? = (first &&& 0x80) == 0x80
    rsv = first &&& 0x70
    opcode = first &&& 0x0F
    masked? = (second &&& 0x80) == 0x80

    cond do
      rsv != 0 ->
        {:error, :reserved_bits}

      masked? ->
        {:error, :masked_server_frame}

      not fin? ->
        {:error, :fragmented_frame}

      opcode == 0x0 ->
        {:error, :fragmented_frame}

      true ->
        with {:ok, length, payload_and_rest} <- decode_server_length(second &&& 0x7F, rest),
             :ok <- validate_server_length(length),
             :ok <- validate_control_length(opcode, length),
             {:ok, payload, remaining} <- take_payload(payload_and_rest, length) do
          case opcode do
            0x1 -> {:ok, {:text, payload}, remaining}
            0x8 -> {:ok, {:close, payload}, remaining}
            0x9 -> {:ok, {:ping, payload}, remaining}
            0xA -> {:ok, {:pong, payload}, remaining}
            other -> {:error, {:unsupported_opcode, other}}
          end
        end
    end
  end

  defp decode_server_length(length, rest) when length < 126, do: {:ok, length, rest}

  defp decode_server_length(126, <<length::16, rest::binary>>), do: {:ok, length, rest}
  defp decode_server_length(126, _rest), do: :more

  defp decode_server_length(127, <<length::64, rest::binary>>), do: {:ok, length, rest}
  defp decode_server_length(127, _rest), do: :more

  defp validate_server_length(length) when length <= @max_frame_size, do: :ok
  defp validate_server_length(_length), do: {:error, :frame_too_large}

  defp validate_control_length(opcode, length)
       when opcode in [0x8, 0x9, 0xA] and length > 125,
       do: {:error, :control_frame_too_large}

  defp validate_control_length(_opcode, _length), do: :ok

  defp take_payload(rest, length) when byte_size(rest) >= length do
    <<payload::binary-size(length), remaining::binary>> = rest
    {:ok, payload, remaining}
  end

  defp take_payload(_rest, _length), do: :more

  defp handle_server_frame({:text, payload}, state) do
    case Jason.decode(payload) do
      {:ok, envelope} when is_map(envelope) -> {:ok, route_envelope(state, envelope)}
      _other -> {:close, {:protocol_error, :malformed_envelope}, state}
    end
  end

  defp handle_server_frame({:close, payload}, state) do
    _ = :gen_tcp.send(state.socket, encode_client_frame(0x8, payload))
    {:close, :closed, state}
  end

  defp handle_server_frame({:ping, payload}, state) do
    case :gen_tcp.send(state.socket, encode_client_frame(0xA, payload)) do
      :ok -> {:ok, state}
      {:error, reason} -> {:close, reason, state}
    end
  end

  defp handle_server_frame({:pong, _payload}, state), do: {:ok, state}

  defp route_envelope(state, %{"type" => type} = envelope) do
    matching =
      Enum.filter(state.subscriptions, fn {_subscription, entry} -> entry.type == type end)

    cond do
      matching != [] ->
        Enum.each(matching, fn {subscription, entry} ->
          send(entry.subscriber, {entry.tag, subscription, envelope})
        end)

        state

      MapSet.member?(state.notification_types, type) ->
        state

      true ->
        route_response(state, envelope)
    end
  end

  defp route_envelope(state, envelope), do: route_response(state, envelope)

  defp route_response(%{request_waiter: waiter} = state, envelope) when waiter != nil do
    Process.cancel_timer(waiter.timer)
    GenServer.reply(waiter.from, {:ok, envelope})
    %{state | request_waiter: nil}
  end

  defp route_response(%{receive_waiter: waiter} = state, envelope) when waiter != nil do
    Process.cancel_timer(waiter.timer)
    GenServer.reply(waiter.from, {:ok, envelope})
    %{state | receive_waiter: nil}
  end

  defp route_response(%{mode: :atomic, request_waiter: nil} = state, _envelope) do
    transition_closed(state, {:protocol_error, :unexpected_envelope})
  end

  defp route_response(state, envelope) do
    %{state | receive_queue: :queue.in(envelope, state.receive_queue)}
  end

  defp resume_input(state), do: state |> drain_frames() |> rearm_socket()

  defp rearm_socket(state) do
    if stream_backpressured?(state), do: state, else: do_rearm_socket(state)
  end

  defp do_rearm_socket(%{socket: socket, closed_reason: nil} = state) when is_port(socket) do
    case :inet.setopts(socket, active: :once) do
      :ok -> state
      {:error, reason} -> transition_closed(state, reason)
    end
  end

  defp do_rearm_socket(state), do: state

  defp stream_backpressured?(state) do
    state.mode in [nil, :stream] and state.receive_waiter == nil and
      not :queue.is_empty(state.receive_queue)
  end

  defp transition_closed(%{closed_reason: reason} = state, _new_reason) when reason != nil,
    do: state

  defp transition_closed(state, reason) do
    if state.socket, do: :gen_tcp.close(state.socket)
    reply_waiter(state.request_waiter, {:error, close_error(reason)})
    reply_waiter(state.receive_waiter, {:error, close_error(reason)})
    notify_closed(state.subscriptions, close_error(reason))

    %{
      state
      | socket: nil,
        buffer: <<>>,
        request_waiter: nil,
        receive_waiter: nil,
        subscriptions: %{},
        closed_reason: reason
    }
  end

  defp remove_subscription(state, subscription) do
    case Map.pop(state.subscriptions, subscription) do
      {nil, _subscriptions} ->
        state

      {entry, subscriptions} ->
        Process.demonitor(entry.monitor, [:flush])
        %{state | subscriptions: subscriptions}
    end
  end

  defp notify_closed(subscriptions, reason) do
    Enum.each(subscriptions, fn {subscription, entry} ->
      Process.demonitor(entry.monitor, [:flush])
      send(entry.subscriber, {entry.tag, subscription, {:closed, reason}})
    end)
  end

  defp reply_waiter(nil, _reply), do: :ok

  defp reply_waiter(waiter, reply) do
    Process.cancel_timer(waiter.timer)
    GenServer.reply(waiter.from, reply)
  end

  defp close_error(:closed), do: :closed
  defp close_error(reason), do: reason

  defp encode_client_text_frame(payload) do
    encode_client_frame(0x1, payload)
  end

  defp encode_client_frame(opcode, payload) do
    payload = IO.iodata_to_binary(payload)
    mask = :crypto.strong_rand_bytes(4)
    len = byte_size(payload)

    header =
      cond do
        len < 126 -> <<0x80 ||| opcode, 0x80 ||| len>>
        len < 65_536 -> <<0x80 ||| opcode, 0x80 ||| 126, len::16>>
        true -> <<0x80 ||| opcode, 0x80 ||| 127, len::64>>
      end

    masked =
      payload
      |> :binary.bin_to_list()
      |> Enum.with_index()
      |> Enum.map(fn {byte, index} -> bxor(byte, :binary.at(mask, rem(index, 4))) end)
      |> :binary.list_to_bin()

    [header, mask, masked]
  end
end
