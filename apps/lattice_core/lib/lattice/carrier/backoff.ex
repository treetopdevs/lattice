defmodule Lattice.Carrier.Backoff do
  @moduledoc "Deterministic capped exponential backoff for reconnect loops."

  @enforce_keys [:base_ms, :max_ms, :jitter_ms, :seed]
  defstruct [:base_ms, :max_ms, :jitter_ms, :seed]

  @type t :: %__MODULE__{
          base_ms: pos_integer(),
          max_ms: pos_integer(),
          jitter_ms: non_neg_integer(),
          seed: binary()
        }

  @spec new(keyword()) :: t()
  def new(opts) do
    %__MODULE__{
      base_ms: Keyword.fetch!(opts, :base_ms),
      max_ms: Keyword.fetch!(opts, :max_ms),
      jitter_ms: Keyword.get(opts, :jitter_ms, 0),
      seed: Keyword.fetch!(opts, :seed)
    }
  end

  @spec reset_attempt() :: 0
  def reset_attempt, do: 0

  @spec delay_ms(t(), non_neg_integer()) :: non_neg_integer()
  def delay_ms(%__MODULE__{} = backoff, attempt) when attempt >= 0 do
    raw = min(backoff.max_ms, backoff.base_ms * Integer.pow(2, attempt))
    max(0, raw + jitter(backoff.seed, attempt, backoff.jitter_ms))
  end

  defp jitter(_seed, _attempt, 0), do: 0

  defp jitter(seed, attempt, bound) do
    bytes = :crypto.hash(:sha256, "#{seed}:#{attempt}")
    <<n::32, _::binary>> = bytes
    rem(n, bound * 2 + 1) - bound
  end
end
