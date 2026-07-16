defmodule LatticeCarrierServer.PublicAPITest do
  use ExUnit.Case, async: true

  test "exports the durable holder subscription APIs" do
    Code.ensure_loaded!(LatticeCarrierServer.Holder)

    for {name, arity} <- [subscribe: 2, acknowledge: 3, unsubscribe: 2] do
      assert function_exported?(LatticeCarrierServer.Holder, name, arity),
             "expected LatticeCarrierServer.Holder.#{name}/#{arity} to be public"
    end
  end
end
