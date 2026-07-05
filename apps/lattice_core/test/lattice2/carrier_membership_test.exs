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
end
