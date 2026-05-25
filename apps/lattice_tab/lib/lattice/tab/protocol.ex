defmodule Lattice.Tab.Protocol do
  @moduledoc """
  Pure protocol state machine for the AtomVM tab realm.

  No process, no I/O, no JSON — it operates on decoded string-keyed maps
  (envelopes) and returns `{state, [outbound_envelope], [render_intent]}`.
  Runs identically on the host BEAM (ExUnit) and inside AtomVM-WASM, and
  stays inside AtomVM's subset (no bitstrings, big integers, or ETS).

  This module owns 100% of core-demo protocol *semantics*; the shell is
  authority-blind I/O only.
  """

  @enforce_keys [:client_id]
  defstruct client_id: nil,
            tab_id: nil,
            session_id: nil,
            caps: %{},
            status: :init

  @type envelope :: %{optional(String.t()) => term()}
  @type render_intent :: %{required(:kind) => String.t(), optional(atom()) => term()}
  @type t :: %__MODULE__{
          client_id: String.t(),
          tab_id: String.t() | nil,
          session_id: String.t() | nil,
          caps: %{optional(String.t()) => String.t()},
          status: atom()
        }
  @type step :: {t(), [envelope()], [render_intent()]}

  @spec init(String.t()) :: t()
  def init(client_id) when is_binary(client_id) do
    %__MODULE__{client_id: client_id, status: :connecting}
  end

  @doc "Boot envelope. The shell supplies `client_id` via `Bridge.start/2`."
  @spec hello(t()) :: step()
  def hello(%__MODULE__{client_id: client_id} = state) do
    envelope = %{
      "type" => "hello",
      "client_id" => client_id,
      "identity" => %{"surface" => "atomvm-tab", "client_id" => client_id}
    }

    {state, [envelope], [%{kind: "status", text: "connecting"}]}
  end

  @doc "Reduce one inbound envelope into new state + outbound envelopes + render-intents."
  @spec handle(t(), envelope()) :: step()
  def handle(%__MODULE__{} = state, %{"type" => "welcome"} = env) do
    state = %{
      state
      | tab_id: env["tab_id"],
        session_id: env["session_id"],
        client_id: env["client_id"] || state.client_id,
        status: :online
    }

    {state, [%{"type" => "state_request"}],
     [%{kind: "status", text: "connected", tab_id: state.tab_id}]}
  end

  def handle(%__MODULE__{} = state, %{"type" => "grant", "cap" => %{"id" => cap_id}}) do
    {%{state | caps: Map.put(state.caps, "echo", cap_id)}, [],
     [%{kind: "cap", text: "granted", cap_id: cap_id}]}
  end
end
