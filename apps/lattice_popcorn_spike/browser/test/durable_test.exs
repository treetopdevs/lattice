defmodule LatticeBrowser.DurableTest do
  use ExUnit.Case, async: true
  alias Lattice.{Authority, BrowserLogStore, Identity, Log, Op}
  alias Lattice.Authority.Delegation
  alias LatticeBrowser.Durable

  defp fixture do
    root = Identity.generate("root")
    replica = Authority.bind_replica("browser-demo", root.pub)
    g = Delegation.genesis(root, replica, ops: [:post], roles: [])
    genesis = Op.new(root, replica, [], :authority, {:genesis, g, %{}})
    log = Log.append!(Log.new(replica), genesis)
    {:ok, a} = Durable.restore(nil)
    {:ok, b} = Durable.restore(nil)

    {log, grants} =
      Enum.reduce([a, b], {log, []}, fn state, {log, grants} ->
        d = Delegation.new(root, replica, state.identity.pub, ops: [:post], parent_id: g.id)
        op = Op.new(root, replica, Log.frontier(log), :authority, {:grant, d})
        {Log.append!(log, op), grants ++ [d]}
      end)

    {:ok, a} = Durable.receive_log(a, BrowserLogStore.dump_payload(log))
    {:ok, b} = Durable.receive_log(b, BrowserLogStore.dump_payload(log))
    {root, a, b, grants}
  end

  test "independent signed offline writes survive restore and converge despite reordered duplicates" do
    {_, a, b, _} = fixture()
    {:ok, a, _} = Durable.post(a, "alpha")
    {:ok, b, _} = Durable.post(b, "beta")
    {:ok, restored} = Durable.restore(Durable.capsule(a))
    assert restored.identity == a.identity
    payload = BrowserLogStore.dump_payload(b.log)
    payload = Map.update!(payload, "ops", &(Enum.reverse(&1) ++ &1))
    {:ok, a} = Durable.receive_log(restored, payload)
    {:ok, b} = Durable.receive_log(b, BrowserLogStore.dump_payload(a.log))
    assert Durable.view(a)["notes"] == Durable.view(b)["notes"]
    assert Enum.sort(Durable.view(a)["notes"]) == ["alpha", "beta"]
    assert Durable.view(a)["op_ids"] == Durable.view(b)["op_ids"]
  end

  test "concurrent offline write becomes revoked audit evidence; observed revoke refuses new write" do
    {root, a, b, [grant | _]} = fixture()
    {:ok, a, before} = Durable.post(a, "before revocation")
    {:ok, b} = Durable.receive_log(b, BrowserLogStore.dump_payload(a.log))
    revoke = Op.new(root, b.log.replica, Log.frontier(b.log), :authority, {:revoke, grant.id})
    b = %{b | log: Log.append!(b.log, revoke)}
    {:ok, a, stale} = Durable.post(a, "stale offline write")
    {:ok, b} = Durable.receive_log(b, BrowserLogStore.dump_payload(a.log))
    {:ok, a} = Durable.receive_log(a, BrowserLogStore.dump_payload(b.log))
    assert Durable.view(a)["rejected"][stale.id] == "revoked_capability"
    refute Map.has_key?(Durable.view(a)["rejected"], before.id)
    assert Durable.view(a)["notes"] == ["before revocation"]
    assert {:error, :revoked_capability} = Durable.post(a, "after revocation")
    {:ok, restored} = Durable.restore(Durable.capsule(a))
    assert Durable.view(restored) == Durable.view(a)
  end

  test "corrupt storage and changed replica roots fail closed" do
    {_, a, _, _} = fixture()
    bad = put_in(Durable.capsule(a), ["public_key"], "different")
    assert {:error, :invalid_store} = Durable.restore(bad)
    capsule = Durable.capsule(a)
    [op | rest] = capsule["log"]["ops"]
    bad = put_in(capsule, ["log", "ops"], [Map.put(op, "sig", Base.encode64(<<0::512>>)) | rest])
    assert {:error, :invalid_store} = Durable.restore(bad)
    {_, other, _, _} = fixture()
    assert {:error, :invalid_replica_log} = Durable.receive_log(a, Durable.capsule(other)["log"])
  end
end
