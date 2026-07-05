defmodule Lattice2.MaterializerTest do
  @moduledoc """
  Direct unit tests for `Lattice.Materializer` (plan 006): `whereis/1` miss/hit,
  `query/2` not-live vs live, and `child_spec/1`. Focused on the Materializer's
  own surface — the full lifecycle lives in `lifecycle_test.exs`.
  """
  use ExUnit.Case, async: false

  alias Lattice.Demo.Thread
  alias Lattice.{Materializer, Registry, Sim}

  @replica "replica:thread:mat"

  setup do
    Lattice.reset!()
    on_exit(fn -> Lattice.reset!() end)
    :ok
  end

  # Build a base log with genesis + one authored post, hosted (dormant) on one realm.
  defp hosted do
    sim = Sim.new(Thread, @replica, ["server"], seed: "mat")
    {sim, _g} = Sim.create_replica(sim, "server")
    {sim, _} = Sim.command(sim, "server", :post, ["hello"])

    :ok = Registry.host(Sim.identity(sim, "server"), Thread, @replica, Sim.log(sim, "server"))
    sim
  end

  test "whereis/1 returns nil for an unknown {realm, replica} key" do
    assert Materializer.whereis({"nowhere", @replica}) == nil
  end

  test "query/2 returns {:error, :not_live} when no live process exists" do
    _sim = hosted()
    assert Materializer.query({"server", @replica}, {:get, :messages}) == {:error, :not_live}
  end

  test "after materialize, whereis/1 returns a live pid and query/2 answers" do
    _sim = hosted()
    {:ok, _state} = Registry.materialize("server", @replica)

    pid = Materializer.whereis({"server", @replica})
    assert is_pid(pid)
    assert Process.alive?(pid)

    assert Materializer.query({"server", @replica}, {:get, :messages}) == ["hello"]
  end

  test "child_spec/1 returns a temporary child keyed by {module, key}" do
    key = {"server", @replica}
    spec = Materializer.child_spec(key)

    assert spec.id == {Materializer, key}
    assert spec.start == {Materializer, :start_link, [key]}
    assert spec.restart == :temporary
  end
end
