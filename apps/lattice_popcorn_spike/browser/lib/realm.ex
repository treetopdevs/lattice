defmodule LatticeBrowser.Realm do
  @moduledoc """
  Bounded browser command interpreter, registered only at LatticeBrowser.Bridge.

  A crash ends this VM session instead of silently replacing its signing identity.
  Signed-echo keys are ephemeral and never returned across the bridge. Durable
  replica commands explicitly return a storage capsule to the trusted host. This
  API is component encapsulation, not protection from a browser owner/XSS.
  """
  use GenServer
  alias Lattice.{Canonical, Identity, Op}
  alias LatticeBrowser.Durable

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: LatticeBrowser.Bridge)

  @impl true
  def init(_opts) do
    {:ok,
     %{identity: Identity.generate("popcorn-spike"), tab: nil, phase: :new, seq: 0, durable: nil}}
  end

  @impl true
  def handle_call(command, _from, state) do
    {reply, next} = command(command, state)
    {:reply, reply, next}
  end

  defp command(
         %{"command" => "replica_restore", "capsule" => capsule} = cmd,
         %{durable: nil} = state
       )
       when map_size(cmd) == 2 do
    case Durable.restore(capsule) do
      {:ok, durable} -> durable_reply(durable, state)
      {:error, reason} -> {%{"ok" => false, "error" => Atom.to_string(reason)}, state}
    end
  end

  defp command(%{"command" => "replica_receive", "log" => log} = cmd, %{durable: durable} = state)
       when map_size(cmd) == 2 and not is_nil(durable) do
    case Durable.receive_log(durable, log) do
      {:ok, next} -> durable_reply(next, state)
      {:error, reason} -> {%{"ok" => false, "error" => Atom.to_string(reason)}, state}
    end
  end

  defp command(%{"command" => "replica_post", "text" => text} = cmd, %{durable: durable} = state)
       when map_size(cmd) == 2 and not is_nil(durable) do
    case Durable.post(durable, text) do
      {:ok, next, op} ->
        {reply, state} = durable_reply(next, state)
        {Map.put(reply, "op_id", op.id), state}

      {:error, reason} ->
        {%{"ok" => false, "error" => Atom.to_string(reason)}, state}
    end
  end

  defp command(%{"command" => "replica_upload"} = cmd, %{durable: durable} = state)
       when map_size(cmd) == 1 and not is_nil(durable) do
    {%{"ok" => true, "ops" => Durable.upload(durable)}, state}
  end

  defp command(%{"command" => "status"} = cmd, state) when map_size(cmd) == 1 do
    {%{
       "ok" => true,
       "phase" => Atom.to_string(state.phase),
       "tab_id" => state.tab,
       "public_key" => Base.encode64(state.identity.pub),
       "otp" => System.otp_release(),
       "elixir" => System.version(),
       "distributed" => Node.alive?(),
       "memory_bytes" => :erlang.memory(:total)
     }, state}
  end

  defp command(%{"command" => "connect"} = cmd, %{phase: :new} = state)
       when map_size(cmd) == 1 do
    {out(%{"type" => "hello", "identity" => %{"runtime" => "popcorn-otp"}}),
     %{state | phase: :connecting}}
  end

  defp command(%{"command" => "receive_server_event", "event" => event} = cmd, state)
       when map_size(cmd) == 2 and is_map(event) do
    case event do
      %{"type" => "welcome", "tab_id" => tab} when is_binary(tab) and byte_size(tab) <= 256 ->
        if state.phase == :connecting do
          {%{"ok" => true}, %{state | phase: :connected, tab: tab}}
        else
          invalid(state)
        end

      %{"type" => type}
      when type in [
             "grant",
             "call_result",
             "error",
             "snapshot",
             "presence",
             "server_event",
             "disconnect_result"
           ] ->
        {%{"ok" => true}, state}

      _ ->
        invalid(state)
    end
  end

  defp command(%{"command" => "request_capability"} = cmd, %{phase: :connected} = state)
       when map_size(cmd) == 1 do
    {out(%{"type" => "grant_request", "target" => "signed_echo"}), state}
  end

  defp command(
         %{"command" => "invoke", "cap_id" => cap, "message" => message} = cmd,
         %{phase: :connected} = state
       )
       when map_size(cmd) == 3 and (is_nil(cap) or (is_binary(cap) and byte_size(cap) <= 256)) and
              is_binary(message) and byte_size(message) <= 1024 do
    seq = state.seq + 1
    body = %{"message" => message, "tab_id" => state.tab, "sequence" => seq}
    op = Op.new(state.identity, "popcorn-spike", [], :command, body, cap: cap)

    proof = %{
      "body" => body,
      "cap" => cap,
      "author" => Base.encode64(op.author),
      "sig" => Base.encode64(op.sig),
      "id" => op.id,
      "canonical" => Base.encode64(Canonical.op_payload(op))
    }

    envelope = %{"type" => "call", "payload" => proof}
    envelope = if is_nil(cap), do: envelope, else: Map.put(envelope, "cap_id", cap)
    {out(envelope), %{state | seq: seq}}
  end

  defp command(%{"command" => "disconnect"} = cmd, state) when map_size(cmd) == 1 do
    {out(%{"type" => "disconnect"}), %{state | phase: :closed, tab: nil}}
  end

  defp command(_, state), do: invalid(state)

  defp durable_reply(durable, state) do
    {%{"ok" => true, "view" => Durable.view(durable), "capsule" => Durable.capsule(durable)},
     %{state | durable: durable}}
  end

  defp out(envelope), do: %{"ok" => true, "envelope" => envelope}
  defp invalid(state), do: {%{"ok" => false, "error" => "invalid_command"}, state}
end
