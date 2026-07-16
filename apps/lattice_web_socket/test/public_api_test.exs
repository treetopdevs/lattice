defmodule LatticeWebSocket.PublicAPITest do
  use ExUnit.Case, async: true

  test "exports the atomic client and carrier subscription APIs" do
    assert_exported(Lattice.Transport.WebSocket.Client,
      request_envelope: 3,
      subscribe: 4,
      unsubscribe: 2
    )

    assert_exported(Lattice.Carrier.WebSocket, subscribe: 2, subscribe: 3, unsubscribe: 1)
  end

  defp assert_exported(module, exports) do
    Code.ensure_loaded!(module)

    Enum.each(exports, fn {name, arity} ->
      assert function_exported?(module, name, arity),
             "expected #{inspect(module)}.#{name}/#{arity} to be public"
    end)
  end
end
