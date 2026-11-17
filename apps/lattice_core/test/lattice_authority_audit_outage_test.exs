defmodule LatticeCore.AuthorityAuditOutageTest do
  # Row 313: `Lattice.CapStore` and `Lattice.Topology` write Audit records
  # through a bounded per-process backlog, so an Audit restart no longer exits
  # them and wipes the in-memory caps and tabs. Assertions filter Audit records
  # by `audit_source` or by tab id and order only within one source by
  # `audit_seq` (D-251); there is no Audit order across processes.
  use ExUnit.Case, async: false

  alias Lattice.{Audit, CapStore, Topology}
  alias LatticeCore.TestTabClient

  defmodule Worker do
    use GenServer

    def start_link(tab_id, args, opts), do: GenServer.start_link(__MODULE__, {tab_id, args, opts})
    def init(state), do: {:ok, state}
  end

  setup do
    previous =
      for key <- [:authority_audit_retry_ms, :authority_audit_backlog_limit],
          into: %{},
          do: {key, Application.fetch_env(:lattice_core, key)}

    # The retry interval is read when a timer is armed, so it is held before
    # anything can defer; reset/0 below cancels any older timer.
    hold_retry!()
    ensure_audit_running()
    Lattice.reset!()

    on_exit(fn ->
      ensure_audit_running()

      Enum.each(previous, fn
        {key, {:ok, value}} -> Application.put_env(:lattice_core, key, value)
        {key, :error} -> Application.delete_env(:lattice_core, key)
      end)

      # Rebuilds both backlogs so a test limit does not leak into later files.
      Lattice.reset!()
    end)

    :ok
  end

  test "grant while Audit is down commits, keeps CapStore alive and replays a deferred :grant" do
    {_pid, tab} = connect_tab()
    cap_store = Process.whereis(CapStore)
    stop_audit!()

    assert {:ok, cap} = Lattice.grant(tab.id, self(), [:call])
    assert Process.whereis(CapStore) == cap_store
    assert {:ok, %{id: cap_id}} = CapStore.get(cap.id)
    assert cap_id == cap.id
    assert {:ok, %{pending: 1, gap: 0}} = CapStore.flush_audit()

    start_audit!()
    assert {:ok, %{flushed: 1, pending: 0, gap: 0}} = CapStore.flush_audit()

    assert [%{metadata: metadata}] = records(:grant, CapStore)
    assert metadata.cap_id == cap.id
    assert metadata.tab_id == tab.id
    assert metadata.audit_deferred == true
    assert is_integer(metadata.audit_seq)
    assert Process.whereis(CapStore) == cap_store
  end

  test "authorize while Audit is down returns the cap with uses incremented and defers :cap_use" do
    {_pid, tab} = connect_tab()
    {:ok, cap} = Lattice.grant(tab.id, self(), [:call])
    stop_audit!()

    assert {:ok, %{uses: 1}} = CapStore.authorize(tab.id, cap.id, :call, %{})
    assert {:ok, %{uses: 1}} = CapStore.get(cap.id)

    start_audit!()
    assert {:ok, %{pending: 0, gap: 0}} = CapStore.flush_audit()

    assert [%{metadata: %{cap_id: cap_id, op: :call, audit_deferred: true}}] =
             records(:cap_use, CapStore)

    assert cap_id == cap.id
  end

  test "revoke while Audit is down revokes the cap and its descendants at once; records replay in audit_seq order" do
    {_a, tab_a} = connect_tab()
    {_b, tab_b} = connect_tab()
    {_c, tab_c} = connect_tab()
    {:ok, root} = Lattice.grant(tab_a.id, self(), [:call], delegation_allowed?: true)
    {:ok, child} = Lattice.delegate(tab_a.id, root.id, tab_b.id, delegation_allowed?: true)
    {:ok, grandchild} = Lattice.delegate(tab_b.id, child.id, tab_c.id)
    stop_audit!()

    assert :ok = Lattice.revoke(root, :outage_test)

    for cap <- [root, child, grandchild] do
      assert {:ok, %{revoked?: true}} = CapStore.get(cap.id)
    end

    start_audit!()
    assert {:ok, %{pending: 0, gap: 0}} = CapStore.flush_audit()

    revokes = records(:revoke, CapStore)
    assert Enum.map(revokes, & &1.metadata.cap_id) == [root.id, child.id, grandchild.id]
    seqs = Enum.map(revokes, & &1.metadata.audit_seq)
    assert seqs == Enum.sort(seqs)
    assert seqs == Enum.uniq(seqs)
  end

  test "denials while Audit is down keep their reason and are deferred" do
    {_pid, tab} = connect_tab()
    cap_store = Process.whereis(CapStore)
    stop_audit!()

    assert {:error, :unknown_cap} = CapStore.authorize(tab.id, "no-such-cap", :call, %{})
    # A malformed token is denied on the caller's side and routed through CapStore.
    assert {:error, :malformed_cap} = CapStore.authorize(tab.id, 123, :call, %{})
    assert Process.whereis(CapStore) == cap_store

    start_audit!()
    assert {:ok, %{pending: 0, gap: 0}} = CapStore.flush_audit()

    assert [unknown, malformed] = records(:deny, CapStore)
    assert %{reason: :unknown_cap, cap_id: "no-such-cap", audit_deferred: true} = unknown.metadata
    assert %{reason: :malformed_cap, op: :call, audit_deferred: true} = malformed.metadata
    assert unknown.metadata.audit_seq < malformed.metadata.audit_seq
  end

  test "disconnect_tab and eject while Audit is down keep Topology and CapStore pids" do
    {_a, tab_a} = connect_tab()
    {_b, tab_b} = connect_tab()
    {:ok, cap_b} = Lattice.grant(tab_b.id, self(), [:call])
    topology = Process.whereis(Topology)
    cap_store = Process.whereis(CapStore)
    stop_audit!()

    assert {:ok, worker} = Lattice.spawn_linked(tab_a.id, Worker, [])
    assert {:ok, %{state: :disconnected}} = Lattice.disconnect_tab(tab_a.id)
    refute Process.alive?(worker)
    assert {:ok, %{state: :ejected}} = Lattice.eject(tab_b.id, :policy_violation)
    assert {:ok, %{revoked?: true}} = CapStore.get(cap_b.id)
    assert Process.whereis(Topology) == topology
    assert Process.whereis(CapStore) == cap_store

    start_audit!()
    assert {:ok, %{pending: 0, gap: 0}} = Topology.flush_audit()
    assert {:ok, %{pending: 0, gap: 0}} = CapStore.flush_audit()

    assert Enum.map(records_for_tab(tab_a.id, Topology), & &1.type) ==
             [:worker_spawn, :worker_cleanup, :tab_disconnect]

    assert [%{metadata: %{reason: ":policy_violation"}}] = records(:tab_eject, Topology)
    assert [%{metadata: %{cap_id: cap_id}}] = records(:revoke, CapStore)
    assert cap_id == cap_b.id
  end

  test "a connection DOWN while Audit is down closes the tab without crashing Topology" do
    {pid, tab} = connect_tab()
    {:ok, cap} = Lattice.grant(tab.id, self(), [:call])
    topology = Process.whereis(Topology)
    stop_audit!()

    Process.unlink(pid)
    Process.exit(pid, :kill)

    assert eventually(fn -> match?({:ok, %{state: :disconnected}}, Topology.get_tab(tab.id)) end)
    assert eventually(fn -> match?({:ok, %{revoked?: true}}, CapStore.get(cap.id)) end)
    assert Process.whereis(Topology) == topology

    start_audit!()
    assert {:ok, %{pending: 0}} = Topology.flush_audit()
    assert {:ok, %{pending: 0}} = CapStore.flush_audit()

    assert [%{metadata: %{reason: ":connection_down", audit_deferred: true}}] =
             records(:tab_disconnect, Topology)
  end

  test "LiveOps register_tab and cleanup_tab survive an Audit restart" do
    pids = Enum.map([Lattice.LiveOps, CapStore, Topology], &Process.whereis/1)
    stop_audit!()

    {_pid, tab} = connect_tab(identity: %{surface: "liveops-demo", role: "observer"})
    assert {:ok, %{caps: [_ | _]}} = Lattice.LiveOps.register_tab(tab)
    assert {:ok, _actor} = Lattice.LiveOps.cleanup_tab(tab.id, :outage_test)
    assert {:ok, _closed} = Lattice.disconnect_tab(tab.id)
    assert Enum.map([Lattice.LiveOps, CapStore, Topology], &Process.whereis/1) == pids

    start_audit!()
    assert {:ok, %{pending: 0, gap: 0}} = CapStore.flush_audit()
    assert {:ok, %{pending: 0, gap: 0}} = Topology.flush_audit()
    assert {:ok, %{pending: 0, gap: 0}} = Lattice.LiveOps.flush_audit()

    assert [_ | _] = records(:grant, CapStore)
    assert [_ | _] = records(:revoke, CapStore)
    assert [%{metadata: %{tab_id: tab_id}}] = records(:tab_connect, Topology)
    assert tab_id == tab.id
    assert Enum.map([Lattice.LiveOps, CapStore, Topology], &Process.whereis/1) == pids
  end

  test "a full backlog refuses grant, delegate, authorize and bridge with :audit_unavailable, leaves state unchanged and counts the refusal" do
    Application.put_env(:lattice_core, :authority_audit_backlog_limit, 3)
    Lattice.reset!()

    {_a, tab_a} = connect_tab()
    {_b, tab_b} = connect_tab()
    {:ok, root} = Lattice.grant(tab_a.id, self(), [:call], delegation_allowed?: true)
    {:ok, bridge_cap} = Lattice.grant(tab_a.id, {:tab, tab_b.id}, [:call])
    stop_audit!()

    for i <- 1..3 do
      assert {:error, :unknown_cap} = CapStore.authorize(tab_a.id, "missing-#{i}", :call, %{})
    end

    for _ <- 1..3, do: connect_tab()

    caps_before = CapStore.snapshot()
    topology_before = Topology.snapshot()

    assert {:error, :audit_unavailable} = Lattice.grant(tab_a.id, self(), [:call])
    assert {:error, :audit_unavailable} = Lattice.delegate(tab_a.id, root.id, tab_b.id)
    assert {:error, :audit_unavailable} = CapStore.authorize(tab_a.id, root.id, :call, %{})

    assert {:error, :audit_unavailable} =
             Topology.create_bridge(tab_a.id, tab_b.id, bridge_cap)

    assert CapStore.snapshot() == caps_before
    assert Topology.snapshot() == topology_before
    assert {:ok, %{uses: 0}} = CapStore.get(root.id)
    assert {:ok, %{flushed: 0, pending: 3, gap: 3}} = CapStore.flush_audit()
    assert {:ok, %{flushed: 0, pending: 3, gap: 1}} = Topology.flush_audit()
  end

  # Review round 1, finding 1 (row 441): a grant refused on a full backlog
  # used to fail LiveOps's `{:ok, cap}` match and kill it.
  test "a full CapStore backlog refuses LiveOps register_tab without killing LiveOps" do
    Application.put_env(:lattice_core, :authority_audit_backlog_limit, 1)
    Lattice.reset!()
    liveops = Process.whereis(Lattice.LiveOps)
    stop_audit!()

    {_pid, tab} = connect_tab(identity: %{surface: "liveops-demo", role: "observer"})
    assert {:error, :unknown_cap} = CapStore.authorize(tab.id, "missing", :call, %{})

    assert {:error, :audit_unavailable} = Lattice.LiveOps.register_tab(tab)
    assert Process.whereis(Lattice.LiveOps) == liveops
    refute liveops_actor?(tab.id)

    start_audit!()
    assert {:ok, %{pending: 0}} = CapStore.flush_audit()
    assert {:ok, %{caps: [_ | _]}} = Lattice.LiveOps.register_tab(tab)
    assert liveops_actor?(tab.id)
    assert Process.whereis(Lattice.LiveOps) == liveops
  end

  test "a register_tab refused part way revokes the caps it granted and stops its devices" do
    liveops = Process.whereis(Lattice.LiveOps)

    # Limit 2 refuses the third producer role cap; limit 3 refuses the device
    # cap after the preview_monitor device has spawned.
    for limit <- [2, 3] do
      Application.put_env(:lattice_core, :authority_audit_backlog_limit, limit)
      Lattice.reset!()
      stop_audit!()

      {_pid, tab} = connect_tab(identity: %{surface: "liveops-demo", role: "producer"})
      assert {:error, :audit_unavailable} = Lattice.LiveOps.register_tab(tab)
      assert Process.whereis(Lattice.LiveOps) == liveops
      refute liveops_actor?(tab.id)

      owned = owned_caps(tab.id)
      assert length(owned) == limit
      assert Enum.all?(owned, & &1.revoked?)

      assert eventually(fn ->
               {:ok, %{owned_workers: workers}} = Topology.get_tab(tab.id)
               MapSet.size(workers) == 0
             end)

      start_audit!()
      assert {:ok, %{pending: 0}} = CapStore.flush_audit()
      assert {:ok, %{caps: [_, _, _, _]}} = Lattice.LiveOps.register_tab(tab)
      assert Enum.count(owned_caps(tab.id), &(not &1.revoked?)) == 4
    end
  end

  test "a full CapStore backlog refuses approve_publish and leaves the approval pending" do
    Application.put_env(:lattice_core, :authority_audit_backlog_limit, 2)
    Lattice.reset!()
    liveops = Process.whereis(Lattice.LiveOps)

    {_p, producer} = connect_tab(identity: %{surface: "liveops-demo", role: "producer"})
    {_g, graphics} = connect_tab(identity: %{surface: "liveops-demo", role: "graphics_operator"})
    {:ok, producer_actor} = Lattice.LiveOps.register_tab(producer)
    {:ok, graphics_actor} = Lattice.LiveOps.register_tab(graphics)
    stop_audit!()

    # Each successful authorize defers one :cap_use, so the approve call's own
    # authorize fills the backlog and its publish grant is refused.
    assert {:ok, %{approval_id: approval_id}} =
             Lattice.call(graphics.id, liveops_cap(graphics_actor, :request_publish), %{
               action: "request_publish",
               overlay: "Outage lower third"
             })

    assert {:error, :audit_unavailable} =
             Lattice.call(producer.id, liveops_cap(producer_actor, :approve_publish), %{
               action: "approve_publish",
               request_id: approval_id
             })

    assert Process.whereis(Lattice.LiveOps) == liveops

    # The public approval view stringifies atom values, nil included.
    assert [%{id: ^approval_id, status: "pending", publish_cap_id: "nil"}] =
             Lattice.LiveOps.snapshot().approvals
  end

  # Review round 1, finding 2 (row 442): `Lattice.bridge/4` used to leave the
  # granted bridge cap live when Topology refused the bridge.
  test "a bridge Topology refuses revokes the cap Lattice.bridge granted" do
    Application.put_env(:lattice_core, :authority_audit_backlog_limit, 2)
    Lattice.reset!()
    stop_audit!()

    # Two deferred :tab_connect records fill Topology's backlog; CapStore's is empty.
    {_a, tab_a} = connect_tab()
    {_b, tab_b} = connect_tab()

    assert {:error, :audit_unavailable} =
             Lattice.bridge(tab_a.id, tab_b.id, [:call], id: "outage-bridge")

    assert {:ok, %{revoked?: true, revoked_reason: :bridge_refused}} =
             CapStore.get("outage-bridge")

    refute Topology.bridge_allowed?(tab_a.id, tab_b.id, "outage-bridge")
    assert {:error, :revoked} = CapStore.authorize(tab_a.id, "outage-bridge", :call, %{})

    start_audit!()
    assert {:ok, %{pending: 0}} = Topology.flush_audit()

    # A revoked id stays reserved (D-770), so the retry names a fresh one.
    assert {:error, :cap_id_collision} =
             Lattice.bridge(tab_a.id, tab_b.id, [:call], id: "outage-bridge")

    assert {:ok, %{id: "outage-bridge-2"}} =
             Lattice.bridge(tab_a.id, tab_b.id, [:call], id: "outage-bridge-2")

    assert Topology.bridge_allowed?(tab_a.id, tab_b.id, "outage-bridge-2")
  end

  test "a bridge to a disconnected tab revokes the cap Lattice.bridge granted" do
    {_a, tab_a} = connect_tab()
    {_b, tab_b} = connect_tab()
    {:ok, _closed} = Lattice.disconnect_tab(tab_b.id)

    assert {:error, :tab_not_connected} =
             Lattice.bridge(tab_a.id, tab_b.id, [:call], id: "closed-bridge")

    assert {:ok, %{revoked?: true, revoked_reason: :bridge_refused}} =
             CapStore.get("closed-bridge")
  end

  test "a full backlog still commits revocations; the :audit_gap record is written before replayed records" do
    Application.put_env(:lattice_core, :authority_audit_backlog_limit, 3)
    Lattice.reset!()

    {_pid, tab} = connect_tab()
    {:ok, cap} = Lattice.grant(tab.id, self(), [:call])
    stop_audit!()

    for i <- 1..3 do
      assert {:error, :unknown_cap} = CapStore.authorize(tab.id, "missing-#{i}", :call, %{})
    end

    assert :ok = Lattice.revoke(cap, :outage_test)
    assert {:ok, %{revoked?: true}} = CapStore.get(cap.id)
    assert {:ok, %{pending: 3, gap: 1}} = CapStore.flush_audit()

    start_audit!()
    assert {:ok, %{flushed: 4, pending: 0, gap: 0}} = CapStore.flush_audit()

    events = Audit.events()
    gap_index = Enum.find_index(events, &gap_record?(&1, CapStore, :backlog_full))
    assert %{metadata: %{dropped: 1}} = Enum.at(events, gap_index)

    deferred_indexes =
      events
      |> Enum.with_index()
      |> Enum.filter(fn {event, _index} -> event.metadata[:audit_source] == CapStore end)
      |> Enum.map(fn {_event, index} -> index end)

    assert length(deferred_indexes) == 3
    assert Enum.all?(deferred_indexes, &(&1 > gap_index))
  end

  test "the next authority call after Audit returns flushes the backlog first" do
    {_pid, tab} = connect_tab()
    stop_audit!()

    assert {:error, :unknown_cap} = CapStore.authorize(tab.id, "missing", :call, %{})

    start_audit!()
    assert {:ok, cap} = Lattice.grant(tab.id, self(), [:call])

    tab_events = Enum.filter(Audit.events(), &(&1.metadata[:tab_id] == tab.id))
    assert [%{type: :deny} = deny, %{type: :grant} = grant] = tab_events
    assert deny.metadata.audit_deferred == true
    refute Map.has_key?(grant.metadata, :audit_deferred)
    assert grant.metadata.cap_id == cap.id
    assert {:ok, %{flushed: 0, pending: 0, gap: 0}} = CapStore.flush_audit()
  end

  test "an idle CapStore replays after Audit returns" do
    Application.put_env(:lattice_core, :authority_audit_retry_ms, 50)
    Lattice.reset!()

    {_pid, tab} = connect_tab()
    stop_audit!()

    assert {:error, :unknown_cap} = CapStore.authorize(tab.id, "missing", :call, %{})

    start_audit!()

    assert eventually(fn ->
             match?([%{metadata: %{audit_deferred: true}}], records(:deny, CapStore))
           end)
  end

  test "reset with pending records leaves an :audit_gap reset record" do
    {_pid, tab} = connect_tab()
    stop_audit!()

    assert {:error, :unknown_cap} = CapStore.authorize(tab.id, "missing-1", :call, %{})
    assert {:error, :unknown_cap} = CapStore.authorize(tab.id, "missing-2", :call, %{})
    assert :ok = CapStore.reset()
    assert {:ok, %{flushed: 0, pending: 0, gap: 2}} = CapStore.flush_audit()

    start_audit!()
    assert {:ok, %{flushed: 1, pending: 0, gap: 0}} = CapStore.flush_audit()

    assert [%{metadata: %{source: CapStore, dropped: 2, reason: :reset}}] =
             Enum.filter(Audit.events(), &gap_record?(&1, CapStore, :reset))

    assert records(:deny, CapStore) == []
  end

  # Row 315's pattern (D-261): a stub registered as `Lattice.Audit` takes
  # CapStore's in-flight write and kills itself, so only `try_record/2`'s exit
  # handler keeps CapStore alive.
  test "Audit killed with a CapStore write in flight defers the record" do
    {_pid, tab} = connect_tab()
    cap_store = Process.whereis(CapStore)
    stop_audit!()
    test_pid = self()
    stub = spawn(fn -> audit_stub(cap_store, test_pid) end)
    stub_ref = Process.monitor(stub)
    true = Process.register(stub, Lattice.Audit)

    on_exit(fn ->
      if Process.alive?(stub), do: Process.exit(stub, :kill)
    end)

    task = Task.async(fn -> Lattice.grant(tab.id, test_pid, [:call]) end)

    assert_receive {:audit_stub_killed_in_flight, ^stub}, 5_000
    assert_receive {:DOWN, ^stub_ref, :process, ^stub, :killed}, 5_000
    assert {:ok, cap} = Task.await(task, 10_000)
    assert Process.whereis(CapStore) == cap_store
    assert {:ok, %{pending: 1}} = CapStore.flush_audit()

    start_audit!()
    assert {:ok, %{flushed: 1, pending: 0, gap: 0}} = CapStore.flush_audit()
    assert [%{metadata: %{cap_id: cap_id, audit_deferred: true}}] = records(:grant, CapStore)
    assert cap_id == cap.id
    assert Process.whereis(CapStore) == cap_store
  end

  test "on-time records carry no deferral keys" do
    {_a, tab_a} = connect_tab()
    {_b, tab_b} = connect_tab()
    {:ok, cap} = Lattice.grant(tab_a.id, self(), [:call])
    {:ok, _used} = CapStore.authorize(tab_a.id, cap.id, :call, %{})
    {:ok, _bridge_cap} = Lattice.bridge(tab_a.id, tab_b.id, [:call])
    {:ok, _closed} = Lattice.disconnect_tab(tab_a.id)

    events =
      Enum.filter(Audit.events(), fn event ->
        event.metadata[:tab_id] == tab_a.id or event.metadata[:from_tab_id] == tab_a.id
      end)

    assert Enum.map(events, & &1.type) ==
             [
               :tab_connect,
               :grant,
               :cap_use,
               :grant,
               :bridge,
               :tab_disconnect,
               :bridge_cleanup,
               :revoke,
               :revoke
             ]

    for event <- events do
      refute Map.has_key?(event.metadata, :audit_deferred)
      refute Map.has_key?(event.metadata, :audit_source)
      refute Map.has_key?(event.metadata, :audit_seq)
    end

    grant = Enum.find(events, &(&1.type == :grant))

    assert grant.metadata |> Map.keys() |> Enum.sort() == [
             :cap_id,
             :caveats,
             :ops,
             :tab_id,
             :target
           ]
  end

  test "a flush writes at most 500 records and continues" do
    {_pid, tab} = connect_tab()
    stop_audit!()

    for i <- 1..1_200 do
      {:error, :unknown_cap} = CapStore.authorize(tab.id, "missing-#{i}", :call, %{})
    end

    start_audit!()
    assert {:ok, %{flushed: 500, pending: 700, gap: 0}} = CapStore.flush_audit()
    assert eventually(fn -> length(records(:deny, CapStore)) == 1_200 end)

    seqs = Enum.map(records(:deny, CapStore), & &1.metadata.audit_seq)
    assert seqs == Enum.sort(seqs)
    assert length(Enum.uniq(seqs)) == 1_200
  end

  # Stands in for `Lattice.Audit`: answers unrelated calls at once and kills
  # itself on CapStore's `:grant` write, leaving that call in flight.
  defp audit_stub(cap_store, test_pid) do
    receive do
      {:"$gen_call", {^cap_store, _}, {:record, :grant, _}} ->
        send(test_pid, {:audit_stub_killed_in_flight, self()})
        Process.exit(self(), :kill)

      {:"$gen_call", from, :count} ->
        GenServer.reply(from, 0)
        audit_stub(cap_store, test_pid)

      {:"$gen_call", from, :events} ->
        GenServer.reply(from, [])
        audit_stub(cap_store, test_pid)

      {:"$gen_call", from, {:record, type, metadata}} ->
        GenServer.reply(from, %{id: 0, type: type, at: 0, metadata: metadata})
        audit_stub(cap_store, test_pid)

      {:"$gen_call", from, _other} ->
        GenServer.reply(from, :ok)
        audit_stub(cap_store, test_pid)
    end
  end

  defp hold_retry!, do: Application.put_env(:lattice_core, :authority_audit_retry_ms, 3_600_000)

  defp stop_audit! do
    assert :ok = Supervisor.terminate_child(LatticeCore.Supervisor, Lattice.Audit)
  end

  defp start_audit! do
    assert {:ok, _pid} = Supervisor.restart_child(LatticeCore.Supervisor, Lattice.Audit)
  end

  defp ensure_audit_running do
    case Supervisor.restart_child(LatticeCore.Supervisor, Lattice.Audit) do
      {:ok, _pid} -> :ok
      {:error, :running} -> :ok
      {:error, {:already_started, _pid}} -> :ok
    end
  end

  defp connect_tab(opts \\ []) do
    {:ok, pid, tab} = TestTabClient.connect(opts)
    {pid, tab}
  end

  defp records(type, source) do
    Enum.filter(Audit.events(), &(&1.type == type and &1.metadata[:audit_source] == source))
  end

  defp liveops_actor?(tab_id) do
    Enum.any?(Lattice.LiveOps.snapshot().actors, &(&1.tab_id == tab_id))
  end

  defp liveops_cap(actor, action) do
    action = Atom.to_string(action)
    actor.caps |> Enum.find(&(&1.action == action)) |> Map.fetch!(:id)
  end

  defp owned_caps(tab_id) do
    CapStore.snapshot().caps |> Map.values() |> Enum.filter(&(&1.owner_tab_id == tab_id))
  end

  defp records_for_tab(tab_id, source) do
    Enum.filter(Audit.events(), fn event ->
      event.metadata[:tab_id] == tab_id and event.metadata[:audit_source] == source
    end)
  end

  defp gap_record?(event, source, reason) do
    event.type == :audit_gap and event.metadata[:source] == source and
      event.metadata[:reason] == reason
  end

  defp eventually(fun, attempts \\ 100) do
    cond do
      fun.() -> true
      attempts == 0 -> false
      true -> Process.sleep(20) && eventually(fun, attempts - 1)
    end
  end
end
