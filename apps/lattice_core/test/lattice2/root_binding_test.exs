defmodule Lattice2.RootBindingTest do
  @moduledoc """
  Security regression tests for the two authority-soundness gaps from the
  adversarial review:

    * **Root binding** — a replica is cryptographically bound to the key that
      created it, so a forged self-issued genesis cannot seize roles, become the
      revocation superuser, or inject a succession policy. Forged genesis ops are
      quarantined (`:impostor_genesis`), not honored.
    * **Tombstone gate** — the replica-wide, irreversible tombstone kill switch is
      honored only from the bound root. A non-root request is refused, and a
      tombstone op forged by any other realm and synced in is ignored, not obeyed.
  """
  use ExUnit.Case, async: false

  alias Lattice.{Authority, Canonical, Log, Registry, Sim}
  alias Lattice.Authority.Delegation
  alias Lattice.Demo.Thread

  @replica "replica:thread:rootbind"

  setup do
    Lattice.reset!()
    on_exit(fn -> Lattice.reset!() end)
    :ok
  end

  defp founded do
    Sim.new(Thread, @replica, ["server", "tab", "evil"], seed: "rootbind")
    |> Sim.create_replica("server",
      policies: %{moderator: %{successor: "tab", dormant_ticks: 3}}
    )
    |> elem(0)
    |> Sim.sync_all()
  end

  # An attacker self-issues a genesis granting itself roles/ops and syncs it in.
  defp forge_genesis(sim, realm, roles, ops, policies \\ %{}) do
    evil = Sim.identity(sim, realm)
    deleg = Delegation.genesis(evil, Sim.replica(sim), ops: ops, roles: roles, live: true)
    {sim, op} = Sim.append(sim, realm, :authority, {:genesis, deleg, policies})
    {Sim.sync_all(sim), op, deleg}
  end

  defp root_genesis_delegation(sim) do
    sim
    |> Sim.log("server")
    |> Log.topo_ops()
    |> Enum.find_value(fn
      %{body: {:genesis, %Delegation{} = delegation, _policies}} -> delegation
      _other -> nil
    end)
  end

  # --- Root binding --------------------------------------------------------

  test "create_replica binds the replica id to the creator's root key" do
    sim = founded()
    assert Authority.replica_commitment(Sim.replica(sim)) != nil
    # The honest root is unaffected: server still holds every role it granted itself.
    assert Sim.holder(sim, "server", :moderator) == Sim.identity(sim, "server").pub
  end

  test "binding refuses preexisting, empty and repeated root markers" do
    root = Lattice.Identity.from_seed("root", "root-marker-construction")
    bound = Authority.bind_replica("replica:thread:marker", root.pub)

    for name <- ["town#root:x", "town#root:", bound, bound <> "#root:x"] do
      assert_raise ArgumentError, ~r/#root:/, fn -> Authority.bind_replica(name, root.pub) end
    end
  end

  test "root commitment parsing accepts one complete tag and refuses malformed claims" do
    root = Lattice.Identity.from_seed("root", "root-marker-parsing")
    bound = Authority.bind_replica("replica:thread:marker", root.pub)
    tag = :crypto.hash(:sha256, root.pub) |> Base.url_encode64(padding: false)
    assert Authority.replica_commitment(bound) == tag
    assert Authority.replica_commitment("legacy:thread") == nil

    for replica <- [
          "town#root:attacker",
          "town#root:short",
          "town#root:",
          "town#root:#{String.duplicate("!", 43)}",
          bound <> "#root:#{tag}"
        ] do
      assert Authority.replica_commitment(replica) == nil
    end
  end

  test "a malformed root claim cannot fall through as a legacy unbound genesis" do
    root = Lattice.Identity.from_seed("root", "root-marker-refusal")

    for replica <- ["town#root:attacker", "town#root:", "town#root:short#root:second"] do
      {delegation, genesis, log} = root_marker_log(replica, root)
      assert Authority.verify_chain([delegation], replica) == {:error, :impostor_genesis}, replica
      assert Authority.root(log) == nil
      assert Authority.holder(Thread, log, :moderator) == nil
      assert Authority.analyze(Thread, log).reasons[genesis.id] == :impostor_genesis
      refute Authority.delegation_active?(log, delegation.id)
    end
  end

  test "canonical bound and marker-free legacy roots retain their authority" do
    root = Lattice.Identity.from_seed("root", "root-marker-controls")

    for replica <- ["legacy:thread", Authority.bind_replica("bound:thread", root.pub)] do
      {delegation, genesis, log} = root_marker_log(replica, root)
      assert :ok = Authority.verify_chain([delegation], replica)
      assert Authority.root(log) == root.pub
      assert Authority.holder(Thread, log, :moderator) == root.pub
      refute Map.has_key?(Authority.analyze(Thread, log).reasons, genesis.id)
      assert Authority.delegation_active?(log, delegation.id)
    end
  end

  test "a malformed-marker log cannot select a root or assign a role during analysis" do
    root = Lattice.Identity.from_seed("root", "root-marker-analysis")
    {_delegation, genesis, log} = root_marker_log("town#root:attacker", root)
    analysis = Authority.analyze(Thread, log)

    assert {Authority.root(log), analysis.holders.moderator, analysis.reasons[genesis.id]} ==
             {nil, nil, :impostor_genesis}
  end

  defp root_marker_log(replica, root) do
    delegation = Delegation.genesis(root, replica, ops: [:post], roles: [:moderator])
    genesis = Lattice.Op.new(root, replica, [], :authority, {:genesis, delegation, %{}})
    {delegation, genesis, Log.append!(Log.new(replica), genesis)}
  end

  test "a forged self-issued genesis is quarantined and confers no role on any realm" do
    sim = founded()
    {sim, genesis_op, _deleg} = forge_genesis(sim, "evil", [:moderator], [:post, :lock, :unlock])

    assert {true, :impostor_genesis} = Sim.quarantined(sim, "server", genesis_op.id)
    assert {true, :impostor_genesis} = Sim.quarantined(sim, "tab", genesis_op.id)

    # The attacker did not seize :moderator; the real root still holds it identically
    # on every realm.
    assert Sim.holder(sim, "server", :moderator) == Sim.identity(sim, "server").pub
    assert Sim.holder(sim, "tab", :moderator) == Sim.identity(sim, "server").pub
    refute Sim.holder(sim, "evil", :moderator) == Sim.identity(sim, "evil").pub
  end

  test "an attacker cannot self-grant a plain capability via a forged genesis" do
    sim = founded()
    {sim, _g, deleg} = forge_genesis(sim, "evil", [], [:post])

    # evil posts citing its own forged genesis as the capability.
    {sim, post} = Sim.command(sim, "evil", :post, ["propaganda"], cap: deleg.id)

    assert {true, :invalid_capability} = Sim.quarantined(sim, "evil", post.id)
    refute "propaganda" in Sim.state(sim, "evil").messages
  end

  test "an attacker cannot run an authority command via a forged genesis role" do
    sim = founded()
    {sim, _g, deleg} = forge_genesis(sim, "evil", [:moderator], [:lock, :unlock])

    {sim, lock} = Sim.command(sim, "evil", :lock, [], cap: deleg.id)
    assert {true, reason} = Sim.quarantined(sim, "evil", lock.id)
    assert reason in [:invalid_capability, :not_holder, :role_not_granted]
    refute Sim.state(sim, "evil").locked?
  end

  test "an attacker cannot inject a succession policy via a forged genesis" do
    sim = founded()
    evil = Sim.identity(sim, "evil")
    # Forge a genesis carrying a policy that names evil as the immediate successor.
    {sim, g, _deleg} =
      forge_genesis(sim, "evil", [:moderator], [:lock], %{
        moderator: %{successor: evil.pub, dormant_ticks: 0}
      })

    assert {true, :impostor_genesis} = Sim.quarantined(sim, "server", g.id)

    # The injected policy is not honored, so evil's succession attempt is unauthorized.
    {sim, succ} = Sim.succeed(sim, "evil", :moderator, at_tick: 100)
    assert {true, reason} = Sim.quarantined(sim, "evil", succ.id)
    assert reason in [:unauthorized_succession, :invalid_succession]
    refute Sim.holder(sim, "evil", :moderator) == evil.pub
  end

  test "a parented genesis cannot inject a succession policy" do
    sim = founded()
    evil = Sim.identity(sim, "evil")
    {sim, rooted} = Sim.grant(sim, "server", "evil", ops: [:lock], roles: [:moderator])
    sim = Sim.sync_all(sim)

    injected_policy = %{moderator: %{successor: evil.pub, dormant_ticks: 0}}

    {sim, forged_genesis} =
      Sim.append(sim, "evil", :authority, {:genesis, rooted, injected_policy})

    {sim, succession} = Sim.succeed(sim, "evil", :moderator, at_tick: 0)
    sim = Sim.sync_all(sim)

    assert {true, :invalid_genesis} = Sim.quarantined(sim, "server", forged_genesis.id)
    assert {true, :unauthorized_succession} = Sim.quarantined(sim, "server", succession.id)
    assert Sim.holder(sim, "server", :moderator) == Sim.identity(sim, "server").pub
  end

  test "an unrooted grant confers no capability" do
    sim = founded()
    evil = Sim.identity(sim, "evil")

    unrooted =
      Delegation.genesis(evil, Sim.replica(sim),
        ops: [:post],
        roles: [],
        live: true
      )

    {sim, introduction} = Sim.append(sim, "evil", :authority, {:grant, unrooted})
    {sim, post} = Sim.command(sim, "evil", :post, ["unrooted propaganda"], cap: unrooted.id)
    sim = Sim.sync_all(sim)

    assert {true, :unrooted_delegation} = Sim.quarantined(sim, "server", introduction.id)
    assert {true, :invalid_capability} = Sim.quarantined(sim, "server", post.id)
    refute "unrooted propaganda" in Sim.state(sim, "server").messages
  end

  test "an unauthorized succession op cannot launder an unrooted capability" do
    sim = founded()
    evil = Sim.identity(sim, "evil")

    unrooted =
      Delegation.genesis(evil, Sim.replica(sim),
        ops: [:post],
        roles: [:moderator],
        live: true
      )

    {sim, succession} =
      Sim.append(sim, "evil", :authority, {:succeed, :moderator, unrooted, 0})

    {sim, post} =
      Sim.command(sim, "evil", :post, ["succession-laundered propaganda"], cap: unrooted.id)

    tab = Sim.identity(sim, "tab")

    child =
      Delegation.new(evil, Sim.replica(sim), tab.pub,
        ops: [:post],
        parent_id: unrooted.id
      )

    {sim, child_grant} = Sim.append(sim, "evil", :authority, {:grant, child})

    {sim, child_post} =
      Sim.command(sim, "tab", :post, ["child-laundered propaganda"], cap: child.id)

    sim = Sim.sync_all(sim)

    assert {true, :unauthorized_succession} = Sim.quarantined(sim, "server", succession.id)
    assert {true, :invalid_capability} = Sim.quarantined(sim, "server", post.id)
    assert false == Sim.quarantined(sim, "server", child_grant.id)
    assert {true, :invalid_capability} = Sim.quarantined(sim, "server", child_post.id)
    refute "succession-laundered propaganda" in Sim.state(sim, "server").messages
    refute "child-laundered propaganda" in Sim.state(sim, "server").messages
  end

  test "a non-authority body cannot promote an unrooted delegation" do
    sim = founded()
    evil = Sim.identity(sim, "evil")

    unrooted =
      Delegation.genesis(evil, Sim.replica(sim),
        ops: [:post],
        roles: [:moderator]
      )

    {sim, disguised} =
      Sim.append(sim, "evil", :command, {:succeed, :moderator, unrooted, 0})

    {sim, grant} = Sim.append(sim, "evil", :authority, {:grant, unrooted})
    sim = Sim.sync_all(sim)

    assert {true, :malformed_command} = Sim.quarantined(sim, "server", disguised.id)
    assert {true, :unrooted_delegation} = Sim.quarantined(sim, "server", grant.id)
  end

  test "a malformed self-issue keeps its structural reason when offered as genesis" do
    sim = founded()
    evil = Sim.identity(sim, "evil")
    tab = Sim.identity(sim, "tab")

    malformed =
      Delegation.new(evil, Sim.replica(sim), tab.pub,
        ops: [:post],
        parent_id: nil
      )

    {sim, forged_genesis} =
      Sim.append(sim, "evil", :authority, {:genesis, malformed, %{}})

    sim = Sim.sync_all(sim)

    assert {true, :nongenesis_root} = Sim.quarantined(sim, "server", forged_genesis.id)
  end

  test "a rooted grant reintroduced as genesis cannot seize its role" do
    sim = founded()
    {sim, rooted} = Sim.grant(sim, "server", "evil", ops: [:lock], roles: [:moderator])
    sim = Sim.sync_all(sim)

    {sim, forged_genesis} =
      Sim.append(sim, "evil", :authority, {:genesis, rooted, %{}})

    sim = Sim.sync_all(sim)

    assert {true, :invalid_genesis} = Sim.quarantined(sim, "server", forged_genesis.id)
    assert Sim.holder(sim, "server", :moderator) == Sim.identity(sim, "server").pub
  end

  test "replaying the genuine genesis from another author does not move the holder" do
    sim = founded()
    genesis_delegation = root_genesis_delegation(sim)

    {sim, replay} =
      Sim.append(
        sim,
        "evil",
        :authority,
        {:genesis, genesis_delegation, %{}}
      )

    sim = Sim.sync_all(sim)

    assert {true, :unauthorized_genesis} = Sim.quarantined(sim, "server", replay.id)
    assert Sim.holder(sim, "server", :moderator) == Sim.identity(sim, "server").pub
  end

  test "replaying the genuine genesis cannot replace its succession policy" do
    sim = founded()
    genesis_delegation = root_genesis_delegation(sim)
    evil = Sim.identity(sim, "evil")
    tab = Sim.identity(sim, "tab")

    {sim, replay} =
      Sim.append(
        sim,
        "evil",
        :authority,
        {:genesis, genesis_delegation, %{moderator: %{successor: evil.pub, dormant_ticks: 0}}}
      )

    sim = Sim.sync_all(sim)
    analysis = Sim.authority(sim, "server")

    assert {true, :unauthorized_genesis} = Sim.quarantined(sim, "server", replay.id)
    assert analysis.policies.moderator.successor == tab.pub
    assert analysis.policies.moderator.dormant_ticks == 3
  end

  test "a legitimate succession self-issue remains valid" do
    sim = founded()
    {sim, succession} = Sim.succeed(sim, "tab", :moderator, at_tick: 3)
    sim = Sim.sync_all(sim)

    assert false == Sim.quarantined(sim, "server", succession.id)
    assert Sim.holder(sim, "server", :moderator) == Sim.identity(sim, "tab").pub
  end

  test "an honored successor can attenuate its capability and transfer the role" do
    sim = founded()
    {sim, succession} = Sim.succeed(sim, "tab", :moderator, at_tick: 3)
    sim = Sim.sync_all(sim)

    {sim, transfer_delegation} = Sim.transfer(sim, "tab", "evil", :moderator, at_tick: 4)
    sim = Sim.sync_all(sim)
    {sim, lock} = Sim.command(sim, "evil", :lock, [], cap: transfer_delegation.id)
    sim = Sim.sync_all(sim)

    assert false == Sim.quarantined(sim, "server", succession.id)
    assert Sim.holder(sim, "server", :moderator) == Sim.identity(sim, "evil").pub
    assert false == Sim.quarantined(sim, "server", lock.id)
    assert Sim.state(sim, "server").locked?
  end

  test "a capability signed for another replica cannot authorize this replica" do
    sim = founded()
    server = Sim.identity(sim, "server")
    evil = Sim.identity(sim, "evil")
    foreign_replica = Authority.bind_replica("replica:thread:foreign", server.pub)

    foreign_genesis =
      Delegation.genesis(server, foreign_replica,
        ops: [:post],
        roles: [:moderator],
        live: true
      )

    foreign_grant =
      Delegation.new(server, foreign_replica, evil.pub,
        ops: [:post],
        roles: [],
        parent_id: foreign_genesis.id
      )

    {sim, foreign_genesis_op} =
      Sim.append(sim, "server", :authority, {:genesis, foreign_genesis, %{}})

    {sim, foreign_grant_op} = Sim.append(sim, "server", :authority, {:grant, foreign_grant})
    sim = Sim.sync_all(sim)

    {sim, forged_post} =
      Sim.command(sim, "evil", :post, ["foreign capability"], cap: foreign_grant.id)

    sim = Sim.sync_all(sim)

    assert {true, :wrong_replica} = Sim.quarantined(sim, "server", foreign_genesis_op.id)
    assert {true, :wrong_replica} = Sim.quarantined(sim, "server", foreign_grant_op.id)
    assert {true, :wrong_replica} = Sim.quarantined(sim, "server", forged_post.id)
    refute "foreign capability" in Sim.state(sim, "server").messages
  end

  test "a malformed heartbeat tick is quarantined and cannot crash later succession" do
    sim = founded()
    {sim, heartbeat} = Sim.append(sim, "server", :authority, {:heartbeat, :moderator, "9"})
    sim = Sim.sync_all(sim)
    {sim, succession} = Sim.succeed(sim, "tab", :moderator, at_tick: 3)
    sim = Sim.sync_all(sim)

    assert {true, :malformed_term} = Sim.quarantined(sim, "server", heartbeat.id)
    assert false == Sim.quarantined(sim, "server", succession.id)
    assert Sim.holder(sim, "server", :moderator) == Sim.identity(sim, "tab").pub
  end

  test "malformed transfer and succession ticks do not mutate the role timeline" do
    sim = founded()

    {sim, transfer_delegation} =
      Sim.transfer(sim, "server", "evil", :moderator, at_tick: "9", ops: [:post])

    sim = Sim.sync_all(sim)

    {sim, forged_post} =
      Sim.command(sim, "evil", :post, ["malformed transfer capability"],
        cap: transfer_delegation.id
      )

    {sim, malformed_succession} = Sim.succeed(sim, "tab", :moderator, at_tick: "9")
    sim = Sim.sync_all(sim)

    transfer =
      sim
      |> Sim.log("server")
      |> Log.topo_ops()
      |> Enum.find(fn
        %{body: {:transfer, :moderator, %Delegation{id: id}, "9"}} ->
          id == transfer_delegation.id

        _other ->
          false
      end)

    assert %Lattice.Op{} = transfer
    assert {true, :malformed_term} = Sim.quarantined(sim, "server", transfer.id)

    assert {true, :invalid_succession} =
             Sim.quarantined(sim, "server", malformed_succession.id)

    assert {true, :no_capability} = Sim.quarantined(sim, "server", forged_post.id)
    assert Sim.holder(sim, "server", :moderator) == Sim.identity(sim, "server").pub
    refute "malformed transfer capability" in Sim.state(sim, "server").messages
  end

  test "canonical signing rejects negative and over-range authority ticks" do
    sim = founded()

    for tick <- [-1, Canonical.max_integer() + 1] do
      assert_raise ArgumentError, fn ->
        Sim.append(sim, "server", :authority, {:heartbeat, :moderator, tick})
      end
    end
  end

  test "out-of-range integer succession proofs in a reconstructed log are quarantined" do
    sim = founded()
    {sim, succession} = Sim.succeed(sim, "tab", :moderator, at_tick: 3)
    {:succeed, :moderator, delegation, 3} = succession.body
    log = Sim.log(sim, "server")

    for proof <- [-1, Canonical.max_integer() + 1] do
      malformed = %{succession | body: {:succeed, :moderator, delegation, proof}}
      malformed_log = Log.from_ops(log.replica, Map.put(log.ops, succession.id, malformed))
      analysis = Authority.analyze(Thread, malformed_log)

      assert analysis.reasons[succession.id] == :malformed_term
      assert analysis.holders.moderator == Sim.identity(sim, "server").pub
    end
  end

  test "replaying a legitimate successor delegation as genesis cannot poison it" do
    sim = founded()
    {sim, succession} = Sim.succeed(sim, "tab", :moderator, at_tick: 3)
    {:succeed, :moderator, successor_delegation, 3} = succession.body
    sim = Sim.sync_all(sim)

    {sim, poisoned_genesis} =
      Sim.append(sim, "evil", :authority, {:genesis, successor_delegation, %{}})

    sim = Sim.sync_all(sim)
    {sim, lock} = Sim.command(sim, "tab", :lock, [], cap: successor_delegation.id)
    sim = Sim.sync_all(sim)

    assert false == Sim.quarantined(sim, "server", succession.id)
    assert {true, :impostor_genesis} = Sim.quarantined(sim, "server", poisoned_genesis.id)
    assert false == Sim.quarantined(sim, "server", lock.id)
    assert Sim.state(sim, "server").locked?
  end

  # --- Same-root sibling replay (plan 162 step 2b(d)) ----------------------

  test "a transfer replayed from a same-root sibling replica cannot move the holder" do
    sim = founded()
    server = Sim.identity(sim, "server")
    evil = Sim.identity(sim, "evil")
    sibling_replica = Authority.bind_replica("replica:thread:sibling", server.pub)

    sibling_genesis =
      Delegation.genesis(server, sibling_replica,
        ops: [:post],
        roles: [:moderator],
        live: true
      )

    sibling_transfer =
      Delegation.new(server, sibling_replica, evil.pub,
        ops: [:post],
        roles: [:moderator],
        parent_id: sibling_genesis.id
      )

    # The delegation validator rejects the sibling chain before it can become
    # valid timeline evidence.
    {sim, replayed_genesis} =
      Sim.append(sim, "server", :authority, {:genesis, sibling_genesis, %{}})

    {sim, replayed_transfer} =
      Sim.append(sim, "server", :authority, {:transfer, :moderator, sibling_transfer, 1})

    sim = Sim.sync_all(sim)

    assert {true, :wrong_replica} = Sim.quarantined(sim, "server", replayed_genesis.id)
    assert {true, :invalid_transfer} = Sim.quarantined(sim, "server", replayed_transfer.id)
    assert Sim.holder(sim, "server", :moderator) == server.pub
  end

  test "a root-less delegation minted for another replica is refused as wrong_replica" do
    sim = founded()
    evil = Sim.identity(sim, "evil")
    foreign_replica = Authority.bind_replica("replica:thread:foreign", evil.pub)

    foreign =
      Delegation.genesis(evil, foreign_replica,
        ops: [:post],
        roles: [],
        live: true
      )

    {sim, introduction} = Sim.append(sim, "evil", :authority, {:grant, foreign})
    {sim, post} = Sim.command(sim, "evil", :post, ["foreign propaganda"], cap: foreign.id)
    sim = Sim.sync_all(sim)

    assert {true, :wrong_replica} = Sim.quarantined(sim, "server", introduction.id)
    assert {true, :wrong_replica} = Sim.quarantined(sim, "server", post.id)
    refute "foreign propaganda" in Sim.state(sim, "server").messages
  end

  # --- Tombstone gate ------------------------------------------------------

  defp hosted_registry do
    sim = founded()
    base = Sim.log(sim, "server")
    :ok = Registry.host(Sim.identity(sim, "server"), Thread, @replica, base)
    :ok = Registry.host(Sim.identity(sim, "tab"), Thread, @replica, base)
    sim
  end

  test "only the bound root may tombstone; a non-root request is refused" do
    _sim = hosted_registry()

    # tab is not the root: refused, and the replica stays alive.
    assert {:error, :unauthorized} = Registry.tombstone("tab", @replica)
    assert {:ok, _} = Registry.materialize("tab", @replica)
    :ok = Registry.go_dormant("tab", @replica)

    # server is the root: tombstone succeeds and is permanent, on every realm.
    assert :ok = Registry.tombstone("server", @replica)
    assert {:error, :tombstoned} = Registry.materialize("server", @replica)
    :ok = Registry.sync("server", "tab", @replica)
    assert {:error, :tombstoned} = Registry.materialize("tab", @replica)
  end

  test "a tombstone op forged by a non-root realm is ignored, not obeyed" do
    sim = founded()
    key = {"evil", Sim.replica(sim)}
    {sim, ts} = Sim.append(sim, "evil", :tombstone, {:tombstone, key})
    sim = Sim.sync_all(sim)

    assert {true, :unauthorized_tombstone} = Sim.quarantined(sim, "server", ts.id)
    refute Authority.tombstoned?(Sim.log(sim, "server"))

    # A root-authored tombstone IS honored.
    {sim, _ts2} =
      Sim.append(sim, "server", :tombstone, {:tombstone, {"server", Sim.replica(sim)}})

    sim = Sim.sync_all(sim)
    assert Authority.tombstoned?(Sim.log(sim, "server"))
  end
end
