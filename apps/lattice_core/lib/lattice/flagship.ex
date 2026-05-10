defmodule Lattice.Flagship do
  @moduledoc """
  Canonical runnable scenario for the live process/trust graph demo.

  The story is intentionally narrow: a wallet realm consents to a caveated cap
  for a planner tab, the allowed purchase reaches the wallet process, and every
  overreach is denied before delivery.
  """

  use GenServer

  alias Lattice.Demo.LocalTab
  alias Lattice.Flagship.Wallet

  @limit 300
  @vendor "bookshop"
  @provenance_label "wallet-consent"

  @step_order [
    :connect,
    :grant,
    :allowed,
    :over_budget,
    :wrong_vendor,
    :stolen,
    :revoke,
    :replay
  ]

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, initial_state(), name: __MODULE__)
  end

  def reset, do: GenServer.call(__MODULE__, :reset)
  def connect, do: GenServer.call(__MODULE__, :connect)
  def grant, do: GenServer.call(__MODULE__, :grant)
  def allowed, do: GenServer.call(__MODULE__, :allowed)
  def over_budget, do: GenServer.call(__MODULE__, :over_budget)
  def wrong_vendor, do: GenServer.call(__MODULE__, :wrong_vendor)
  def stolen, do: GenServer.call(__MODULE__, :stolen)
  def revoke, do: GenServer.call(__MODULE__, :revoke)
  def replay, do: GenServer.call(__MODULE__, :replay)
  def run_all, do: GenServer.call(__MODULE__, :run_all, 10_000)
  def snapshot, do: GenServer.call(__MODULE__, :snapshot)
  def export(format), do: GenServer.call(__MODULE__, {:export, format})

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call(:reset, _from, state) do
    stop_demo_processes(state)
    Lattice.reset!()
    state = initial_state()
    record_story(:reset, :done, "Scenario reset. No authority edges are live yet.")
    {:reply, {:ok, snapshot_from(state)}, state}
  end

  def handle_call(:connect, _from, state) do
    state = ensure_connected(state)
    {:reply, {:ok, snapshot_from(state)}, state}
  end

  def handle_call(:grant, _from, state) do
    state = state |> ensure_connected() |> ensure_granted()
    {:reply, {:ok, snapshot_from(state)}, state}
  end

  def handle_call(:allowed, _from, state) do
    {_result, state} = invoke(:allowed, state)
    {:reply, {:ok, snapshot_from(state)}, state}
  end

  def handle_call(:over_budget, _from, state) do
    {_result, state} = invoke(:over_budget, state)
    {:reply, {:ok, snapshot_from(state)}, state}
  end

  def handle_call(:wrong_vendor, _from, state) do
    {_result, state} = invoke(:wrong_vendor, state)
    {:reply, {:ok, snapshot_from(state)}, state}
  end

  def handle_call(:stolen, _from, state) do
    {_result, state} = invoke(:stolen, state)
    {:reply, {:ok, snapshot_from(state)}, state}
  end

  def handle_call(:revoke, _from, state) do
    state = state |> ensure_connected() |> ensure_granted()

    state =
      case state.cap do
        nil ->
          mark_step(state, :revoke, :failed, "No cap exists to revoke.")

        cap ->
          :ok = Lattice.revoke(cap, :flagship_demo)

          register_annotation_edge(%{
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

    {:reply, {:ok, snapshot_from(state)}, state}
  end

  def handle_call(:replay, _from, state) do
    state = state |> ensure_connected() |> ensure_granted()
    state = if state.cap && not state.cap.revoked?, do: revoke_state_cap(state), else: state
    {_result, state} = invoke(:replay, state)
    {:reply, {:ok, snapshot_from(state)}, state}
  end

  def handle_call(:run_all, _from, state) do
    stop_demo_processes(state)
    Lattice.reset!()

    state =
      initial_state()
      |> ensure_connected()
      |> ensure_granted()
      |> elem_from_invoke(:allowed)
      |> elem_from_invoke(:over_budget)
      |> elem_from_invoke(:wrong_vendor)
      |> elem_from_invoke(:stolen)
      |> revoke_state_cap()
      |> elem_from_invoke(:replay)

    {:reply, {:ok, snapshot_from(state)}, state}
  end

  def handle_call(:snapshot, _from, state) do
    {:reply, snapshot_from(state), state}
  end

  def handle_call({:export, format}, _from, state) do
    snapshot = snapshot_from(state)

    body =
      case format do
        "mermaid" -> Lattice.Graph.Export.export(snapshot.graph, :mermaid)
        "dot" -> Lattice.Graph.Export.export(snapshot.graph, :dot)
        _ -> Jason.encode!(snapshot, pretty: true)
      end

    {:reply, {:ok, body}, state}
  end

  defp ensure_connected(%{wallet_pid: wallet_pid} = state) when is_pid(wallet_pid), do: state

  defp ensure_connected(state) do
    Lattice.reset!()

    {:ok, wallet_pid} = GenServer.start(Wallet, label: "Flagship wallet")
    {:ok, inspector_pid} = GenServer.start(Lattice.Graph.Inspector, [])
    {:ok, _wallet_client, wallet_tab} = LocalTab.connect(identity: %{role: "wallet_tab"})
    {:ok, _agent_client, agent_tab} = LocalTab.connect(identity: %{role: "planner_agent"})
    {:ok, _attacker_client, attacker_tab} = LocalTab.connect(identity: %{role: "red_team"})

    state =
      %{
        state
        | wallet_pid: wallet_pid,
          inspector_pid: inspector_pid,
          wallet_tab: wallet_tab,
          agent_tab: agent_tab,
          attacker_tab: attacker_tab
      }
      |> register_annotations()
      |> mark_step(
        :connect,
        :done,
        "Wallet, planner, red-team tab, gateway, cap store, audit, and graph inspector are live."
      )

    record_story(:connect, :done, "Three tab realms connected with zero ambient authority.")
    state
  end

  defp ensure_granted(%{cap: %{id: _id}} = state), do: state

  defp ensure_granted(state) do
    state = ensure_connected(state)

    {:ok, cap} =
      Lattice.grant(state.agent_tab.id, state.wallet_pid, [:call],
        issuer: {:wallet_tab, state.wallet_tab.id},
        amount_max: @limit,
        vendor: @vendor,
        requires_confirmation: true,
        provenance_label: @provenance_label,
        ttl: 120_000,
        audit: %{consented_by: state.wallet_tab.id, demo: "flagship"}
      )

    register_annotation_edge(%{
      from: "tab:#{state.wallet_tab.id}",
      to: "cap:#{cap.id}",
      kind: "consents",
      status: "allowed",
      label: "wallet consent"
    })

    register_annotation_edge(%{
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

  defp invoke(kind, state) do
    state = state |> ensure_connected() |> ensure_granted()
    before_count = Wallet.delivery_count(state.wallet_pid)
    {tab_id, payload, expectation, label} = invocation(kind, state)
    result = Lattice.call(tab_id, state.cap, payload)
    after_count = Wallet.delivery_count(state.wallet_pid)
    delivered? = after_count > before_count

    state =
      state
      |> add_result(kind, result, delivered?)
      |> mark_invocation_step(kind, result, delivered?, expectation, label)

    {{:ok, Map.fetch!(state.results, kind)}, state}
  end

  defp elem_from_invoke(state, kind) do
    {_reply, state} = invoke(kind, state)
    state
  end

  defp invocation(:allowed, state) do
    {
      state.agent_tab.id,
      %{
        amount: 199,
        vendor: @vendor,
        item: "Systems Programming Book",
        confirmed?: true,
        provenance_label: @provenance_label
      },
      :delivered,
      "Planner invokes the cap within all caveats."
    }
  end

  defp invocation(:over_budget, state) do
    {
      state.agent_tab.id,
      %{
        amount: 425,
        vendor: @vendor,
        item: "Conference travel add-on",
        confirmed?: true,
        provenance_label: @provenance_label
      },
      :denied,
      "Planner tries to exceed the $300 amount caveat."
    }
  end

  defp invocation(:wrong_vendor, state) do
    {
      state.agent_tab.id,
      %{
        amount: 120,
        vendor: "gadget-mart",
        item: "Noise-cancelling headphones",
        confirmed?: true,
        provenance_label: @provenance_label
      },
      :denied,
      "Planner tries the right amount at the wrong vendor."
    }
  end

  defp invocation(:stolen, state) do
    {
      state.attacker_tab.id,
      %{
        amount: 50,
        vendor: @vendor,
        item: "Stolen cap attempt",
        confirmed?: true,
        provenance_label: @provenance_label
      },
      :denied,
      "Red-team tab reuses the planner cap and fails owner checking."
    }
  end

  defp invocation(:replay, state) do
    {
      state.agent_tab.id,
      %{
        amount: 40,
        vendor: @vendor,
        item: "Replay after revoke",
        confirmed?: true,
        provenance_label: @provenance_label
      },
      :denied,
      "Planner replays the revoked cap and fails before delivery."
    }
  end

  defp mark_invocation_step(state, kind, result, delivered?, expectation, label) do
    status =
      case {expectation, result, delivered?} do
        {:delivered, {:ok, _}, true} -> :done
        {:denied, {:error, _}, false} -> :done
        _ -> :failed
      end

    reason =
      case result do
        {:ok, _reply} -> "allowed and delivered to wallet"
        {:error, reason} -> "denied: #{inspect(reason)}"
      end

    mark_step(state, kind, status, "#{label} Result: #{reason}.")
  end

  defp add_result(state, kind, result, delivered?) do
    record = %{
      action: kind,
      result: normalize_result(result),
      delivered_to_wallet?: delivered?,
      wallet_delivery_count: Wallet.delivery_count(state.wallet_pid),
      audit_count: length(Lattice.audit_events())
    }

    %{state | results: Map.put(state.results, kind, record)}
  end

  defp revoke_state_cap(state) do
    :ok = Lattice.revoke(state.cap, :flagship_demo)

    state
    |> update_in([:cap], &%{&1 | revoked?: true})
    |> mark_step(:revoke, :done, "Wallet consent revoked the cap. Replay must now fail.")
  end

  defp mark_step(state, step, status, detail) do
    steps = Map.update!(state.steps, step, &%{&1 | status: status, detail: detail})
    %{state | steps: steps, current_step: step}
  end

  defp register_annotations(state) do
    gateway_pid = Process.whereis(Lattice.Gateway)
    cap_store_pid = Process.whereis(Lattice.CapStore)
    audit_pid = Process.whereis(Lattice.Audit)

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
      },
      %{
        id: "process:gateway",
        kind: "gateway",
        label: "Gateway",
        realm: "server",
        lifecycle_state: if(gateway_pid, do: "connected", else: "virtual")
      },
      %{
        id: "process:cap_store",
        kind: "cap_store",
        label: "CapStore",
        realm: "server",
        lifecycle_state: if(cap_store_pid, do: "connected", else: "virtual")
      },
      %{
        id: "process:audit",
        kind: "audit",
        label: "Audit",
        realm: "server",
        lifecycle_state: if(audit_pid, do: "connected", else: "virtual")
      }
    ]
    |> Enum.each(&Lattice.Graph.Annotations.register_node/1)

    register_annotation_edge(%{
      from: "process:gateway",
      to: "process:cap_store",
      kind: "authorizes_via"
    })

    register_annotation_edge(%{from: "process:gateway", to: "process:audit", kind: "records"})

    register_annotation_edge(%{
      from: "process:graph_inspector",
      to: "process:audit",
      kind: "observes"
    })

    register_annotation_edge(%{
      from: "process:graph_inspector",
      to: "process:cap_store",
      kind: "observes"
    })

    state
  end

  defp register_annotation_edge(edge), do: Lattice.Graph.Annotations.register_edge(edge)

  defp snapshot_from(state) do
    graph = Lattice.Graph.snapshot()
    audit_events = Lattice.audit_events()

    %{
      type: "flagship_snapshot",
      current_step: state.current_step,
      story: story(state),
      actors: actors(state),
      policy: policy(),
      cap: external_cap(state.cap),
      wallet: wallet_state(state),
      results: state.results,
      graph: graph,
      audit_events: audit_events,
      claims: claims(),
      exports: %{
        json: "/api/flagship/export/json",
        mermaid: "/api/flagship/export/mermaid",
        dot: "/api/flagship/export/dot"
      }
    }
  end

  defp story(state) do
    Enum.map(@step_order, fn step ->
      state.steps[step]
      |> Map.put(:id, step)
      |> Map.put(:label, step_label(step))
    end)
  end

  defp actors(state) do
    %{
      wallet_tab_id: state.wallet_tab && state.wallet_tab.id,
      planner_tab_id: state.agent_tab && state.agent_tab.id,
      red_team_tab_id: state.attacker_tab && state.attacker_tab.id,
      wallet_pid: state.wallet_pid && inspect(state.wallet_pid),
      graph_inspector_pid: state.inspector_pid && inspect(state.inspector_pid)
    }
  end

  defp policy do
    %{
      limit: @limit,
      vendor: @vendor,
      required_confirmation: true,
      provenance_label: @provenance_label
    }
  end

  defp wallet_state(%{wallet_pid: pid}) when is_pid(pid) do
    %{ledger: Wallet.ledger(pid), delivery_count: Wallet.delivery_count(pid)}
  end

  defp wallet_state(_state), do: %{ledger: [], delivery_count: 0}

  defp external_cap(nil), do: nil
  defp external_cap(cap), do: Lattice.external_cap(cap)

  defp normalize_result({:ok, result}), do: %{ok: true, result: result}
  defp normalize_result({:error, reason}), do: %{ok: false, error: inspect(reason)}

  defp step_label(:connect), do: "Connect realms"
  defp step_label(:grant), do: "Issue caveated cap"
  defp step_label(:allowed), do: "Approve $199 at bookshop"
  defp step_label(:over_budget), do: "Deny over budget"
  defp step_label(:wrong_vendor), do: "Deny wrong vendor"
  defp step_label(:stolen), do: "Deny stolen cap"
  defp step_label(:revoke), do: "Revoke cap"
  defp step_label(:replay), do: "Deny replay"

  defp claims do
    [
      %{
        claim: "Caveated capability authorizes the wallet edge",
        status: "implemented",
        evidence: "Lattice.CapStore + Lattice.Cap.Caveat + flagship tests"
      },
      %{
        claim: "Denied overreach does not reach the wallet process",
        status: "implemented",
        evidence: "Wallet delivery count remains unchanged after deny"
      },
      %{
        claim: "Process graph is the trust graph",
        status: "implemented",
        evidence: "Lattice.Graph.Snapshot powers UI and export commands"
      },
      %{
        claim: "Browser/worker realms are first-class process realms",
        status: "simulated",
        evidence: "LocalTab and WebSocket demo model browser realms, not AtomVM-WASM"
      },
      %{
        claim: "Formal verification of authority preservation",
        status: "future work",
        evidence: "Operational model and property tests exist, mechanized proof does not"
      }
    ]
  end

  defp record_story(action, status, detail) do
    Lattice.Audit.record(:flagship_step, %{action: action, status: status, detail: detail})
  end

  defp stop_demo_processes(state) do
    Enum.each([state.wallet_pid, state.inspector_pid], fn
      pid when is_pid(pid) ->
        if Process.alive?(pid), do: Process.exit(pid, :kill)

      _other ->
        :ok
    end)
  end

  defp initial_state do
    %{
      wallet_pid: nil,
      inspector_pid: nil,
      wallet_tab: nil,
      agent_tab: nil,
      attacker_tab: nil,
      cap: nil,
      current_step: nil,
      results: %{},
      steps:
        Map.new(@step_order, fn step ->
          {step, %{status: :pending, detail: "Pending"}}
        end)
    }
  end
end
