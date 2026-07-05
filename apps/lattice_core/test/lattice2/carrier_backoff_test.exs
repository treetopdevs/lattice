defmodule Lattice.CarrierBackoffTest do
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Backoff

  test "capped exponential delays are deterministic for a seed" do
    b = Backoff.new(base_ms: 100, max_ms: 1_000, jitter_ms: 25, seed: "peer-a")

    assert Enum.map(0..5, &Backoff.delay_ms(b, &1)) == Enum.map(0..5, &Backoff.delay_ms(b, &1))
    assert Backoff.delay_ms(b, 0) in 75..125
    assert Backoff.delay_ms(b, 5) in 975..1_025
  end

  test "reset brings delay back to first attempt" do
    b = Backoff.new(base_ms: 50, max_ms: 500, jitter_ms: 0, seed: "peer-a")

    assert Backoff.delay_ms(b, 0) == 50
    assert Backoff.delay_ms(b, 4) == 500
    assert Backoff.delay_ms(b, Backoff.reset_attempt()) == 50
  end
end
