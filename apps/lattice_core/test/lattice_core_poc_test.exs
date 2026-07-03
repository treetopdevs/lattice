defmodule LatticeCore.PocTest do
  use ExUnit.Case, async: false

  alias LatticeCore.TestTabClient

  defmodule TestServer do
    use GenServer

    def start_link(test_pid) do
      GenServer.start_link(__MODULE__, test_pid)
    end

    def init(test_pid), do: {:ok, %{test_pid: test_pid, last_cast: nil}}

    def handle_call({:lattice_call, %{from_tab_id: tab_id, payload: payload}}, _from, state) do
      {:reply, {:ok, %{from_tab_id: tab_id, payload: payload}}, state}
    end

    def handle_cast({:lattice_cast, envelope}, state) do
      send(state.test_pid, {:server_cast, envelope})
      {:noreply, %{state | last_cast: envelope}}
    end
  end

  defmodule TestWorker do
    use GenServer

    def start_link(tab_id, args, opts) do
      GenServer.start_link(__MODULE__, {tab_id, args, opts})
    end

    def ping(pid), do: GenServer.call(pid, :ping)
    def init({tab_id, args, opts}), do: {:ok, %{tab_id: tab_id, args: args, opts: opts}}
    def handle_call(:ping, _from, state), do: {:reply, {:pong, state.tab_id}, state}
  end

  setup do
    Lattice.reset!()
    :ok
  end

  describe "core capabilities" do
    test "granted cap allows permitted call" do
      {_tab_pid, tab} = connect_tab()
      server = start_supervised!({TestServer, self()})
      {:ok, cap} = Lattice.grant(tab.id, server, [:call])

      assert {:ok, %{payload: %{message: "hello"}, from_tab_id: tab_id}} =
               Lattice.call(tab.id, cap, %{message: "hello"})

      assert tab_id == tab.id
    end

    test "granted cap allows permitted cast" do
      {tab_pid, tab} = connect_tab()
      server = start_supervised!({TestServer, self()})
      {:ok, cap} = Lattice.grant(tab.id, server, [:cast])

      assert :ok = TestTabClient.cast(tab_pid, cap, %{event: "stored"})
      assert_receive {:server_cast, %{payload: %{event: "stored"}, from_tab_id: tab_id}}, 100
      assert tab_id == tab.id
    end

    test "ungranted target is denied and audited" do
      {_tab_pid, tab} = connect_tab()

      assert {:error, :unknown_cap} = Lattice.call(tab.id, "forged-cap-id", %{message: "nope"})
      assert_audit(:deny, reason: :unknown_cap)
    end

    test "wrong operation on valid cap is denied" do
      {_tab_pid, tab} = connect_tab()
      server = start_supervised!({TestServer, self()})
      {:ok, cap} = Lattice.grant(tab.id, server, [:call])

      assert {:error, :operation_not_allowed} = Lattice.cast(tab.id, cap, %{event: "not allowed"})
      assert_audit(:deny, reason: :operation_not_allowed)
    end

    test "cap issued to tab A cannot be used by tab B" do
      {_pid_a, tab_a} = connect_tab()
      {_pid_b, tab_b} = connect_tab()
      server = start_supervised!({TestServer, self()})
      {:ok, cap} = Lattice.grant(tab_a.id, server, [:call])

      assert {:error, :wrong_owner} = Lattice.call(tab_b.id, cap, %{message: "steal"})
      assert_audit(:deny, reason: :wrong_owner)
    end

    test "revoked cap is denied" do
      {_tab_pid, tab} = connect_tab()
      server = start_supervised!({TestServer, self()})
      {:ok, cap} = Lattice.grant(tab.id, server, [:call])

      assert :ok = Lattice.revoke(cap, :test)
      assert {:error, :revoked} = Lattice.call(tab.id, cap, %{message: "after revoke"})
      assert_audit(:revoke, cap_id: cap.id)
    end

    test "revoking the root of a delegation chain revokes all descendants" do
      {_pid_a, tab_a} = connect_tab()
      {_pid_b, tab_b} = connect_tab()
      {_pid_c, tab_c} = connect_tab()
      server = start_supervised!({TestServer, self()})

      {:ok, root} = Lattice.grant(tab_a.id, server, [:call], delegation_allowed?: true)
      {:ok, child} = Lattice.delegate(tab_a.id, root.id, tab_b.id, delegation_allowed?: true)
      {:ok, grandchild} = Lattice.delegate(tab_b.id, child.id, tab_c.id)

      assert :ok = Lattice.revoke(root, :test)

      for cap <- [root, child, grandchild] do
        assert {:ok, %{revoked?: true}} = Lattice.CapStore.get(cap.id)
        assert_audit(:revoke, cap_id: cap.id)
      end

      assert {:error, :revoked} = Lattice.call(tab_c.id, grandchild, %{message: "after revoke"})
    end

    test "expired cap is denied" do
      {_tab_pid, tab} = connect_tab()
      server = start_supervised!({TestServer, self()})

      {:ok, cap} =
        Lattice.grant(tab.id, server, [:call],
          expires_at: System.monotonic_time(:millisecond) - 1
        )

      assert {:error, :expired} = Lattice.call(tab.id, cap, %{message: "too late"})
      assert_audit(:expired_cap, cap_id: cap.id)
    end

    test "use-limited cap stops working after limit is reached" do
      {_tab_pid, tab} = connect_tab()
      server = start_supervised!({TestServer, self()})
      {:ok, cap} = Lattice.grant(tab.id, server, [:call], use_limit: 1)

      assert {:ok, _} = Lattice.call(tab.id, cap, %{message: "first"})
      assert {:error, :use_limit_exceeded} = Lattice.call(tab.id, cap, %{message: "second"})
      assert_audit(:use_limit_exceeded, cap_id: cap.id)
    end
  end

  describe "tab lifecycle" do
    test "connecting tabs creates unique isolated sessions" do
      {_pid_a, tab_a} = connect_tab(identity: %{user: "a"})
      {_pid_b, tab_b} = connect_tab(identity: %{user: "b"})

      assert tab_a.id != tab_b.id
      assert tab_a.session_id != tab_b.session_id
      assert tab_a.identity != tab_b.identity
    end

    test "disconnecting a tab revokes caps" do
      {_tab_pid, tab} = connect_tab()
      server = start_supervised!({TestServer, self()})
      {:ok, cap} = Lattice.grant(tab.id, server, [:call])

      assert {:ok, _closed} = Lattice.disconnect_tab(tab.id)
      assert {:error, :revoked} = Lattice.call(tab.id, cap, %{message: "closed"})
    end

    test "disconnecting a tab cleans up tab-attached workers" do
      {_tab_pid, tab} = connect_tab()
      {:ok, worker} = Lattice.spawn_linked(tab.id, TestWorker, [], [])
      assert {:pong, tab_id} = TestWorker.ping(worker)
      assert tab_id == tab.id

      assert {:ok, _closed} = Lattice.disconnect_tab(tab.id)
      refute Process.alive?(worker)
      assert_audit(:worker_cleanup, tab_id: tab.id)
    end

    test "ejecting a tab records an audit event and cleans up deterministically" do
      {_tab_pid, tab} = connect_tab()
      {:ok, worker} = Lattice.spawn_linked(tab.id, TestWorker, [], [])

      assert {:ok, _closed} = Lattice.eject(tab.id, :policy_violation)
      refute Process.alive?(worker)
      assert_audit(:tab_eject, tab_id: tab.id)
      assert_audit(:worker_cleanup, tab_id: tab.id)
    end
  end

  describe "topology" do
    test "tab-to-server operation is allowed only through caps" do
      {_tab_pid, tab} = connect_tab()
      server = start_supervised!({TestServer, self()})

      assert {:error, :unknown_cap} = Lattice.call(tab.id, "missing", %{message: "no cap"})
      {:ok, cap} = Lattice.grant(tab.id, server, [:call])

      assert {:ok, %{payload: %{message: "with cap"}}} =
               Lattice.call(tab.id, cap, %{message: "with cap"})
    end

    test "tab-to-tab operation is denied by default even with a non-bridge cap" do
      {_pid_a, tab_a} = connect_tab()
      {pid_b, tab_b} = connect_tab()
      {:ok, cap} = Lattice.grant(tab_a.id, {:tab, tab_b.id}, [:call])

      assert {:error, :bridge_required} = Lattice.call(tab_a.id, cap, %{op: :relay, body: "no"})
      assert [] = TestTabClient.messages(pid_b)
      assert_audit(:deny, reason: :bridge_required)
    end

    test "explicit bridge allows a narrowly scoped mediated operation" do
      {_pid_a, tab_a} = connect_tab()

      {pid_b, tab_b} =
        connect_tab(
          handlers: [relay: fn payload -> %{relayed: payload["body"] || payload[:body]} end]
        )

      {:ok, bridge_cap} = Lattice.bridge(tab_a.id, tab_b.id, [:call], ttl: 10_000)

      assert {:ok, %{relayed: "hello"}} =
               Lattice.call(tab_a.id, bridge_cap, %{op: :relay, body: "hello"})

      assert [{:call, _envelope}] = TestTabClient.messages(pid_b)
    end

    test "bridge cast to a disconnected target tab is denied without delivery" do
      {_pid_a, tab_a} = connect_tab()
      {pid_b, tab_b} = connect_tab()
      {:ok, bridge_cap} = Lattice.bridge(tab_a.id, tab_b.id, [:cast], ttl: 10_000)

      assert {:ok, _closed} = Lattice.disconnect_tab(tab_b.id)
      assert {:error, :tab_not_connected} = Lattice.cast(tab_a.id, bridge_cap, %{op: :relay})
      assert [] = TestTabClient.messages(pid_b)
      assert_audit(:deny, reason: :tab_not_connected)
    end

    test "bridge revocation denies later traffic" do
      {_pid_a, tab_a} = connect_tab()
      {_pid_b, tab_b} = connect_tab()
      {:ok, bridge_cap} = Lattice.bridge(tab_a.id, tab_b.id, [:call], ttl: 10_000)

      assert :ok = Lattice.revoke(bridge_cap, :bridge_closed)
      assert {:error, :revoked} = Lattice.call(tab_a.id, bridge_cap, %{op: :relay})
    end

    test "bridge expiry denies later traffic" do
      {_pid_a, tab_a} = connect_tab()
      {pid_b, tab_b} = connect_tab()

      {:ok, bridge_cap} =
        Lattice.bridge(tab_a.id, tab_b.id, [:call],
          expires_at: System.monotonic_time(:millisecond) - 1
        )

      assert {:error, :expired} = Lattice.call(tab_a.id, bridge_cap, %{op: :relay})
      assert [] = TestTabClient.messages(pid_b)
      assert_audit(:expired_cap, cap_id: bridge_cap.id)
    end
  end

  describe "movable process" do
    test "server-side operation executes and updates state" do
      {_tab_pid, tab} = connect_tab()
      {:ok, proc} = Lattice.MovableProcess.new(tab.id)

      assert {:ok, storyboard} = Lattice.MovableProcess.generate_storyboard(proc, "summer sale")
      assert %{storyboard: ^storyboard} = Lattice.MovableProcess.get_state(proc)
    end

    test "tab-side operation routes through the tab transport" do
      {_tab_pid, tab} =
        connect_tab(
          handlers: [
            render_preview: fn %{storyboard: storyboard} ->
              %{html: "<section>#{storyboard.brief}</section>"}
            end
          ]
        )

      {:ok, proc} = Lattice.MovableProcess.new(tab.id)
      assert {:ok, _} = Lattice.MovableProcess.generate_storyboard(proc, "launch")

      assert {:ok, %{html: "<section>launch</section>"}} =
               Lattice.MovableProcess.render_preview(proc)
    end

    test "unauthorized tab-side route is denied" do
      {_tab_pid, tab} = connect_tab()
      {:ok, proc} = Lattice.MovableProcess.new(tab.id, grant_render_cap: false)

      assert {:error, :missing_render_cap} = Lattice.MovableProcess.render_preview(proc)
      assert_audit(:deny, reason: :movable_process_missing_render_cap)
    end

    test "disconnecting the tab breaks the logical process cleanly" do
      {_tab_pid, tab} = connect_tab(handlers: [render_preview: fn _ -> %{ok: true} end])
      {:ok, proc} = Lattice.MovableProcess.new(tab.id)

      assert {:ok, _closed} = Lattice.disconnect_tab(tab.id)
      assert {:error, :revoked} = Lattice.MovableProcess.render_preview(proc)
    end
  end

  defp connect_tab(opts \\ []) do
    {:ok, pid, tab} = TestTabClient.connect(opts)
    {pid, tab}
  end

  defp assert_audit(type, filters) do
    assert Enum.any?(Lattice.audit_events(), fn event ->
             event.type == type and
               Enum.all?(filters, fn {key, value} -> event.metadata[key] == value end)
           end)
  end
end
