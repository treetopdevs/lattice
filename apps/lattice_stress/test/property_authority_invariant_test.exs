defmodule LatticeStress.PropertyAuthorityInvariantTest do
  use ExUnit.Case, async: false
  use ExUnitProperties

  alias LatticeStress.{ProbeServer, ProbeTab}

  @commands [
    :connect,
    :disconnect,
    :eject,
    :reconnect_user,
    :grant,
    :revoke,
    :call,
    :cast,
    :forged_call,
    :stolen_cap_use,
    :expired_cap_use,
    :bridge,
    :revoke_bridge,
    :bridge_call,
    :third_party_bridge_use,
    :direct_tab_to_tab,
    :spawn_worker,
    :crash_worker,
    :crash_demo_target,
    :movable_process,
    :malformed_transport_envelope
  ]

  property "random authority command sequences preserve Lattice invariants" do
    check all(
            commands <- list_of(member_of(@commands), min_length: 25, max_length: 80),
            max_runs: 50
          ) do
      Lattice.reset!()
      Lattice.Demo.SecretServer.reset_deliveries()
      {:ok, probe} = ProbeServer.start_link(owner: self(), name: :property_probe)

      initial = %{
        step: 0,
        probe: probe,
        tabs: [],
        caps: [],
        bridges: [],
        workers: [],
        movables: []
      }

      final =
        Enum.reduce(commands, initial, fn command, state ->
          state = %{state | step: state.step + 1}
          state = run_command(command, state)
          assert_invariants(state)
          state
        end)

      Enum.each(connected_tabs(final), &Lattice.disconnect_tab(&1.id))
      assert_invariants(%{final | tabs: mark_all_closed(final.tabs)})
    end
  end

  defp run_command(:connect, state) do
    connect_user(state, "user_#{state.step}")
  end

  defp run_command(:reconnect_user, state) do
    user = "logical_user_#{rem(state.step, 4)}"
    connect_user(state, user)
  end

  defp run_command(:disconnect, state) do
    with {:ok, tab_entry} <- pick_connected(state.tabs, state.step),
         {:ok, _closed} <- Lattice.disconnect_tab(tab_entry.tab.id) do
      %{state | tabs: update_tab_state(state.tabs, tab_entry.tab.id, :disconnected)}
    else
      _ -> state
    end
  end

  defp run_command(:eject, state) do
    with {:ok, tab_entry} <- pick_connected(state.tabs, state.step),
         {:ok, _closed} <- Lattice.eject(tab_entry.tab.id, :property_eject) do
      %{state | tabs: update_tab_state(state.tabs, tab_entry.tab.id, :ejected)}
    else
      _ -> state
    end
  end

  defp run_command(:grant, state) do
    case pick_connected(state.tabs, state.step) do
      {:ok, tab_entry} ->
        case Lattice.grant(tab_entry.tab.id, state.probe, [:call, :cast]) do
          {:ok, cap} ->
            %{state | caps: [%{cap: cap, owner: tab_entry.tab.id, kind: :server} | state.caps]}

          {:error, _reason} ->
            state
        end

      :error ->
        state
    end
  end

  defp run_command(:revoke, state) do
    case pick(state.caps, state.step) do
      {:ok, cap_entry} ->
        :ok = Lattice.revoke(cap_entry.cap, :property_revoke)
        state

      :error ->
        state
    end
  end

  defp run_command(:call, state) do
    case pick(state.caps, state.step) do
      {:ok, %{cap: cap, owner: owner, kind: :server}} ->
        before_count = ProbeServer.stats(state.probe).call_count
        result = Lattice.call(owner, cap, %{step: state.step})
        assert_delivery_matches_result(result, state.probe, before_count)
        state

      _ ->
        state
    end
  end

  defp run_command(:cast, state) do
    case pick(state.caps, state.step) do
      {:ok, %{cap: cap, owner: owner, kind: :server}} ->
        before_count = ProbeServer.stats(state.probe).cast_count
        result = Lattice.cast(owner, cap, %{step: state.step})

        if result == :ok do
          assert eventually(fn ->
                   ProbeServer.stats(state.probe).cast_count == before_count + 1
                 end)
        else
          assert {:error, _reason} = result
          assert ProbeServer.stats(state.probe).cast_count == before_count
        end

        state

      _ ->
        state
    end
  end

  defp run_command(:forged_call, state) do
    with {:ok, tab_entry} <- pick_connected(state.tabs, state.step) do
      before_count = ProbeServer.stats(state.probe).call_count

      assert {:error, :unknown_cap} =
               Lattice.call(tab_entry.tab.id, Lattice.Cap.random_token(), %{})

      assert ProbeServer.stats(state.probe).call_count == before_count
      assert_audit(:deny, reason: :unknown_cap)
    end

    state
  end

  defp run_command(:stolen_cap_use, state) do
    with {:ok, cap_entry} <- pick(state.caps, state.step),
         {:ok, thief} <- pick_other_connected(state.tabs, cap_entry.owner, state.step) do
      before_count = ProbeServer.stats(state.probe).call_count
      assert {:error, :wrong_owner} = Lattice.call(thief.tab.id, cap_entry.cap, %{stolen: true})
      assert ProbeServer.stats(state.probe).call_count == before_count
      assert_audit(:deny, reason: :wrong_owner)
    end

    state
  end

  defp run_command(:expired_cap_use, state) do
    with {:ok, tab_entry} <- pick_connected(state.tabs, state.step),
         {:ok, cap} <-
           Lattice.grant(tab_entry.tab.id, state.probe, [:call],
             expires_at: System.monotonic_time(:millisecond) - 1
           ) do
      before_count = ProbeServer.stats(state.probe).call_count
      assert {:error, :expired} = Lattice.call(tab_entry.tab.id, cap, %{expired: true})
      assert ProbeServer.stats(state.probe).call_count == before_count
    end

    state
  end

  defp run_command(:bridge, state) do
    case pick_two_connected(state.tabs, state.step) do
      {:ok, from, to} ->
        case Lattice.bridge(from.tab.id, to.tab.id, [:call], ttl: 10_000) do
          {:ok, cap} ->
            bridge = %{cap: cap, from: from.tab.id, to: to.tab.id, to_pid: to.pid}
            %{state | bridges: [bridge | state.bridges]}

          {:error, _reason} ->
            state
        end

      :error ->
        state
    end
  end

  defp run_command(:revoke_bridge, state) do
    case pick(state.bridges, state.step) do
      {:ok, bridge} ->
        :ok = Lattice.revoke(bridge.cap, :property_bridge_revoke)
        state

      :error ->
        state
    end
  end

  defp run_command(:bridge_call, state) do
    case pick(state.bridges, state.step) do
      {:ok, bridge} ->
        before_count = ProbeTab.delivered_count(bridge.to_pid)
        result = Lattice.call(bridge.from, bridge.cap, %{op: :relay, step: state.step})

        case result do
          {:ok, _} -> assert ProbeTab.delivered_count(bridge.to_pid) == before_count + 1
          {:error, _reason} -> assert ProbeTab.delivered_count(bridge.to_pid) == before_count
        end

        state

      :error ->
        state
    end
  end

  defp run_command(:third_party_bridge_use, state) do
    with {:ok, bridge} <- pick(state.bridges, state.step),
         {:ok, third} <- pick_other_connected(state.tabs, bridge.from, state.step) do
      before_count = ProbeTab.delivered_count(bridge.to_pid)
      assert {:error, _reason} = Lattice.call(third.tab.id, bridge.cap, %{op: :relay})
      assert ProbeTab.delivered_count(bridge.to_pid) == before_count
    end

    state
  end

  defp run_command(:direct_tab_to_tab, state) do
    case pick_two_connected(state.tabs, state.step) do
      {:ok, from, to} ->
        {:ok, cap} = Lattice.grant(from.tab.id, {:tab, to.tab.id}, [:call])
        before_count = ProbeTab.delivered_count(to.pid)
        assert {:error, :bridge_required} = Lattice.call(from.tab.id, cap, %{op: :relay})
        assert ProbeTab.delivered_count(to.pid) == before_count

      :error ->
        :ok
    end

    state
  end

  defp run_command(:spawn_worker, state) do
    case pick_connected(state.tabs, state.step) do
      {:ok, tab_entry} ->
        {:ok, worker} = Lattice.spawn_linked(tab_entry.tab.id, Lattice.Demo.TabWorker, [], [])
        %{state | workers: [%{pid: worker, tab_id: tab_entry.tab.id} | state.workers]}

      :error ->
        state
    end
  end

  defp run_command(:crash_worker, state) do
    case pick(state.workers, state.step) do
      {:ok, worker} ->
        if Process.alive?(worker.pid), do: Process.exit(worker.pid, :kill)
        state

      :error ->
        state
    end
  end

  defp run_command(:crash_demo_target, state) do
    if Process.alive?(state.probe), do: ProbeServer.crash(state.probe)
    {:ok, probe} = ProbeServer.start_link(owner: self(), name: {:property_probe, state.step})
    %{state | probe: probe}
  end

  defp run_command(:movable_process, state) do
    case pick_connected(state.tabs, state.step) do
      {:ok, tab_entry} ->
        {:ok, proc} = Lattice.MovableProcess.new(tab_entry.tab.id)
        assert {:ok, _} = Lattice.MovableProcess.generate_storyboard(proc, "property")
        _ = Lattice.MovableProcess.render_preview(proc)
        %{state | movables: [proc | state.movables]}

      :error ->
        state
    end
  end

  defp run_command(:malformed_transport_envelope, state) do
    with {:ok, tab_entry} <- pick_connected(state.tabs, state.step) do
      before_count = ProbeServer.stats(state.probe).call_count
      assert {:error, :malformed_cap} = Lattice.call(tab_entry.tab.id, %{bad: "cap"}, %{})
      assert ProbeServer.stats(state.probe).call_count == before_count
    end

    state
  end

  defp connect_user(state, user) do
    {:ok, pid, tab} =
      ProbeTab.connect(
        identity: %{user: user},
        handlers: [relay: fn payload -> %{relayed: payload} end]
      )

    %{state | tabs: [%{pid: pid, tab: tab, state: :connected} | state.tabs]}
  end

  defp assert_delivery_matches_result({:ok, _}, probe, before_count) do
    assert ProbeServer.stats(probe).call_count == before_count + 1
  end

  defp assert_delivery_matches_result({:error, _reason}, probe, before_count) do
    assert ProbeServer.stats(probe).call_count == before_count
  end

  defp assert_invariants(state) do
    diagnostics = Lattice.diagnostics()
    connected_ids = diagnostics.topology.connected_tab_ids

    assert [] = Lattice.Demo.SecretServer.deliveries()

    Enum.each(diagnostics.caps.active_caps, fn {_id, cap} ->
      assert MapSet.member?(connected_ids, cap.owner_tab_id)
    end)

    Enum.each(state.workers, fn worker ->
      unless MapSet.member?(connected_ids, worker.tab_id) do
        refute Process.alive?(worker.pid)
      end
    end)

    Enum.each(diagnostics.topology.tabs, fn {tab_id, tab} ->
      if tab.state == :connected do
        assert MapSet.member?(connected_ids, tab_id)
      else
        refute MapSet.member?(connected_ids, tab_id)
      end
    end)
  end

  defp connected_tabs(state) do
    Enum.filter(state.tabs, &(&1.state == :connected))
    |> Enum.map(& &1.tab)
  end

  defp mark_all_closed(tabs), do: Enum.map(tabs, &%{&1 | state: :disconnected})

  defp update_tab_state(tabs, tab_id, state) do
    Enum.map(tabs, fn
      %{tab: %{id: ^tab_id}} = entry -> %{entry | state: state}
      entry -> entry
    end)
  end

  defp pick_connected(tabs, step) do
    tabs
    |> Enum.filter(&(&1.state == :connected))
    |> pick(step)
  end

  defp pick_other_connected(tabs, tab_id, step) do
    tabs
    |> Enum.filter(&(&1.state == :connected and &1.tab.id != tab_id))
    |> pick(step)
  end

  defp pick_two_connected(tabs, step) do
    connected = Enum.filter(tabs, &(&1.state == :connected))

    if length(connected) < 2 do
      :error
    else
      first = Enum.at(connected, rem(step, length(connected)))
      second = Enum.at(connected, rem(step + 1, length(connected)))
      {:ok, first, second}
    end
  end

  defp pick([], _step), do: :error
  defp pick(list, step), do: {:ok, Enum.at(list, rem(step, length(list)))}

  defp eventually(fun, attempts \\ 20)

  defp eventually(fun, attempts) when attempts > 0 do
    if fun.() do
      true
    else
      Process.sleep(5)
      eventually(fun, attempts - 1)
    end
  end

  defp eventually(_fun, 0), do: false

  defp assert_audit(type, filters) do
    assert Enum.any?(Lattice.audit_events(), fn event ->
             event.type == type and
               Enum.all?(filters, fn {key, value} -> event.metadata[key] == value end)
           end)
  end
end
