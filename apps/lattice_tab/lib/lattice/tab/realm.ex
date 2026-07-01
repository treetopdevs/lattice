defmodule Lattice.Tab.Realm do
  @moduledoc """
  In-tab BEAM realm. Pure `step/2` composes `Lattice.Tab.Protocol` (host-testable,
  no WASM); `run/0` (Task A3) is the AtomVM receive loop driving it via the Bridge.
  """
  alias Lattice.Tab.{Bridge, Codec, Protocol}

  @type step :: {Protocol.t() | nil, [map()], [map()]}

  @doc "Reduce one inbound message (boot control or server envelope) to {state, out, render}."
  @spec step(Protocol.t() | nil, map()) :: step()
  def step(_state, %{"__lattice__" => "boot", "client_id" => client_id}) do
    Protocol.hello(Protocol.init(client_id))
  end

  def step(%Protocol{} = state, envelope), do: Protocol.handle(state, envelope)

  @doc "Shape outbound envelopes + render intents into the promise-reply map."
  @spec reply([map()], [map()]) :: map()
  def reply(out, render), do: %{"out" => out, "render" => render}

  # --- WASM loop added in Task A3 ---

  @doc "AtomVM entry: register, beacon, then serve Module.call requests forever."
  @spec run() :: no_return()
  def run do
    Process.register(self(), :realm)
    Bridge.ready_beacon()
    loop(nil)
  end

  defp loop(state) do
    receive do
      {:emscripten, {:call, promise, msg}} ->
        {state, reply} = handle_call(state, msg)
        Bridge.resolve(promise, reply)
        loop(state)

      {:emscripten, {:cast, _msg}} ->
        # one-way path is unused in the request/response model; ignore.
        loop(state)

      _other ->
        loop(state)
    end
  end

  # decode -> step -> encode the {out, render} reply (no eval anywhere)
  defp handle_call(state, msg) do
    case Codec.decode(msg) do
      {:ok, inbound} ->
        {state, out, render} = step(state, inbound)
        {state, Codec.encode(reply(out, render))}

      {:error, _} ->
        {state, Codec.encode(reply([], [%{kind: "error", text: "malformed"}]))}
    end
  end
end
