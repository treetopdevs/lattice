defmodule Lattice2.PromiseTest do
  @moduledoc """
  Direct unit tests for `Lattice.Promise` (plan 006): pins the struct contract
  (`@enforce_keys`) that `Registry.call/4` and `await/3` depend on.
  """
  use ExUnit.Case, async: false

  alias Lattice.{Log, Op, Promise, Registry, Sim}
  alias Lattice.Carrier.Wire
  alias Lattice.Demo.Thread

  @replica "replica:thread:promise"

  test "builds with all enforced keys" do
    promise = %Promise{ref: "ref-1", replica: "replica:thread:x", target: "server", from: "tab"}

    assert promise.ref == "ref-1"
    assert promise.replica == "replica:thread:x"
    assert promise.target == "server"
    assert promise.from == "tab"
  end

  test "omitting an enforced key raises" do
    assert_raise ArgumentError, fn -> struct!(Promise, %{}) end

    assert_raise ArgumentError, fn ->
      struct!(Promise, %{ref: "ref-1", replica: "replica:thread:x", target: "server"})
    end
  end

  describe "await/3 with an unrepresentable result" do
    setup do
      Lattice.reset!()
      on_exit(fn -> Lattice.reset!() end)
      :ok
    end

    defp hosted(posts) do
      sim = Sim.new(Thread, @replica, ["server", "tab"], seed: "promise")
      {sim, _} = Sim.create_replica(sim, "server")

      sim =
        Enum.reduce(posts, sim, fn post, sim ->
          {sim, _} = Sim.command(sim, "server", :post, [post])
          sim
        end)

      sim = Sim.sync_all(sim)
      base = Sim.log(sim, "server")
      :ok = Registry.host(Sim.identity(sim, "server"), Thread, @replica, base)
      :ok = Registry.host(Sim.identity(sim, "tab"), Thread, @replica, base)
      sim
    end

    defp response_ops(log, ref) do
      for %Op{kind: :inbox, body: body} = op <- Map.values(Log.ops(log)),
          is_tuple(body) and elem(body, 0) == :response and elem(body, 1) == ref,
          do: op
    end

    test "returns a definite refusal, once, and an ordinary result still resolves" do
      off_vocabulary =
        String.to_atom("promise_test_unlisted_#{System.unique_integer([:positive])}")

      hosted(["hello", off_vocabulary])

      {:ok, bad} = Registry.call("tab", "server", @replica, {:get, :messages})
      assert Registry.await("tab", @replica, bad) == :pending

      {:ok, _} = Registry.materialize("server", @replica)
      :ok = Registry.sync("server", "tab", @replica)

      assert Registry.await("tab", @replica, bad) == {:error, :unrepresentable_result}

      # The refusal op travels in the requester's log and is a wire-admissible frame.
      assert [%Op{body: {:response, ref}} = refusal] =
               response_ops(Registry.log("tab", @replica), bad.ref)

      assert ref == bad.ref
      assert {:ok, wire} = Wire.encode_op_checked(refusal)
      assert {:ok, ^refusal} = Wire.decode_op(wire)

      # Re-materializing does not author a second response.
      :ok = Registry.go_dormant("server", @replica)
      {:ok, _} = Registry.materialize("server", @replica)
      assert [_] = response_ops(Registry.log("server", @replica), bad.ref)
    end

    test "a request whose ref is nil or false is answered once, not on every materialization" do
      sim = hosted(["hello"])
      Lattice.reset!()

      base =
        Enum.reduce([nil, false], Sim.log(sim, "server"), fn ref, log ->
          {:ok, req} =
            Op.authored(
              Sim.identity(sim, "tab"),
              log.replica,
              Log.frontier(log),
              :inbox,
              {:request, ref, "server", :state}
            )

          Log.append!(log, req)
        end)

      :ok = Registry.host(Sim.identity(sim, "server"), Thread, @replica, base)

      for _ <- 1..3 do
        {:ok, _} = Registry.materialize("server", @replica)
        :ok = Registry.go_dormant("server", @replica)
      end

      log = Registry.log("server", @replica)
      assert [_] = response_ops(log, nil)
      assert [_] = response_ops(log, false)
    end

    test "positive control: an ordinary result still resolves to {:ok, value}" do
      hosted(["hello", "world"])
      {:ok, promise} = Registry.call("tab", "server", @replica, {:get, :messages})
      {:ok, _} = Registry.materialize("server", @replica)
      :ok = Registry.sync("server", "tab", @replica)

      assert {:ok, ["hello", "world"]} = Registry.await("tab", @replica, promise)
    end
  end
end
