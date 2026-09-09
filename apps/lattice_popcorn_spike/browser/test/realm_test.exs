defmodule LatticeBrowser.RealmTest do
  use ExUnit.Case, async: false

  defp call(pid, cmd), do: GenServer.call(pid, cmd)

  test "bounded ingress signs the server's exact canonical bytes without releasing keys" do
    {:ok, pid} = GenServer.start_link(LatticeBrowser.Realm, [])
    on_exit(fn -> if Process.alive?(pid), do: GenServer.stop(pid) end)

    assert %{"ok" => false} =
             call(pid, %{"command" => "invoke", "cap_id" => "x", "message" => "early"})

    assert %{"envelope" => %{"type" => "hello"}} = call(pid, %{"command" => "connect"})

    assert %{"ok" => true} =
             call(pid, %{
               "command" => "receive_server_event",
               "event" => %{"type" => "welcome", "tab_id" => "tab-test"}
             })

    assert %{"ok" => false} =
             call(pid, %{
               "command" => "invoke",
               "cap_id" => "x",
               "message" => "x",
               "target" => "kernel"
             })

    assert %{"ok" => false} =
             call(pid, %{
               "command" => "invoke",
               "cap_id" => "x",
               "message" => String.duplicate("x", 1025)
             })

    assert %{"ok" => false} = call(pid, %{"command" => "rpc", "target" => "kernel"})

    for cap <- [nil, "forged", "real-cap"] do
      %{"envelope" => envelope} =
        call(pid, %{"command" => "invoke", "cap_id" => cap, "message" => "hello"})

      proof = envelope["payload"]
      pub = Base.decode64!(proof["author"])
      bytes = Lattice.Canonical.op_bytes("popcorn-spike", pub, [], :command, proof["body"], cap)
      assert bytes == Base.decode64!(proof["canonical"])
      assert Lattice.Identity.verify(pub, bytes, Base.decode64!(proof["sig"]))
      refute Lattice.Identity.verify(pub, bytes <> "tampered", Base.decode64!(proof["sig"]))
      refute Map.has_key?(proof, "priv")
      assert Map.has_key?(envelope, "cap_id") == not is_nil(cap)
    end

    assert %{"ok" => true} = call(pid, %{"command" => "disconnect"})
    assert %{"ok" => false} = call(pid, %{"command" => "request_capability"})
  end

  test "new realm uses fresh identity and large integers preserve canonical bytes" do
    {:ok, a} = GenServer.start_link(LatticeBrowser.Realm, [])
    {:ok, b} = GenServer.start_link(LatticeBrowser.Realm, [])

    assert call(a, %{"command" => "status"})["public_key"] !=
             call(b, %{"command" => "status"})["public_key"]

    assert Lattice.Canonical.term(18_446_744_073_709_551_615) ==
             <<27, 255, 255, 255, 255, 255, 255, 255, 255>>

    GenServer.stop(a)
    GenServer.stop(b)
  end
end
