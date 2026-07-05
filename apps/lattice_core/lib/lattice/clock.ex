defmodule Lattice.Clock do
  @moduledoc """
  Logical tick source, advanced explicitly (design invariant 5: no wall clocks).

  Time in Lattice 2.0 is a monotonically increasing integer that only moves when a
  test or the demo calls `advance/1`. `Process.sleep`-based semantics are never
  used. The clock matters for exactly one thing: deciding when a dormant authority
  holder has been silent long enough for succession to fire (behavior 15). Ops that
  need a tick (succession, dormancy markers) read `now/0` once and embed the value
  in their body, so reduction stays a pure function of the op set rather than of
  live clock state.
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
