defmodule Lattice.Cap.Session do
  @moduledoc """
  Tiny runtime session capability automaton.

  A cap may carry a protocol state machine such as
  `ready --authorize--> authorized --capture--> closed`. `CapStore` advances the
  state during authorization before the gateway forwards the message.
  """

  @enforce_keys [:state, :transitions]
  defstruct [:state, :transitions, history: []]

  @type t :: %__MODULE__{
          state: atom(),
          transitions: %{optional(atom()) => %{optional(atom()) => atom()}},
          history: [atom()]
        }

  def new(%__MODULE__{} = session), do: session

  def new(opts) when is_list(opts) do
    new(Map.new(opts))
  end

  def new(%{state: state, transitions: transitions}) do
    %__MODULE__{state: state, transitions: normalize_transitions(transitions)}
  end

  def advance(nil, _payload), do: {:ok, nil}

  def advance(%__MODULE__{} = session, payload) do
    with {:ok, step} <- step_from(payload),
         {:ok, next_state} <- next_state(session, step) do
      {:ok, %{session | state: next_state, history: session.history ++ [step]}}
    end
  end

  defp step_from(payload) when is_map(payload) do
    case fetch_payload(payload, [:session_step, "session_step", :op, "op"]) do
      {:ok, step} when is_atom(step) -> {:ok, step}
      {:ok, step} when is_binary(step) -> {:ok, String.to_atom(step)}
      _ -> {:error, :session_step_required}
    end
  end

  defp step_from(_payload), do: {:error, :session_step_required}

  defp next_state(%__MODULE__{state: state, transitions: transitions}, step) do
    case get_in(transitions, [state, step]) do
      nil -> {:error, {:session_step_not_allowed, state, step}}
      next -> {:ok, next}
    end
  end

  defp normalize_transitions(transitions) do
    Map.new(transitions, fn {from, edges} ->
      {normalize_atom(from),
       Map.new(edges, fn {step, to} -> {normalize_atom(step), normalize_atom(to)} end)}
    end)
  end

  defp normalize_atom(value) when is_atom(value), do: value
  defp normalize_atom(value) when is_binary(value), do: String.to_atom(value)

  defp fetch_payload(payload, keys) do
    Enum.find_value(keys, :error, fn key ->
      if Map.has_key?(payload, key), do: {:ok, Map.fetch!(payload, key)}
    end)
  end
end
