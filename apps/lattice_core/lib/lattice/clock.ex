defmodule Lattice.Clock do
  @moduledoc """
  Deterministic logical-tick utility for tests and demos.

  The value moves only when a caller explicitly invokes `advance/1`, `set/1`, or
  `reset/0`. No operation-authoring, reducer, heartbeat, succession, or carrier path
  reads `now/0` as authority input. Legacy authority operations instead carry
  caller-supplied `at_tick` values as replayable body data, while opt-in witnessed
  succession is authorized by a genesis-pinned certificate and has no clock input.
  Reduction therefore remains a pure function of the operation set.
  """

  use Agent

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(_opts \\ []) do
    Agent.start_link(fn -> 0 end, name: __MODULE__)
  end

  @doc "Current logical tick."
  @spec now() :: non_neg_integer()
  def now, do: Agent.get(__MODULE__, & &1)

  @doc "Advance the logical clock by `ticks` (default 1) and return the new value."
  @spec advance(non_neg_integer()) :: non_neg_integer()
  def advance(ticks \\ 1) when is_integer(ticks) and ticks >= 0 do
    Agent.get_and_update(__MODULE__, fn tick -> {tick + ticks, tick + ticks} end)
  end

  @doc "Set the logical clock to an explicit value (test helper)."
  @spec set(non_neg_integer()) :: :ok
  def set(value) when is_integer(value) and value >= 0 do
    Agent.update(__MODULE__, fn _ -> value end)
  end

  @doc "Reset the clock to 0."
  @spec reset() :: :ok
  def reset, do: set(0)
end
