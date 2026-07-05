defmodule Lattice2.ClockTest do
  @moduledoc """
  Direct unit tests for `Lattice.Clock` (plan 006): the global logical tick
  source feeding succession dormancy. Global Agent, so `async: false` with a
  reset in setup.
  """
  use ExUnit.Case, async: false

  alias Lattice.Clock

  setup do
    Clock.reset()
    on_exit(fn -> Clock.reset() end)
    :ok
  end

  test "now/0 is 0 after reset" do
    assert Clock.now() == 0
  end

  test "advance/1 increments by the given amount and returns the new value" do
    assert Clock.advance() == 1
    assert Clock.advance(3) == 4
    assert Clock.now() == 4
  end

  test "advance is monotonic across calls" do
    a = Clock.advance()
    b = Clock.advance()
    assert b > a
    assert Clock.now() == b
  end

  test "set/1 overrides the tick and reset/0 returns it to 0" do
    :ok = Clock.set(41)
    assert Clock.now() == 41
    assert Clock.advance() == 42

    :ok = Clock.reset()
    assert Clock.now() == 0
  end
end
