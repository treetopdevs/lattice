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

  test "jitter never makes a sleep delay negative" do
    b = Backoff.new(base_ms: 1, max_ms: 1, jitter_ms: 100, seed: "seed0")

    assert Backoff.delay_ms(b, 0) == 0
  end

  test "jitter never pushes a delay above the configured cap" do
    b = Backoff.new(base_ms: 1, max_ms: 1, jitter_ms: 100, seed: "cap-probe")

    assert Enum.all?(0..20, &(Backoff.delay_ms(b, &1) <= 1))
  end

  test "large attempts are capped before exponentiation" do
    b = Backoff.new(base_ms: 1, max_ms: Integer.pow(2, 100), jitter_ms: 0, seed: "peer-a")

    assert Backoff.delay_ms(b, 64) == Backoff.delay_ms(b, 63)
  end
end
