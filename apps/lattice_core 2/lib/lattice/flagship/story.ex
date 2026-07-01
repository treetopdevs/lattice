defmodule Lattice.Flagship.Story do
  @moduledoc """
  Runtime state transitions for the flagship story.
  """

  alias Lattice.Demo.LocalTab
  alias Lattice.Flagship.{Scenario, Wallet}

  def new_action_token, do: Lattice.Realm.random_id(24)

  def initial_state(action_token \\ new_action_token()) do
    %{
      wallet_pid: nil,
      inspector_pid: nil,
      wallet_client_pid: nil,
      agent_client_pid: nil,
      attacker_client_pid: nil,
      wallet_tab: nil,
      agent_tab: nil,
      attacker_tab: nil,
      cap: nil,
      current_step: nil,
      action_token: action_token,
      results: %{},
      steps:
        Map.new(Scenario.step_order(), fn step ->
          {step, %{status: :pending, detail: Scenario.pending_detail(step)}}
        end)
    }
  end

  def apply_action(:reset, state), do: reset(state)
  def apply_action(:connect, state), do: ensure_connected(state)
  def apply_action(:grant, state), do: state |> ensure_connected() |> ensure_granted()

  def apply_action(action, state)
      when action in [:allowed, :over_budget, :wrong_vendor, :stolen] do
    {_result, state} = invoke(action, state)
    state
  end

  def apply_action(:revoke, state), do: revoke(state)

  def apply_action(:replay, state) do
    state = state |> ensure_connected() |> ensure_granted()
    state = if state.cap && not state.cap.revoked?, do: revoke_state_cap(state), else: state
    {_result, state} = invoke(:replay, state)
    state
  end

  def apply_action(:run_all, state), do: run_all(state)

  def reset(state) do
    reset_runtime(state)
    state = initial_state()
    record_story(:reset, :done, "Scenario reset. No authority edges are live yet.")
    state
  end

  def run_all(state) do
    reset_runtime(state)

    initial_state()
    |> ensure_connected()
    |> ensure_granted()
    |> invoke_all([:allowed, :over_budget, :wrong_vendor, :stolen])
    |> revoke_state_cap()
    |> invoke_all([:replay])
  end

  def ensure_connected(%{wallet_pid: wallet_pid} = state) when is_pid(wallet_pid), do: state

  def ensure_connected(state) do
    Lattice.reset!()

    {:ok, wallet_pid} = GenServer.start(Wallet, label: "Flagship wallet")
    {:ok, inspector_pid} = GenServer.start(Lattice.Graph.Inspector, [])
    {:ok, wallet_client_pid, wallet_tab} = LocalTab.connect(identity: %{role: "wallet_tab"})
    {:ok, agent_client_pid, agent_tab} = LocalTab.connect(identity: %{role: "planner_agent"})
    {:ok, attacker_client_pid, attacker_tab} = LocalTab.connect(identity: %{role: "red_team"})

    state
    |> Map.merge(%{
      wallet_pid: wallet_pid,
      inspector_pid: inspector_pid,
      wallet_client_pid: wallet_client_pid,
      agent_client_pid: agent_client_pid,
      attacker_client_pid: attacker_client_pid,
      wallet_tab: wallet_tab,
      agent_tab: agent_tab,
      attacker_tab: attacker_tab
    })
    |> register_annotations()
    |> mark_step(
      :connect,
      :done,
      "Wallet, planner, red-team tab, gateway, cap store, audit, and graph inspector are live."
    )
    |> tap(fn _state ->
      record_story(:connect, :done, "Three tab realms connected with zero ambient authority.")
    end)
  end

  def ensure_granted(%{cap: %{id: _id}} = state), do: state

  def ensure_granted(state) do
    state = ensure_connected(state)

    {:ok, cap} =
      Lattice.grant(
        state.agent_tab.id,
        state.wallet_pid,
        [:call],
        Scenario.grant_opts(state.wallet_tab.id)
      )

    Lattice.Graph.Annotations.register_edge!(%{
      from: "tab:#{state.wallet_tab.id}",
      to: "cap:#{cap.id}",
      kind: "consents",
      status: "allowed",
      label: "wallet consent"
    })

    Lattice.Graph.Annotations.register_edge!(%{
      from: "tab:#{state.agent_tab.id}",
      to: "cap:#{cap.id}",
      kind: "holds_cap",
      status: "live",
      label: "planner holds caveated cap"
    })

    %{state | cap: cap}
    |> mark_step(
      :grant,
      :done,
      "Wallet issued one caveated cap: vendor bookshop, amount <= $300, confirmation required."
    )
  end

  def revoke(state) do
    state = state |> ensure_connected() |> ensure_granted()

    case state.cap do
      nil ->
        mark_step(state, :revoke, :failed, "No cap exists to revoke.")

      cap ->
        :ok = Lattice.revoke(cap, :flagship_demo)

        Lattice.Graph.Annotations.register_edge!(%{
          from: "tab:#{state.agent_tab.id}",
          to: "cap:#{cap.id}",
          kind: "revoked",
          status: "revoked",
          reason: "flagship_demo"
        })

        %{state | cap: %{cap | revoked?: true}}
        |> mark_step(
          :revoke,
          :done,
          "Wallet consent revoked the cap. The graph edge turns inactive."
        )
    end
  end

  def invoke(kind, state) do
    state = state |> ensure_connected() |> ensure_granted()
    before_count = Wallet.delivery_count(state.wallet_pid)
    {tab_id, payload, expectation, label} = Scenario.invocation(kind, state)
    result = Lattice.call(tab_id, state.cap, payload)
    after_count = Wallet.delivery_count(state.wallet_pid)
    delivered? = after_count > before_count

    state =
      state
      |> add_result(kind, result, delivered?)
      |> mark_invocation_step(kind, result, delivered?, expectation, label)

    {{:ok, Map.fetch!(state.results, kind)}, state}
  end

  def revoke_state_cap(state) do
    :ok = Lattice.revoke(state.cap, :flagship_demo)

    Lattice.Graph.Annotations.register_edge!(%{
      from: "tab:#{state.agent_tab.id}",
      to: "cap:#{state.cap.id}",
      kind: "revoked",
      status: "revoked",
      reason: "flagship_demo"
    })

    state
    |> update_in([:cap], &%{&1 | revoked?: true})
    |> mark_step(:revoke, :done, "Wallet consent revoked the cap. Replay must now fail.")
  end

  defp invoke_all(state, actions) do
    Enum.reduce(actions, state, fn action, state ->
      {_reply, state} = invoke(action, state)
      state
    end)
  end

  defp mark_invocation_step(state, kind, result, delivered?, expectation, label) do
    status =
      case {expectation, result, delivered?} do
        {:delivered, {:ok, _}, true} -> :done
        {:denied, {:error, _}, false} -> :done
        _ -> :failed
      end

    {reason_text, reason} =
      case result do
        {:ok, _reply} -> {"allowed and delivered to wallet", nil}
        {:error, reason} -> {"denied: #{inspect(reason)}", reason}
      end

    mark_step(state, kind, status, "#{label} Result: #{reason_text}.", reason: reason)
  end

  defp add_result(state, kind, result, delivered?) do
    record = %{
      action: kind,
      result: normalize_result(result),
      expected_result: Scenario.expected_result(kind),
      delivered_to_wallet?: delivered?,
      wallet_delivery_count: Wallet.delivery_count(state.wallet_pid),
      audit_count: length(Lattice.audit_events())
    }

    %{state | results: Map.put(state.results, kind, record)}
  end

  defp mark_step(state, step, status, detail, attrs \\ []) do
    step_state =
      state.steps
      |> Map.fetch!(step)
      |> Map.merge(%{status: status, detail: detail})
      |> maybe_put_reason(Keyword.get(attrs, :reason))

    %{state | steps: Map.put(state.steps, step, step_state), current_step: step}
  end

  defp maybe_put_reason(step_state, nil), do: Map.delete(step_state, :reason)
  defp maybe_put_reason(step_state, reason), do: Map.put(step_state, :reason, inspect(reason))

  defp register_annotations(state) do
    [
      %{
        id: "process:wallet",
        kind: "server_process",
        label: "Wallet process",
        realm: "server",
        lifecycle_state: "connected",
        pid: inspect(state.wallet_pid)
      },
      %{
        id: "process:graph_inspector",
        kind: "server_process",
        label: "GraphInspector",
        realm: "server",
        lifecycle_state: "connected",
        pid: inspect(state.inspector_pid)
      }
    ]
    |> Enum.each(&Lattice.Graph.Annotations.register_node/1)

    Lattice.Graph.Annotations.register_edge!(%{
      from: "process:graph_inspector",
      to: "process:audit",
      kind: "observes"
    })

    Lattice.Graph.Annotations.register_edge!(%{
      from: "process:graph_inspector",
      to: "process:cap_store",
      kind: "observes"
    })

    state
  end

  defp normalize_result({:ok, result}), do: %{ok: true, result: result}
  defp normalize_result({:error, reason}), do: %{ok: false, error: inspect(reason)}

  defp record_story(action, status, detail) do
    Lattice.Audit.record(:flagship_step, %{action: action, status: status, detail: detail})
  end

  defp reset_runtime(state) do
    stop_demo_processes(state)
    Lattice.reset!()
  end

  defp stop_demo_processes(state) do
    [
      state.wallet_pid,
      state.inspector_pid,
      state.wallet_client_pid,
      state.agent_client_pid,
      state.attacker_client_pid
    ]
    |> Enum.each(&stop_process/1)
  end

  defp stop_process(pid) when is_pid(pid) do
    if Process.alive?(pid) do
      GenServer.stop(pid, :normal, 1_000)
    end
  catch
    :exit, :noproc -> :ok
    :exit, {:noproc, _} -> :ok
  end

  defp stop_process(_other), do: :ok
end
