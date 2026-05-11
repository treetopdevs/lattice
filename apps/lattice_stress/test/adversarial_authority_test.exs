defmodule LatticeStress.AdversarialAuthorityTest do
  use ExUnit.Case, async: false

  alias LatticeStress.{ProbeServer, ProbeTab}

  setup do
    Lattice.reset!()
    Lattice.Demo.SecretServer.reset_deliveries()

    {:ok, probe} = ProbeServer.start_link(owner: self(), name: :primary_probe)
    registered_probe_name = :"registered_probe_#{System.unique_integer([:positive])}"

    {:ok, registered_probe} =
      ProbeServer.start_link(owner: self(), registered_name: registered_probe_name)

    {:ok, tab_a_pid, tab_a} = ProbeTab.connect(identity: %{user: "alice"})
    {:ok, tab_b_pid, tab_b} = ProbeTab.connect(identity: %{user: "bob"})
    {:ok, tab_c_pid, tab_c} = ProbeTab.connect(identity: %{user: "carol"})

    {:ok,
     %{
       probe: probe,
       registered_probe: registered_probe,
       registered_probe_name: registered_probe_name,
       tab_a_pid: tab_a_pid,
       tab_a: tab_a,
       tab_b_pid: tab_b_pid,
       tab_b: tab_b,
       tab_c_pid: tab_c_pid,
       tab_c: tab_c
     }}
  end

  test "forged random cap id is denied and no server target observes it", %{
    probe: probe,
    tab_a: tab
  } do
    assert_denied_no_server_delivery(
      fn -> Lattice.call(tab.id, "forged_" <> Lattice.Cap.random_token(), %{attack: :forged}) end,
      :unknown_cap,
      probe
    )
  end

  test "syntactically valid but nonexistent cap id is denied", %{probe: probe, tab_a: tab} do
    assert_denied_no_server_delivery(
      fn -> Lattice.call(tab.id, Lattice.Cap.random_token(), %{attack: :nonexistent}) end,
      :unknown_cap,
      probe
    )
  end

  test "stolen cap id from another tab is denied before delivery", %{
    probe: probe,
    tab_a: tab_a,
    tab_b: tab_b
  } do
    {:ok, cap} = Lattice.grant(tab_a.id, probe, [:call])

    assert_denied_no_server_delivery(
      fn -> Lattice.call(tab_b.id, cap.id, %{attack: :stolen}) end,
      :wrong_owner,
      probe
    )
  end

  test "stolen delegable cap id cannot mint attacker-owned child authority", %{
    probe: probe,
    tab_a: tab_a,
    tab_b: tab_b
  } do
    {:ok, cap} = Lattice.grant(tab_a.id, probe, [:call], delegation_allowed?: true)

    assert {:error, :delegator_required} = Lattice.delegate(cap.id, tab_b.id)
    assert {:error, :wrong_owner} = Lattice.delegate(tab_b.id, cap.id, tab_b.id)

    assert {:ok, child} = Lattice.delegate(tab_a.id, cap.id, tab_b.id)
    assert {:ok, _} = Lattice.call(tab_b.id, child, %{ok: :delegated})
    assert %{call_count: 1} = ProbeServer.stats(probe)
  end

  test "valid cap used with wrong operation is denied before cast delivery", %{
    probe: probe,
    tab_a: tab
  } do
    {:ok, cap} = Lattice.grant(tab.id, probe, [:call])

    assert {:error, :operation_not_allowed} = Lattice.cast(tab.id, cap, %{attack: :wrong_op})
    assert %{cast_count: 0, call_count: 0} = ProbeServer.stats(probe)
    assert_audit(:deny, reason: :operation_not_allowed)
  end

  test "valid cap replayed after revoke is denied and not delivered", %{probe: probe, tab_a: tab} do
    {:ok, cap} = Lattice.grant(tab.id, probe, [:call])
    assert :ok = Lattice.revoke(cap, :test_revoke)

    assert_denied_no_server_delivery(
      fn -> Lattice.call(tab.id, cap, %{attack: :replay_after_revoke}) end,
      :revoked,
      probe
    )
  end

  test "valid cap replayed after tab disconnect is denied and not delivered", %{
    probe: probe,
    tab_a: tab
  } do
    {:ok, cap} = Lattice.grant(tab.id, probe, [:call])
    assert {:ok, _closed} = Lattice.disconnect_tab(tab.id)

    assert_denied_no_server_delivery(
      fn -> Lattice.call(tab.id, cap, %{attack: :replay_after_disconnect}) end,
      :revoked,
      probe
    )
  end

  test "valid cap replayed after tab eject is denied and not delivered", %{
    probe: probe,
    tab_a: tab
  } do
    {:ok, cap} = Lattice.grant(tab.id, probe, [:call])
    assert {:ok, _closed} = Lattice.eject(tab.id, :stress_eject)

    assert_denied_no_server_delivery(
      fn -> Lattice.call(tab.id, cap, %{attack: :replay_after_eject}) end,
      :revoked,
      probe
    )
  end

  test "expired cap is denied before delivery", %{probe: probe, tab_a: tab} do
    {:ok, cap} =
      Lattice.grant(tab.id, probe, [:call], expires_at: System.monotonic_time(:millisecond) - 1)

    assert_denied_no_server_delivery(
      fn -> Lattice.call(tab.id, cap, %{attack: :expired}) end,
      :expired,
      probe
    )
  end

  test "use-limit-exhausted cap stops delivering after the limit", %{probe: probe, tab_a: tab} do
    {:ok, cap} = Lattice.grant(tab.id, probe, [:call], use_limit: 1)

    assert {:ok, _} = Lattice.call(tab.id, cap, %{ok: 1})
    assert %{call_count: 1} = ProbeServer.stats(probe)
    assert :ok = ProbeServer.reset(probe)

    assert_denied_no_server_delivery(
      fn -> Lattice.call(tab.id, cap, %{attack: :use_limit}) end,
      :use_limit_exceeded,
      probe
    )
  end

  test "bridge cap used backward is denied and target tab never observes it", %{
    tab_a: tab_a,
    tab_b: tab_b,
    tab_a_pid: tab_a_pid
  } do
    {:ok, bridge_cap} = Lattice.bridge(tab_a.id, tab_b.id, [:call], ttl: 10_000)

    assert_denied_no_tab_delivery(
      fn -> Lattice.call(tab_b.id, bridge_cap, %{op: :relay, attack: :backward}) end,
      :wrong_owner,
      tab_a_pid
    )
  end

  test "bridge cap used by a third tab is denied and target tab never observes it", %{
    tab_a: tab_a,
    tab_b: tab_b,
    tab_c: tab_c,
    tab_b_pid: tab_b_pid
  } do
    {:ok, bridge_cap} = Lattice.bridge(tab_a.id, tab_b.id, [:call], ttl: 10_000)

    assert_denied_no_tab_delivery(
      fn -> Lattice.call(tab_c.id, bridge_cap, %{op: :relay, attack: :third_party}) end,
      :wrong_owner,
      tab_b_pid
    )
  end

  test "direct tab-to-tab call without bridge is denied and not delivered", %{
    tab_a: tab_a,
    tab_b: tab_b,
    tab_b_pid: tab_b_pid
  } do
    {:ok, cap} = Lattice.grant(tab_a.id, {:tab, tab_b.id}, [:call])

    assert_denied_no_tab_delivery(
      fn -> Lattice.call(tab_a.id, cap, %{op: :relay, attack: :no_bridge}) end,
      :bridge_required,
      tab_b_pid
    )
  end

  test "attempt to reach SecretServer without a grant is denied and SecretServer does not observe it",
       %{
         tab_a: tab
       } do
    assert {:error, :unknown_cap} =
             Lattice.call(tab.id, "secret-server-is-not-authority", %{attack: :secret})

    assert [] = Lattice.Demo.SecretServer.deliveries()
    assert_audit(:deny, reason: :unknown_cap)
  end

  test "attempt to reach registered name directly without a cap is denied", %{
    registered_probe: probe,
    registered_probe_name: registered_probe_name,
    tab_a: tab
  } do
    assert_denied_no_server_delivery(
      fn ->
        Lattice.call(tab.id, Atom.to_string(registered_probe_name), %{attack: :registered_name})
      end,
      :unknown_cap,
      probe
    )
  end

  test "attempt to reach raw pid directly without a cap is denied", %{probe: probe, tab_a: tab} do
    assert_denied_no_server_delivery(
      fn -> Lattice.call(tab.id, inspect(probe), %{attack: :raw_pid}) end,
      :unknown_cap,
      probe
    )
  end

  test "attempt to call framework internals is denied", %{probe: probe, tab_a: tab} do
    assert_denied_no_server_delivery(
      fn -> Lattice.call(tab.id, "Elixir.Lattice.CapStore", %{attack: :internals}) end,
      :unknown_cap,
      probe
    )
  end

  test "malformed cap envelope fails closed and is audited", %{probe: probe, tab_a: tab} do
    assert_denied_no_server_delivery(
      fn -> Lattice.call(tab.id, %{id: "not-a-serializable-cap"}, %{attack: :malformed}) end,
      :malformed_cap,
      probe
    )
  end

  test "cap id collision attempt is rejected and cannot retarget the existing cap", %{
    probe: probe,
    registered_probe: other_probe,
    tab_a: tab_a,
    tab_b: tab_b
  } do
    fixed_id = "collision_" <> Lattice.Cap.random_token()
    {:ok, cap} = Lattice.grant(tab_a.id, probe, [:call], id: fixed_id)

    assert {:error, :cap_id_collision} =
             Lattice.grant(tab_b.id, other_probe, [:call], id: fixed_id)

    assert_audit(:deny, reason: :cap_id_collision)

    assert {:ok, _} = Lattice.call(tab_a.id, cap.id, %{ok: :original_owner})
    assert {:error, :wrong_owner} = Lattice.call(tab_b.id, fixed_id, %{attack: :collision_steal})

    assert %{call_count: 1} = ProbeServer.stats(probe)
    assert %{call_count: 0} = ProbeServer.stats(other_probe)
  end

  test "cap issued before reconnect cannot be used by the new tab session", %{
    probe: probe,
    tab_a: old_tab
  } do
    {:ok, cap} = Lattice.grant(old_tab.id, probe, [:call])
    assert {:ok, _closed} = Lattice.disconnect_tab(old_tab.id)
    {:ok, _new_pid, new_tab} = ProbeTab.connect(identity: old_tab.identity)

    assert_denied_no_server_delivery(
      fn -> Lattice.call(new_tab.id, cap, %{attack: :reconnect_replay}) end,
      :wrong_owner,
      probe
    )
  end

  defp assert_denied_no_server_delivery(fun, reason, probe) do
    before_count = ProbeServer.stats(probe).call_count
    assert {:error, ^reason} = fun.()
    assert %{call_count: ^before_count} = ProbeServer.stats(probe)
    assert_audit_for_reason(reason)
  end

  defp assert_denied_no_tab_delivery(fun, reason, tab_pid) do
    before_count = ProbeTab.delivered_count(tab_pid)
    assert {:error, ^reason} = fun.()
    assert ^before_count = ProbeTab.delivered_count(tab_pid)
    assert_audit_for_reason(reason)
  end

  defp assert_audit_for_reason(:expired), do: assert_audit(:expired_cap, reason: :expired)

  defp assert_audit_for_reason(:use_limit_exceeded),
    do: assert_audit(:use_limit_exceeded, reason: :use_limit_exceeded)

  defp assert_audit_for_reason(reason), do: assert_audit(:deny, reason: reason)

  defp assert_audit(type, filters) do
    assert Enum.any?(Lattice.audit_events(), fn event ->
             event.type == type and
               Enum.all?(filters, fn {key, value} -> event.metadata[key] == value end)
           end)
  end
end
