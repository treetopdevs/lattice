defmodule Lattice.CarrierMembershipTest do
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Membership

  test "frontier is stable only after every current participant acknowledges it" do
    m =
      Membership.new(["a", "b", "c"])
      |> Membership.ack("a", ["f1", "f2"])
      |> Membership.ack("b", ["f2", "f1"])

    refute Membership.stable_frontier?(m, ["f1", "f2"])

    m = Membership.ack(m, "c", ["f1", "f2"])
    assert Membership.stable_frontier?(m, ["f2", "f1"])
  end

  test "leaving participant stops blocking future frontiers but is recorded" do
    m =
      Membership.new(["a", "b"])
      |> Membership.leave("b")
      |> Membership.ack("a", ["f"])

    assert Membership.stable_frontier?(m, ["f"])
    assert Membership.left(m) == MapSet.new(["b"])
  end

  test "an empty current membership is never GC-stable" do
    m = Membership.new(["a"]) |> Membership.leave("a")

    refute Membership.stable_frontier?(m, ["f"])
  end

  test "left participants can rejoin but must acknowledge the frontier again" do
    m =
      Membership.new(["a", "b"])
      |> Membership.ack("a", ["old"])
      |> Membership.ack("b", ["old"])
      |> Membership.leave("b")
      |> Membership.ack("a", ["new"])

    assert Membership.stable_frontier?(m, ["new"])

    m = Membership.join(m, "b")

    refute Membership.stable_frontier?(m, ["new"])
    assert Membership.left(m) == MapSet.new()

    m = Membership.ack(m, "b", ["new"])
    assert Membership.stable_frontier?(m, ["new"])
  end
end
