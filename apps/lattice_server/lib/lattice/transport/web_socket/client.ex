defmodule Lattice.Transport.WebSocket.Client do
  @moduledoc """
  Minimal real WebSocket client used by tests and the deterministic POC demo.

  This speaks the WebSocket wire protocol over `:gen_tcp`. It is intentionally
  small, but it is not an in-process transport shortcut: messages cross the same
  Cowboy WebSocket boundary as a browser tab.
  """

  use GenServer
  import Bitwise

  alias Lattice.Transport.WebSocket.Envelope

  @guid "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def connect(opts) do
    with {:ok, pid} <- start_link(opts), do: {:ok, pid}
  end

  def send_envelope(pid, envelope) when is_map(envelope) do
    GenServer.call(pid, {:send, envelope})
  end

  def recv_envelope(pid, timeout \\ 5_000) do
    GenServer.call(pid, {:recv, timeout}, timeout + 500)
  end

  def close(pid), do: GenServer.call(pid, :close)

  @impl true
  def init(opts) do
    host = Keyword.get(opts, :host, "localhost")
    port = Keyword.fetch!(opts, :port)
    path = Keyword.get(opts, :path, "/ws")

    with {:ok, socket} <-
           :gen_tcp.connect(String.to_charlist(host), port, [:binary, active: false, packet: :raw]),
         :ok <- handshake(socket, host, port, path) do
      {:ok, %{socket: socket}}
    else
      {:error, reason} -> {:stop, reason}
    end
  end

  @impl true
  def handle_call({:send, envelope}, _from, state) do
    reply = :gen_tcp.send(state.socket, encode_client_text_frame(Envelope.encode(envelope)))
    {:reply, reply, state}
  end

  def handle_call({:recv, timeout}, _from, state) do
    reply =
      with {:ok, payload} <- read_server_frame(state.socket, timeout),
           {:ok, envelope} <- Jason.decode(payload) do
        {:ok, envelope}
      end

    {:reply, reply, state}
  end

  def handle_call(:close, _from, state) do
    :gen_tcp.close(state.socket)
    {:stop, :normal, :ok, state}
  end

  defp handshake(socket, host, port, path) do
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
         {:ok, response} <- recv_until_headers(socket, ""),
         :ok <- validate_handshake(response, key) do
      :ok
    end
  end

  defp recv_until_headers(socket, acc) do
    if String.contains?(acc, "\r\n\r\n") do
      {:ok, acc}
    else
      case :gen_tcp.recv(socket, 0, 5_000) do
        {:ok, chunk} -> recv_until_headers(socket, acc <> chunk)
        {:error, reason} -> {:error, reason}
      end
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

  defp encode_client_text_frame(payload) do
    payload = IO.iodata_to_binary(payload)
    mask = :crypto.strong_rand_bytes(4)
    len = byte_size(payload)

    header =
      cond do
        len < 126 -> <<0x81, 0x80 ||| len>>
        len < 65_536 -> <<0x81, 0x80 ||| 126, len::16>>
        true -> <<0x81, 0x80 ||| 127, len::64>>
      end

    masked =
      payload
      |> :binary.bin_to_list()
      |> Enum.with_index()
      |> Enum.map(fn {byte, index} -> bxor(byte, :binary.at(mask, rem(index, 4))) end)
      |> :binary.list_to_bin()

    [header, mask, masked]
  end

  defp read_server_frame(socket, timeout) do
    with {:ok, <<fin_opcode, second>>} <- :gen_tcp.recv(socket, 2, timeout),
         {:ok, len} <- read_payload_length(socket, second, timeout),
         {:ok, payload} <- :gen_tcp.recv(socket, len, timeout) do
      case fin_opcode &&& 0x0F do
        0x1 -> {:ok, payload}
        0x8 -> {:error, :closed}
        opcode -> {:error, {:unsupported_opcode, opcode}}
      end
    end
  end

  defp read_payload_length(socket, second, timeout) do
    case second &&& 0x7F do
      len when len < 126 ->
        {:ok, len}

      126 ->
        with {:ok, <<len::16>>} <- :gen_tcp.recv(socket, 2, timeout), do: {:ok, len}

      127 ->
        with {:ok, <<len::64>>} <- :gen_tcp.recv(socket, 8, timeout), do: {:ok, len}
    end
  end
end
