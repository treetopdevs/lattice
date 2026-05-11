defmodule LatticeServer.RateLimiterTest do
  use ExUnit.Case, async: false

  test "limits repeated hits for the same key within the window" do
    key = {:test, System.unique_integer([:positive])}

    assert LatticeServer.RateLimiter.allow?(key, limit: 1, window_ms: 1_000)
    refute LatticeServer.RateLimiter.allow?(key, limit: 1, window_ms: 1_000)
  end
end
