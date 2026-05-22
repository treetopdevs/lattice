defmodule LatticeCore.ResearchTest do
  use ExUnit.Case, async: false

  alias Lattice.Cap.Caveat
  alias Lattice.Causality
  alias Lattice.Demo.{AgentTools, CapWallet, FederatedWorkers, LiveIntrospection, LocalTab}
  alias Lattice.Graph
  alias Lattice.RedTeam.Sandbox

  defmodule TestWorker do
    use GenServer

    def start_link(tab_id, args, opts) do
      GenServer.start_link(__MODULE__, {tab_id, args, opts})
    end

    def init({tab_id, args, opts}), do: {:ok, %{tab_id: tab_id, args: args, opts: opts}}
  end

  setup do
    Lattice.reset!()
    :ok
  end

  describe "PID-as-cap and attenuated authority" do
    test "child caps cannot exceed parent authority and caveats compose monotonically" do
      {:ok, wallet} = CapWallet.start_link([])
      {:ok, _wallet_pid, wallet_tab} = LocalTab.connect(identity: %{role: "wallet"})
      {:ok, _merchant_pid, merchant_tab} = LocalTab.connect(identity: %{role: "merchant"})

      {:ok, parent} =
        Lattice.grant(wallet_tab.id, wallet, [:call],
          amount_max: 100,
          vendor: "bookshop",
          delegation_allowed?: true,
          delegation: :allowed,
          provenance_label: "wallet-consent"
        )

      assert {:error, :authority_escalation} =
               Lattice.delegate(parent, merchant_tab.id,
                 ops: [:cast],
                 amount_max: 25,
                 vendor: "bookshop",
                 provenance_label: "wallet-consent"
               )

      {:ok, child} =
        Lattice.delegate(parent, merchant_tab.id,
          ops: [:call],
          amount_max: 25,
          vendor: "bookshop",
          requires_confirmation: true,
          provenance_label: "wallet-consent",
          use_limit: 2
        )

      assert child.parent_id == parent.id
      assert child.root_id == parent.root_id
      assert [%{"parent_id" => parent_id, "to_tab_id" => to_tab_id}] = child.provenance
      assert parent_id == parent.id
      assert to_tab_id == merchant_tab.id
      assert Caveat.strongest_number(child.caveats, :amount_max) == 25
      assert Caveat.strongest_symbol(child.caveats, :vendor) == "bookshop"

      assert {:ok, %{charged: 20}} =
               Lattice.call(merchant_tab.id, child, %{
                 amount: 20,
                 vendor: "bookshop",
                 confirmed?: true,
                 provenance_label: "wallet-consent"
               })

      assert {:error, :amount_exceeds_caveat} =
               Lattice.call(merchant_tab.id, child, %{
                 amount: 30,
                 vendor: "bookshop",
                 confirmed?: true,
                 provenance_label: "wallet-consent"
               })

      assert {:error, :vendor_not_allowed} =
               Lattice.call(merchant_tab.id, child, %{
                 amount: 10,
                 vendor: "other-shop",
                 confirmed?: true,
                 provenance_label: "wallet-consent"
               })

      assert {:error, :confirmation_required} =
               Lattice.call(merchant_tab.id, child, %{
                 amount: 10,
                 vendor: "bookshop",
                 provenance_label: "wallet-consent"
               })

      assert :ok = Lattice.revoke(parent, :wallet_closed)

      assert {:error, :revoked} =
               Lattice.call(merchant_tab.id, child, %{
                 amount: 5,
                 vendor: "bookshop",
                 confirmed?: true,
                 provenance_label: "wallet-consent"
               })
    end

    test "child caps cannot remove a parent use limit" do
      {:ok, wallet} = CapWallet.start_link([])
      {:ok, _wallet_pid, wallet_tab} = LocalTab.connect(identity: %{role: "wallet"})
      {:ok, _merchant_pid, merchant_tab} = LocalTab.connect(identity: %{role: "merchant"})

      {:ok, parent} =
        Lattice.grant(wallet_tab.id, wallet, [:call],
          delegation_allowed?: true,
          use_limit: 1
        )

      assert {:error, :use_limit_escalation} =
               Lattice.delegate(parent, merchant_tab.id, use_limit: nil)
    end

    test "confused-deputy overreach is structurally rejected by the membrane" do
      result = CapWallet.run_demo()

      assert {:ok, %{charged: 40, vendor: "bookshop"}} = result.allowed
      assert {:error, :amount_exceeds_caveat} = result.overreach
      assert {:error, :ambient_target_rejected} = result.confused_deputy
      assert [%{amount: 40, vendor: "bookshop"}] = result.ledger
    end
  end

  describe "runtime typed and session capabilities" do
    test "payload schemas and session automata are checked at authorization time" do
      {:ok, wallet} = CapWallet.start_link([])
      {:ok, _pid, tab} = LocalTab.connect(identity: %{role: "session-client"})

      {:ok, cap} =
        Lattice.grant(tab.id, wallet, [:call],
          schema: %{amount: :number, vendor: :string, session_step: :atom},
          session: %{
            state: :ready,
            transitions: %{
              ready: %{authorize: :authorized},
              authorized: %{capture: :closed}
            }
          }
        )

      assert {:error, {:payload_type_mismatch, :amount, :number}} =
               Lattice.call(tab.id, cap, %{
                 amount: "five",
                 vendor: "books",
                 session_step: :authorize
               })

      assert {:error, {:session_step_not_allowed, :ready, :capture}} =
               Lattice.call(tab.id, cap, %{
                 amount: 5,
                 vendor: "books",
                 session_step: :capture
               })

      assert {:ok, %{charged: 5}} =
               Lattice.call(tab.id, cap, %{amount: 5, vendor: "books", session_step: :authorize})

      assert {:ok, %{charged: 5}} =
               Lattice.call(tab.id, cap, %{amount: 5, vendor: "books", session_step: :capture})

      assert {:error, {:session_step_not_allowed, :closed, :capture}} =
               Lattice.call(tab.id, cap, %{amount: 5, vendor: "books", session_step: :capture})
    end

    test "payload session-step strings do not create atoms" do
      {:ok, wallet} = CapWallet.start_link([])
      {:ok, _pid, tab} = LocalTab.connect(identity: %{role: "session-client"})

      {:ok, cap} =
        Lattice.grant(tab.id, wallet, [:call],
          session: %{
            state: :ready,
            transitions: %{ready: %{authorize: :authorized}}
          }
        )

      step = "attacker_step_#{System.unique_integer([:positive])}"

      assert {:error, {:session_step_not_allowed, :ready, ^step}} =
               Lattice.call(tab.id, cap, %{"session_step" => step})

      assert_raise ArgumentError, fn -> String.to_existing_atom(step) end
    end
  end

  describe "graph as trust graph" do
    test "graph exports include caps, bridges, workers, and policy status" do
      {:ok, wallet} = CapWallet.start_link([])
      {:ok, _pid_a, tab_a} = LocalTab.connect(identity: %{role: "a"})

      {:ok, _pid_b, tab_b} =
        LocalTab.connect(
          identity: %{role: "b"},
          handlers: [relay: fn payload -> %{ok: payload[:body]} end]
        )

      {:ok, cap} = Lattice.grant(tab_a.id, wallet, [:call])
      {:ok, bridge_cap} = Lattice.bridge(tab_a.id, tab_b.id, [:call], ttl: 5_000)
      {:ok, worker} = Lattice.spawn_linked(tab_a.id, TestWorker, [], [])

      snapshot = Graph.snapshot()

      assert Enum.any?(snapshot.nodes, &(&1.id == "cap:#{cap.id}"))
      assert Enum.any?(snapshot.nodes, &(&1.id == "cap:#{bridge_cap.id}"))
      assert Enum.any?(snapshot.nodes, &(&1.id == "process:#{inspect(worker)}"))
      assert snapshot.policy.status == "ok"

      assert Graph.Export.export(snapshot, :json) =~ "\"nodes\""
      assert Graph.Export.export(snapshot, :dot) =~ "digraph lattice"
      assert Graph.Export.export(snapshot, :mermaid) =~ "graph TD"
    end

    test "policy detects live caps from dead tabs and tab-to-tab edges without bridge policy" do
      {:ok, _pid_a, tab_a} = LocalTab.connect(identity: %{role: "a"})
      {:ok, _pid_b, tab_b} = LocalTab.connect(identity: %{role: "b"})

      {:ok, _cap} = Lattice.grant(tab_a.id, {:tab, tab_b.id}, [:call])
      assert {:ok, _closed} = Lattice.Topology.disconnect_tab(tab_a.id)

      policy = Graph.Policy.check_current()

      assert policy.status == "violation"
      assert Enum.any?(policy.violations, &(&1.type == :live_cap_from_dead_tab))
      assert Enum.any?(policy.violations, &(&1.type == :tab_to_tab_edge_without_bridge_policy))
    end
  end

  describe "causality and dynamic IFC" do
    test "capability-attested causality detects tampering" do
      {:ok, wallet} = CapWallet.start_link([])
      {:ok, _pid, tab} = LocalTab.connect(identity: %{role: "causal-client"})
      {:ok, cap} = Lattice.grant(tab.id, wallet, [:call])

      trace =
        cap
        |> Causality.new(:wallet_payment)
        |> Causality.attest(cap, %{op: :authorize, amount: 5})
        |> Causality.attest(cap, %{op: :capture, amount: 5})

      assert :ok = Causality.verify(trace)

      tampered =
        update_in(trace, [:events, Access.at(0), :event], fn _ ->
          %{op: :authorize, amount: 500}
        end)

      assert {:error, {:invalid_event_hash, 1}} = Causality.verify(tampered)
    end

    test "dynamic IFC denies sensitive labels flowing to public realms" do
      assert :ok = Lattice.IFC.label("server-secret", :secret)
      assert :ok = Lattice.IFC.label("public-tab", :public)

      assert {:error, :ifc_violation} =
               Lattice.IFC.transfer("server-secret", "public-tab", %{secret: "classified"})

      assert {:ok, %{headline: "ok"}} =
               Lattice.IFC.transfer("public-tab", "server-secret", %{headline: "ok"},
                 label: :public
               )

      snapshot = Lattice.IFC.snapshot()
      assert Enum.any?(snapshot.flows, &(&1.allowed? == false))
      assert Graph.Policy.check_current().status == "ok"
    end
  end

  describe "research demo modules" do
    test "agent tools, introspection, federation, and red-team demos enforce boundaries" do
      agent = AgentTools.run_demo()
      assert {:ok, %{charged: 10}} = agent.allowed
      assert {:error, :amount_exceeds_caveat} = agent.over_budget
      assert {:error, :unknown_cap} = agent.forged

      Lattice.reset!()
      introspection = LiveIntrospection.run_demo()
      assert {:error, :unknown_cap} = introspection.before_consent
      assert {:error, :confirmation_required} = introspection.unconfirmed
      assert {:ok, %{nodes: nodes, edges: edges}} = introspection.confirmed
      assert is_list(nodes)
      assert is_list(edges)

      Lattice.reset!()
      federation = FederatedWorkers.run_demo()
      assert federation.status == :requires_connected_browser_workers
      assert federation.worker_client == "/worker-client.js"
      assert federation.endpoint == "/api/federated-workers/run"

      Lattice.reset!()
      attacks = Sandbox.run()
      assert {:error, :unknown_cap} = attacks.forged_cap
      assert {:error, :wrong_owner} = attacks.stolen_cap
      assert {:error, :amount_exceeds_caveat} = attacks.over_amount
      assert {:error, :vendor_not_allowed} = attacks.wrong_vendor
      assert {:error, :confirmation_required} = attacks.missing_confirmation
      assert {:error, :bridge_required} = attacks.no_tab_bridge
      assert {:error, :ifc_violation} = attacks.secret_to_public_ifc
    end
  end
end
