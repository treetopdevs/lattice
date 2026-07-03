defmodule Lattice2.PromiseTest do
  @moduledoc """
  Direct unit tests for `Lattice.Promise` (plan 006): pins the struct contract
  (`@enforce_keys`) that `Registry.call/4` and `await/3` depend on.
  """
  use ExUnit.Case, async: true

  alias Lattice.Promise

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
end
