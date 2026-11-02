defmodule LatticeCore.LiveOpsTest do
  use ExUnit.Case, async: false

  alias LatticeCore.TestTabClient

  setup do
    Lattice.reset!()
    :ok
  end

  test "roles receive scoped caps and publish requires explicit approval cap" do
    %{tab: producer, actor: producer_actor} = connect_role(:producer)
    %{tab: graphics, actor: graphics_actor} = connect_role(:graphics_operator)

    request_cap = cap_id(graphics_actor, :request_publish)
    approve_cap = cap_id(producer_actor, :approve_publish)

    assert {:error, :cap_action_mismatch} =
             Lattice.call(graphics.id, request_cap, %{
               action: "publish",
               request_id: "missing",
               cap_id: request_cap
             })

    assert {:ok, %{approval_id: approval_id}} =
             Lattice.call(graphics.id, request_cap, %{
               action: "request_publish",
               overlay: "Lower third: Unit Test"
             })

    assert {:ok, %{publish_cap_id: publish_cap}} =
             Lattice.call(producer.id, approve_cap, %{
               action: "approve_publish",
               request_id: approval_id,
               ttl_ms: 30_000
             })

    assert {:ok, %{on_air: "Lower third: Unit Test"}} =
             Lattice.call(graphics.id, publish_cap, %{
               action: "publish",
               request_id: approval_id,
               cap_id: publish_cap,
               overlay: "Lower third: Unit Test"
             })

    assert {:error, :revoked} =
             Lattice.call(graphics.id, publish_cap, %{
               action: "publish",
               request_id: approval_id,
               cap_id: publish_cap
             })

    assert_audit(:liveops_approval_granted,
      approval_id: approval_id,
      operator_tab_id: graphics.id,
      producer_tab_id: producer.id,
      publish_cap_id: publish_cap
    )

    assert_audit(:liveops_cap_revoked, cap_id: publish_cap, reason: :publish_used)
  end

  test "expired approval publish caps deny before operation execution" do
    %{tab: producer, actor: producer_actor} = connect_role(:producer)
    %{tab: graphics, actor: graphics_actor} = connect_role(:graphics_operator)

    request_cap = cap_id(graphics_actor, :request_publish)
    approve_cap = cap_id(producer_actor, :approve_publish)

    assert {:ok, %{approval_id: approval_id}} =
             Lattice.call(graphics.id, request_cap, %{
               action: "request_publish",
               overlay: "Expired lower third"
             })

    assert {:ok, %{publish_cap_id: publish_cap}} =
             Lattice.call(producer.id, approve_cap, %{
               action: "approve_publish",
               request_id: approval_id,
               ttl_ms: -1
             })

    before_count = operation_count(:publish)

    assert {:error, :expired} =
             Lattice.call(graphics.id, publish_cap, %{
               action: "publish",
               request_id: approval_id,
               cap_id: publish_cap
             })

    assert operation_count(:publish) == before_count
    assert_audit(:expired_cap, cap_id: publish_cap, reason: :expired)
  end

  test "role labels are not authority and wrong-role publish is denied" do
    %{tab: observer, actor: observer_actor} = connect_role(:observer)
    observe_cap = cap_id(observer_actor, :observe)

    before_count = operation_count(:publish)

    assert {:error, :cap_action_mismatch} =
             Lattice.call(observer.id, observe_cap, %{
               action: "publish",
               request_id: "approval-should-not-matter",
               cap_id: observe_cap
             })

    assert operation_count(:publish) == before_count
    assert_audit(:deny, tab_id: observer.id, reason: :cap_action_mismatch)
  end

  test "device actors are cap gated and cleaned with tab lifecycle" do
    %{tab: camera, actor: camera_actor} = connect_role(:remote_camera)

    camera_cap = cap_id(camera_actor, :camera_frame)
    tally_cap = cap_id(camera_actor, :set_tally)

    assert {:ok, %{device_kind: :camera_feed, accepted: true}} =
             Lattice.call(camera.id, camera_cap, %{action: "camera_frame", frame: "frame-001"})

    assert {:ok, %{device_kind: :tally_light, accepted: true}} =
             Lattice.call(camera.id, tally_cap, %{action: "set_tally", state: "on-air"})

    assert {:ok, _actor} = Lattice.LiveOps.cleanup_tab(camera.id, :test_disconnect)
    assert {:ok, _closed} = Lattice.disconnect_tab(camera.id)

    refute Enum.any?(Lattice.LiveOps.snapshot().actors, &(&1.tab_id == camera.id))

    assert {:error, :revoked} =
             Lattice.call(camera.id, camera_cap, %{action: "camera_frame", frame: "stale"})

    assert_audit(:liveops_cleanup, tab_id: camera.id, reason: :test_disconnect)
  end

  test "snapshot fails closed while CapStore is unavailable" do
    %{actor: observer_actor} = connect_role(:observer)
    observe_cap = cap_id(observer_actor, :observe)
    supervisor = Process.whereis(LatticeCore.Supervisor)

    assert :ok = Supervisor.terminate_child(supervisor, Lattice.CapStore)

    try do
      snapshot = Lattice.LiveOps.snapshot()

      assert %{id: ^observe_cap, status: "revoked"} =
               Enum.find(snapshot.caps, &(&1.id == observe_cap))

      assert Process.alive?(supervisor)
    after
      assert {:ok, _pid} = Supervisor.restart_child(supervisor, Lattice.CapStore)
    end

    assert %{caps: %{}, active_caps: %{}} = Lattice.CapStore.snapshot()

    assert %{id: ^observe_cap, status: "revoked"} =
             Lattice.LiveOps.snapshot().caps
             |> Enum.find(&(&1.id == observe_cap))
  end

  # Row 231: `Audit.events/0` is a plain call, so a snapshot taken while Audit
  # is mid-restart used to exit `:noproc` inside LiveOps. Terminating the child
  # through the supervisor makes the unavailable window deterministic. No tab
  # is registered while Audit is down: `emit/3` now defers its own audit write
  # (row 310), but `register_tab/1` grants through `Lattice.CapStore`, which
  # still records through `Audit.record/2` and would crash (row 313).
  test "snapshot survives an unavailable Audit" do
    before = Process.whereis(Lattice.LiveOps)
    :ok = Supervisor.terminate_child(LatticeCore.Supervisor, Lattice.Audit)

    on_exit(fn ->
      case Supervisor.restart_child(LatticeCore.Supervisor, Lattice.Audit) do
        {:ok, _pid} -> :ok
        {:error, :running} -> :ok
        {:error, {:already_started, _pid}} -> :ok
      end
    end)

    assert %{counters: %{audit: 0}} = Lattice.LiveOps.snapshot()
    assert Process.whereis(Lattice.LiveOps) == before
    assert Lattice.Audit.count() == 0

    assert {:ok, _pid} = Supervisor.restart_child(LatticeCore.Supervisor, Lattice.Audit)
    Lattice.Audit.record(:row_231_probe, %{})

    assert Lattice.Audit.count() == 1
    assert %{counters: %{audit: 1}} = Lattice.LiveOps.snapshot()
    assert Process.whereis(Lattice.LiveOps) == before
  end

  # Row 310: `emit/3` defers audit writes while Audit is down instead of exiting
  # LiveOps. Emits are driven only through `record_denial/4` and
  # `device_event/6`, which do not call `Lattice.CapStore`; a CapStore hop still
  # records through `Audit.record/2` and would crash during the outage (row 313).
  # Only the automatic-retry test relies on the 1 s retry timer; tests that
  # assert a flush count hold it off (`hold_audit_retry!/0`); elsewhere
  # Audit stays terminated for the whole deferral window, so a timer fire there
  # only re-arms.
  describe "audit deferral across an Audit restart (row 310)" do
    setup do
      on_exit(&ensure_audit_running/0)
      :ok
    end

    test "record_denial while Audit is down is deferred, not lost" do
      liveops = Process.whereis(Lattice.LiveOps)
      stop_audit!()

      assert :ok = Lattice.LiveOps.record_denial("tab-x", :publish, :cap_required, %{})
      assert Process.whereis(Lattice.LiveOps) == liveops
      assert %{counters: %{audit_pending: 1, audit_gap: 0}} = Lattice.LiveOps.snapshot()

      assert [%{id: event_id, kind: :liveops_denied}] =
               Enum.filter(Lattice.LiveOps.events(), &(&1.kind == :liveops_denied))

      start_audit!()
      # `flushed` is not pinned: the 1 s retry timer may win the race on a slow
      # runner. The Audit contents below are identical either way.
      assert {:ok, %{pending: 0, gap: 0}} = Lattice.LiveOps.flush_audit()

      assert [%{metadata: metadata}] = audit_of(:liveops_denied)
      assert metadata.liveops_event_id == event_id
      assert metadata.audit_deferred == true
      assert metadata.tab_id == "tab-x"
      assert %{counters: %{audit_pending: 0}} = Lattice.LiveOps.snapshot()
      assert Process.whereis(Lattice.LiveOps) == liveops
    end

    test "deferred records replay in LiveOps event order" do
      stop_audit!()

      assert :ok = Lattice.LiveOps.record_denial("tab-x", :publish, :cap_required, %{})

      assert {:ok, _op} =
               Lattice.LiveOps.device_event(:camera, "tab-x", "device-1", :camera_frame, nil, %{})

      assert %{counters: %{audit_pending: 2}} = Lattice.LiveOps.snapshot()

      start_audit!()
      assert {:ok, %{pending: 0}} = Lattice.LiveOps.flush_audit()

      records = liveops_audit()
      ids = Enum.map(records, & &1.metadata.liveops_event_id)
      assert ids == Enum.sort(ids) and ids == Enum.uniq(ids)
      assert ids == Enum.map(Lattice.LiveOps.events(), & &1.id)

      assert Enum.map(records, & &1.type) == [:liveops_denied, :liveops_device_operation]
      assert Enum.all?(records, &(&1.metadata.audit_deferred == true))
    end

    test "next emit after Audit returns flushes the backlog first" do
      stop_audit!()
      assert :ok = Lattice.LiveOps.record_denial("tab-x", :publish, :cap_required, %{})
      start_audit!()

      assert :ok = Lattice.LiveOps.record_denial("tab-y", :publish, :cap_required, %{})

      assert [older, newer] = audit_of(:liveops_denied)
      assert older.metadata.liveops_event_id < newer.metadata.liveops_event_id
      assert older.metadata.tab_id == "tab-x"
      assert older.metadata.audit_deferred == true
      assert newer.metadata.tab_id == "tab-y"
      refute Map.has_key?(newer.metadata, :audit_deferred)
      assert %{counters: %{audit_pending: 0}} = Lattice.LiveOps.snapshot()
    end

    test "healthy Audit records immediately with no deferral marker" do
      assert :ok = Lattice.LiveOps.record_denial("tab-x", :publish, :cap_required, %{})

      assert {:ok, _op} =
               Lattice.LiveOps.device_event(:camera, "tab-x", "device-1", :camera_frame, nil, %{})

      records = liveops_audit()
      assert length(records) == 2
      refute Enum.any?(records, &Map.has_key?(&1.metadata, :audit_deferred))

      assert Enum.map(records, & &1.metadata.liveops_event_id) ==
               Enum.map(Lattice.LiveOps.events(), & &1.id)

      assert %{counters: %{audit_pending: 0, audit_gap: 0}} = Lattice.LiveOps.snapshot()
    end

    test "reset with pending records leaves a visible gap record" do
      hold_audit_retry!()
      stop_audit!()
      assert :ok = Lattice.LiveOps.record_denial("tab-x", :publish, :cap_required, %{})
      assert :ok = Lattice.LiveOps.record_denial("tab-y", :publish, :cap_required, %{})

      assert :ok = Lattice.LiveOps.reset()
      assert %{counters: %{audit_gap: 2, audit_pending: 0}} = Lattice.LiveOps.snapshot()

      start_audit!()
      # `flushed` counts the gap record itself (row 310 round 1).
      assert {:ok, %{flushed: 1, pending: 0, gap: 0}} = Lattice.LiveOps.flush_audit()

      assert [%{metadata: %{dropped: 2, reason: :reset}}] = audit_of(:liveops_audit_gap)
      assert audit_of(:liveops_denied) == []
      assert %{counters: %{audit_gap: 0}} = Lattice.LiveOps.snapshot()
    end

    # Row 310 round 2: the gap record counts toward the batch allowance.
    test "a flush that writes a gap record stays within the batch limit" do
      hold_audit_retry!()
      batch = Lattice.LiveOps.audit_batch()
      stop_audit!()
      assert :ok = Lattice.LiveOps.record_denial("tab-x", :publish, :cap_required, %{})
      assert :ok = Lattice.LiveOps.reset()

      for n <- 1..batch do
        assert :ok = Lattice.LiveOps.record_denial("tab-#{n}", :publish, :cap_required, %{})
      end

      start_audit!()
      assert {:ok, %{flushed: ^batch, pending: 1, gap: 0}} = Lattice.LiveOps.flush_audit()
      assert [%{metadata: %{dropped: 1, reason: :reset}}] = audit_of(:liveops_audit_gap)

      assert eventually(fn -> Lattice.LiveOps.snapshot().counters.audit_pending == 0 end)
      ids = Enum.map(liveops_audit(), & &1.metadata.liveops_event_id)
      assert length(ids) == batch
      assert ids == Enum.sort(ids) and ids == Enum.uniq(ids)
    end

    # Row 310 round 1: an idle LiveOps must replay on its own once Audit
    # returns; nothing here flushes or emits after the restart.
    test "an idle LiveOps replays the backlog after Audit returns" do
      stop_audit!()
      assert :ok = Lattice.LiveOps.record_denial("tab-x", :publish, :cap_required, %{})
      start_audit!()

      assert eventually(fn -> Lattice.LiveOps.snapshot().counters.audit_pending == 0 end)
      assert [%{metadata: %{tab_id: "tab-x", audit_deferred: true}}] = audit_of(:liveops_denied)
    end

    # Row 310 round 1: replaying a large backlog in one handler blocked every
    # LiveOps caller until it drained. A flush now writes one bounded batch and
    # the remainder continues through the mailbox.
    test "a large backlog drains in bounded batches" do
      batch = Lattice.LiveOps.audit_batch()
      total = batch * 2 + 100
      stop_audit!()

      for n <- 1..total do
        assert :ok = Lattice.LiveOps.record_denial("tab-#{n}", :publish, :cap_required, %{})
      end

      assert %{counters: %{audit_pending: ^total}} = Lattice.LiveOps.snapshot()
      start_audit!()

      assert {:ok, %{flushed: flushed}} = Lattice.LiveOps.flush_audit()
      assert flushed <= batch

      assert eventually(fn -> Lattice.LiveOps.snapshot().counters.audit_pending == 0 end)

      ids = Enum.map(liveops_audit(), & &1.metadata.liveops_event_id)
      assert length(ids) == total
      assert ids == Enum.sort(ids) and ids == Enum.uniq(ids)
    end

    # Row 310 round 1: bounded batches must not turn a reset against a live
    # Audit into a gap; reset drains everything Audit accepts first.
    test "reset with a healthy Audit drains a multi-batch backlog" do
      total = Lattice.LiveOps.audit_batch() + 100
      stop_audit!()

      for n <- 1..total do
        assert :ok = Lattice.LiveOps.record_denial("tab-#{n}", :publish, :cap_required, %{})
      end

      start_audit!()
      assert :ok = Lattice.LiveOps.reset()

      assert length(liveops_audit()) == total
      assert audit_of(:liveops_audit_gap) == []
      assert %{counters: %{audit_gap: 0, audit_pending: 0}} = Lattice.LiveOps.snapshot()
    end

    test "Audit.try_record reports unavailable instead of exiting" do
      stop_audit!()

      assert Lattice.Audit.try_record(:probe, %{}) == {:error, :unavailable}
      assert Process.alive?(self())
      assert catch_exit(Lattice.Audit.record(:probe, %{}))
    end

    # Row 310 round 3 (Codex P2): during an outage every emit retries the
    # flush. Selecting the batch by scanning the newest-first event list made
    # each emit O(backlog) and an outage O(N^2). The cost of one deferred emit
    # is measured in LiveOps reductions (deterministic, unlike wall time) and
    # must not grow with the backlog.
    test "a deferred emit does not scale with the backlog" do
      hold_audit_retry!()
      liveops = Process.whereis(Lattice.LiveOps)
      stop_audit!()

      small = emit_reductions(liveops, 10)
      large = emit_reductions(liveops, 5_000)

      assert large < small * 3 + 2_000,
             "deferred emit cost grew with backlog: #{small} -> #{large} reductions"

      assert %{counters: %{audit_pending: pending}} = Lattice.LiveOps.snapshot()
      start_audit!()
      # The retry timer is held, so kick the first batch; continuations follow.
      assert {:ok, _} = Lattice.LiveOps.flush_audit()
      assert eventually(fn -> Lattice.LiveOps.snapshot().counters.audit_pending == 0 end)
      assert length(liveops_audit()) == pending
    end

    # Row 315: Audit dies while LiveOps' write is already queued in its
    # mailbox. `try_record/2` must turn the in-flight `:killed` exit into a
    # deferral rather than crash LiveOps; the supervisor restarts Audit and the
    # record replays. The retry timer is held so only `flush_audit/0` replays.
    test "Audit killed with a LiveOps write in flight defers the record" do
      hold_audit_retry!()
      liveops = Process.whereis(Lattice.LiveOps)
      audit = Process.whereis(Lattice.Audit)
      audit_ref = Process.monitor(audit)
      :ok = :sys.suspend(audit)

      task =
        Task.async(fn ->
          Lattice.LiveOps.record_denial("tab-x", :publish, :cap_required, %{})
        end)

      # Wait until LiveOps' own `:liveops_denied` call sits in Audit's mailbox.
      assert eventually(fn ->
               {:messages, messages} = Process.info(audit, :messages)

               Enum.any?(messages, fn
                 {:"$gen_call", {^liveops, _}, {:record, :liveops_denied, _}} -> true
                 _ -> false
               end)
             end)

      Process.exit(audit, :kill)
      assert_receive {:DOWN, ^audit_ref, :process, ^audit, :killed}, 5_000

      assert Task.await(task, 10_000) == :ok
      assert Process.whereis(Lattice.LiveOps) == liveops

      assert eventually(fn ->
               case Process.whereis(Lattice.Audit) do
                 nil -> false
                 pid -> pid != audit
               end
             end)

      assert {:ok, %{flushed: 1, pending: 0, gap: 0}} = Lattice.LiveOps.flush_audit()

      assert [%{metadata: %{tab_id: "tab-x", audit_deferred: true}}] =
               audit_of(:liveops_denied)

      assert Process.whereis(Lattice.LiveOps) == liveops
    end
  end

  # Grows the deferred backlog to `backlog` events, then returns the LiveOps
  # reductions spent on one more deferred emit.
  defp emit_reductions(liveops, backlog) do
    pending = Lattice.LiveOps.snapshot().counters.audit_pending

    for n <- (pending + 1)..backlog//1 do
      :ok = Lattice.LiveOps.record_denial("tab-#{n}", :publish, :cap_required, %{})
    end

    {:reductions, before} = Process.info(liveops, :reductions)
    :ok = Lattice.LiveOps.record_denial("tab-probe", :publish, :cap_required, %{})
    {:reductions, after_emit} = Process.info(liveops, :reductions)
    after_emit - before
  end

  defp eventually(fun, timeout_ms \\ 5_000) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    poll_until(fun, deadline)
  end

  defp poll_until(fun, deadline) do
    cond do
      fun.() ->
        true

      System.monotonic_time(:millisecond) > deadline ->
        false

      true ->
        receive do
        after
          20 -> poll_until(fun, deadline)
        end
    end
  end

  # Holds the 1 s retry timer off so an explicit `flush_audit/0` count cannot
  # race an automatic retry (row 310 round 2). The 0-delay continuation is
  # unaffected.
  defp hold_audit_retry! do
    previous = Application.fetch_env(:lattice_core, :liveops_audit_retry_ms)
    Application.put_env(:lattice_core, :liveops_audit_retry_ms, 3_600_000)

    on_exit(fn ->
      case previous do
        {:ok, value} -> Application.put_env(:lattice_core, :liveops_audit_retry_ms, value)
        :error -> Application.delete_env(:lattice_core, :liveops_audit_retry_ms)
      end
    end)
  end

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

  defp liveops_audit,
    do: Enum.filter(Lattice.Audit.events(), &Map.has_key?(&1.metadata, :liveops_event_id))

  defp audit_of(type), do: Enum.filter(Lattice.Audit.events(), &(&1.type == type))

  defp connect_role(role) do
    {:ok, _pid, tab} =
      TestTabClient.connect(identity: %{surface: "liveops-demo", role: Atom.to_string(role)})

    {:ok, actor} = Lattice.LiveOps.register_tab(tab)
    %{tab: tab, actor: actor}
  end

  defp cap_id(actor, action) do
    action = Atom.to_string(action)

    actor.caps
    |> Enum.find(&(&1.action == action))
    |> Map.fetch!(:id)
  end

  defp operation_count(action) do
    action = Atom.to_string(action)

    Lattice.LiveOps.snapshot().operations
    |> Enum.count(&(&1.action == action))
  end

  defp assert_audit(type, filters) do
    assert Enum.any?(Lattice.audit_events(), fn event ->
             event.type == type and
               Enum.all?(filters, fn {key, value} -> event.metadata[key] == value end)
           end)
  end
end
