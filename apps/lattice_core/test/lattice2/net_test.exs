defmodule Lattice2.NetTest do
  @moduledoc """
  Direct unit tests for `Lattice.Net` (plan 006): partition/heal symmetry,
  queue-holds-while-partitioned, seeded delivery determinism, and `pending/1`
  accounting. These pin the simulated-carrier contract a real transport
  (plan 010) must match.
  """
  use ExUnit.Case, async: true

  alias Lattice.Net

  test "partition cuts the link symmetrically and heal restores it" do
    net = Net.new()
    assert Net.connected?(net, "a", "b")
    refute Net.partitioned?(net, "a", "b")

    net = Net.partition(net, "a", "b")
    refute Net.connected?(net, "a", "b")
    refute Net.connected?(net, "b", "a")
    assert Net.partitioned?(net, "a", "b")
    assert Net.partitioned?(net, "b", "a")

    # Heal given in the opposite direction still restores the same link.
    net = Net.heal(net, "b", "a")
    assert Net.connected?(net, "a", "b")
    assert Net.connected?(net, "b", "a")
    refute Net.partitioned?(net, "a", "b")
  end

  test "enqueue holds a message while partitioned; drain delivers it only after heal" do
    net =
      Net.new()
      |> Net.partition("a", "b")
      |> Net.enqueue("a", "b", :hello)

    {net, delivered} = Net.drain(net)
    assert delivered == []
    assert Net.pending(net) == 1

    net = Net.heal(net, "a", "b")
    {net, delivered} = Net.drain(net)
    assert [%{from: "a", to: "b", payload: :hello}] = delivered
    assert Net.pending(net) == 0
  end

  test "drain delivers connected messages and leaves partitioned ones queued" do
    net =
      Net.new()
      |> Net.partition("a", "b")
      |> Net.enqueue("a", "b", :held)
      |> Net.enqueue("a", "c", :goes)
      |> Net.enqueue("c", "b", :also_goes)

    {net, delivered} = Net.drain(net)
    assert delivered |> Enum.map(& &1.payload) |> Enum.sort() == [:also_goes, :goes]
    assert Net.pending(net) == 1

    {net, held} = net |> Net.heal("a", "b") |> Net.drain()
    assert [%{from: "a", to: "b", payload: :held}] = held
    assert Net.pending(net) == 0
  end

  test "same seed + same enqueue order yields an identical delivery order" do
    payloads = Enum.map(1..10, &{:msg, &1})

    build = fn seed ->
      Enum.reduce(payloads, Net.new(seed: seed), fn p, net ->
        Net.enqueue(net, "a", "b", p)
      end)
    end

    {_net1, d1} = Net.drain(build.(42))
    {_net2, d2} = Net.drain(build.(42))
    assert d1 == d2

    # A different seed still delivers everything exactly once.
    {_net3, d3} = Net.drain(build.(7))
    assert d3 |> Enum.map(& &1.payload) |> Enum.sort() == Enum.sort(payloads)
  end
end
