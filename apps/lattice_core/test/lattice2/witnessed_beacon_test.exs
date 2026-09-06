defmodule Lattice2.WitnessedBeaconTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Canonical, Identity, Log, Op, Sim, Sync}
  alias Lattice.Authority.{BeaconCertificate, Delegation}
  alias Township.Matter

  @realms ["clerk", "resident", "w0", "w1", "w2", "w3", "outsider"]

  defp town do
    sim = Sim.new(Matter, "replica:matter:witnessed-beacons", @realms, seed: "beacon")

    {sim, _} =
      Sim.create_replica(sim, "clerk",
        policies: %{
          __beacon__: %{
            mode: :witnessed,
            version: 1,
            witnesses: ["w0", "w1", "w2", "w3"],
            threshold: 2,
            max_epoch_step: 10
          }
        }
      )

    sim
  end

  test "a witnessed epoch lapses a lease in both command analysis and the public live check" do
    sim = town()
    {sim, lease} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 3)
    sim = Sim.sync_all(sim)
    {sim, early} = Sim.command(sim, "resident", :post, ["early"], cap: lease.id)
    sim = Sim.sync_all(sim)
    {sim, beacon} = Sim.beacon(sim, "w0", 4, witnesses: ["w0", "w1"])
    sim = Sim.sync_all(sim)
    {sim, late} = Sim.command(sim, "resident", :post, ["late"], cap: lease.id)
    sim = Sim.sync_all(sim)

    assert Sim.quarantined(sim, "resident", beacon.id) == false
    assert Sim.quarantined(sim, "resident", early.id) == false
    assert {true, :lease_expired} = Sim.quarantined(sim, "resident", late.id)
    assert Authority.expired?(Sim.log(sim, "resident"), lease.id)
    assert "early" in Sim.state(sim, "resident").posts
    refute "late" in Sim.state(sim, "resident").posts
  end

  defp merge(left, right), do: elem(Sync.reconcile(left, right), 0)

  test "only the resolved legacy root can introduce a beacon policy" do
    sim = Sim.new(Matter, "replica:matter:unbound-beacon", @realms, seed: "beacon:unbound")
    root = Sim.identity(sim, "clerk")
    root_delegation = Delegation.genesis(root, sim.replica, ops: [:post], roles: [:clerk])
    {sim, _} = Sim.append(sim, "clerk", :authority, {:genesis, root_delegation, %{}})
    sim = %{sim | caps: Map.put(sim.caps, "clerk", [root_delegation])} |> Sim.sync_all()
    {sim, lease} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 3)
    sim = Sim.sync_all(sim)
    outsider = Sim.identity(sim, "outsider")
    outsider_delegation = Delegation.genesis(outsider, sim.replica, ops: [:post])

    value = %{
      mode: :witnessed,
      version: 1,
      witnesses: [outsider.pub],
      threshold: 1,
      max_epoch_step: 10
    }

    {sim, _} =
      Sim.append(sim, "outsider", :authority, {:genesis, outsider_delegation, %{__beacon__: value}})

    sim = Sim.sync_all(sim)
    {sim, bad} = Sim.beacon(sim, "outsider", 4, witnesses: ["outsider"])
    sim = Sim.sync_all(sim)
    {sim, post} = Sim.command(sim, "resident", :post, ["lease remains live"], cap: lease.id)
    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "resident")
    assert Authority.root(log) == root.pub
    assert {true, :unauthorized_beacon} = Sim.quarantined(sim, "resident", bad.id)
    refute Authority.expired?(log, lease.id)
    assert Sim.quarantined(sim, "resident", post.id) == false

    {sim, _} = Sim.append(sim, "clerk", :authority, {:genesis, root_delegation, %{__beacon__: value}})
    sim = Sim.sync_all(sim)
    {sim, good} = Sim.beacon(sim, "outsider", 4, witnesses: ["outsider"])
    sim = Sim.sync_all(sim)
    assert Sim.quarantined(sim, "resident", good.id) == false
    assert Authority.expired?(Sim.log(sim, "resident"), lease.id)
  end

  defp certificate(sim, realm, epoch, signers \\ ["w0", "w1"]) do
    sim.replica
    |> BeaconCertificate.claim(
      epoch,
      Sim.identity(sim, realm).pub,
      Log.frontier(Sim.log(sim, realm))
    )
    |> BeaconCertificate.new(Enum.map(signers, &Sim.identity(sim, &1)))
  end

  defp policy(sim) do
    %{
      mode: :witnessed,
      version: 1,
      witnesses: Enum.map(["w0", "w1", "w2", "w3"], &Sim.identity(sim, &1).pub),
      threshold: 2,
      max_epoch_step: 10
    }
  end

  defp replace_policy(sim, value, realm \\ "clerk") do
    root = Sim.identity(sim, realm)
    d = Delegation.genesis(root, sim.replica, ops: [:post], live: true)
    Sim.append(sim, realm, :authority, {:genesis, d, %{__beacon__: value}})
  end

  test "certificate failures confer no lapse and have a single authorization refusal" do
    sim = town()
    {sim, lease} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 3)
    sim = Sim.sync_all(sim)
    good = certificate(sim, "w0", 4)
    [first, second] = good.signatures
    foreign = certificate(sim, "w0", 4, ["w0", "outsider"])
    swapped = %{good | signatures: [second, first]}

    changed_claims = [
      %{good.claim | replica: "replica:foreign"},
      %{good.claim | author: Sim.identity(sim, "w1").pub},
      %{good.claim | deps: []},
      %{good.claim | epoch: 5},
      %{good.claim | version: 2},
      Map.put(good.claim, :extra, 1)
    ]

    bound_negatives =
      Enum.map(
        changed_claims,
        &BeaconCertificate.new(&1, Enum.map(["w0", "w1"], fn r -> Sim.identity(sim, r) end))
      )

    wrong_domain = %{
      good
      | signatures:
          Enum.map(good.signatures, fn entry ->
            witness = Enum.find(Map.values(sim.realms), &(&1.pub == entry.witness))

            %{
              entry
              | signature:
                  Identity.sign(
                    witness,
                    Canonical.term(["lattice-succession-witness-v1", good.claim])
                  )
            }
          end)
    }

    negatives =
      bound_negatives ++
        [
          %{good | signatures: [first]},
          %{good | signatures: [first, first]},
          foreign,
          swapped,
          %{good | signatures: [%{first | signature: <<0::512>>}, second]},
          %{good | signatures: [Map.put(first, :extra, 0), second]},
          %{good | signatures: [%{first | signature: <<1>>}, second]},
          Map.put(good, :extra, 0),
          %{good | claim: Map.delete(good.claim, :author)},
          wrong_domain,
          nil
        ]

    for bad <- negatives do
      {branch, beacon} = Sim.beacon(sim, "w0", 4, certificate: bad)
      branch = Sim.sync_all(branch)
      {branch, post} = Sim.command(branch, "resident", :post, ["authorized"], cap: lease.id)
      branch = Sim.sync_all(branch)
      assert {true, :unauthorized_beacon} = Sim.quarantined(branch, "resident", beacon.id)
      assert Sim.quarantined(branch, "resident", post.id) == false
      refute Authority.expired?(Sim.log(branch, "resident"), lease.id)
    end

    {outsider, op} = Sim.beacon(sim, "outsider", 4, witnesses: ["w0", "w1"])
    assert {true, :unauthorized_beacon} = Sim.quarantined(outsider, "outsider", op.id)
    {root, op} = Sim.beacon(sim, "clerk", 4, witnesses: ["w0", "w1"])
    assert Sim.quarantined(root, "clerk", op.id) == false
  end

  test "policy normalization requires exactly five bounded fields and canonical witness identities" do
    sim = town()
    valid = policy(sim)
    assert {:ok, normalized} = BeaconCertificate.normalize_policy(valid)
    assert normalized.witnesses == Enum.sort(valid.witnesses)

    assert BeaconCertificate.policy_id(valid) ==
             BeaconCertificate.policy_id(%{valid | witnesses: Enum.reverse(valid.witnesses)})

    invalid = [
      %{valid | threshold: 0},
      %{valid | threshold: 5},
      %{valid | witnesses: []},
      %{valid | witnesses: [hd(valid.witnesses), hd(valid.witnesses)]},
      %{valid | witnesses: [<<1>>]},
      %{valid | mode: :unknown},
      %{valid | version: 2},
      %{valid | max_epoch_step: 0},
      %{valid | max_epoch_step: -1},
      %{valid | max_epoch_step: 65_536},
      %{valid | max_epoch_step: 1.5},
      %{valid | max_epoch_step: 9_007_199_254_740_992},
      %{valid | max_epoch_step: Canonical.max_integer()},
      Map.delete(valid, :max_epoch_step),
      Map.put(valid, :horizon, 9_007_199_254_740_991)
    ]

    for value <- invalid do
      assert {:error, :invalid_beacon_policy} = BeaconCertificate.normalize_policy(value)
    end

    for step <- [1, 65_535],
        do: assert({:ok, _} = BeaconCertificate.normalize_policy(%{valid | max_epoch_step: step}))
  end

  test "policy selection is causal and invalid later values do not erase a valid policy" do
    sim = town()
    {before, first} = Sim.beacon(sim, "w0", 4, witnesses: ["w0", "w1"])
    replacement = %{policy(sim) | witnesses: Enum.map(["w2", "w3"], &Sim.identity(sim, &1).pub)}
    {updated, _} = replace_policy(sim, replacement)
    {fork, fork_beacon} = Sim.beacon(updated, "w0", 5, witnesses: ["w0", "w1"])

    merged =
      %{fork | logs: Map.update!(fork.logs, "w0", &merge(&1, Sim.log(before, "w0")))}
      |> Sim.sync_all()

    assert Sim.quarantined(merged, "resident", first.id) == false
    assert Sim.quarantined(merged, "resident", fork_beacon.id) == false
    {merged, old} = Sim.beacon(merged, "w0", 6, witnesses: ["w0", "w1"])
    assert {true, :unauthorized_beacon} = Sim.quarantined(merged, "w0", old.id)
    {merged, new} = Sim.beacon(merged, "w2", 6, witnesses: ["w2", "w3"])
    assert Sim.quarantined(merged, "w2", new.id) == false
    {invalid, genesis} = replace_policy(sim, %{policy(sim) | threshold: 0})
    invalid = Sim.sync_all(invalid)
    {invalid, beacon} = Sim.beacon(invalid, "w0", 4, witnesses: ["w0", "w1"])
    assert Sim.quarantined(invalid, "w0", genesis.id) == false
    assert Sim.quarantined(invalid, "w0", beacon.id) == false
    {forged, _} = replace_policy(sim, replacement, "outsider")
    forged = Sim.sync_all(forged)
    {forged, beacon} = Sim.beacon(forged, "w0", 4, witnesses: ["w0", "w1"])
    assert Sim.quarantined(forged, "w0", beacon.id) == false
  end

  test "initial and descendant step bounds, monotonicity, and the fixed safe horizon" do
    sim = town()
    {sim, lease} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 9)
    sim = Sim.sync_all(sim)
    {bad, too_far} = Sim.beacon(sim, "w0", 10, witnesses: ["w0", "w1"])
    assert {true, :unauthorized_beacon} = Sim.quarantined(bad, "w0", too_far.id)
    refute Authority.expired?(Sim.log(bad, "w0"), lease.id)
    {sim, first} = Sim.beacon(sim, "w0", 9, witnesses: ["w0", "w1"])
    assert Sim.quarantined(sim, "w0", first.id) == false
    {bad, jump} = Sim.beacon(sim, "w0", 20, witnesses: ["w0", "w1"])
    assert {true, :unauthorized_beacon} = Sim.quarantined(bad, "w0", jump.id)
    {bad, stale} = Sim.beacon(sim, "w0", 9, witnesses: ["w0", "w1"])
    assert {true, :stale_beacon} = Sim.quarantined(bad, "w0", stale.id)
    horizon = 9_007_199_254_740_991
    {high, _} = Sim.beacon(town(), "clerk", horizon - 1)
    high = Sim.sync_all(high)
    {valid, at} = Sim.beacon(high, "w0", horizon, witnesses: ["w0", "w1"])
    assert Sim.quarantined(valid, "w0", at.id) == false
    {bad, above} = Sim.beacon(high, "w0", horizon + 1, witnesses: ["w0", "w1"])
    assert {true, :malformed_term} = Sim.quarantined(bad, "w0", above.id)
    claim_above = certificate(high, "w0", horizon + 1)
    {bad, claim_bad} = Sim.beacon(high, "w0", horizon, certificate: claim_above)
    assert {true, :malformed_term} = Sim.quarantined(bad, "w0", claim_bad.id)
    {fork, lower} = Sim.beacon(town(), "w0", 4, witnesses: ["w0", "w1"])
    combined = merge(Sim.log(valid, "w0"), Sim.log(fork, "w0"))
    refute Map.has_key?(Authority.analyze(Matter, combined).reasons, lower.id)
  end

  test "a copied certificate binds author and deps while same-author same-frontier duplicate is inert" do
    sim = town()
    {sim, lease} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 3)
    sim = Sim.sync_all(sim)
    old_frontier = Log.frontier(Sim.log(sim, "w0"))
    {sim, early} = Sim.command(sim, "resident", :post, ["early"], cap: lease.id)
    sim = Sim.sync_all(sim)
    cert = certificate(sim, "w0", 4)
    {sim, beacon} = Sim.beacon(sim, "w0", 4, certificate: cert)

    stolen =
      Op.new(
        Sim.identity(sim, "w1"),
        sim.replica,
        cert.claim.deps,
        :authority,
        {:beacon, 4, cert}
      )

    lifted =
      Op.new(Sim.identity(sim, "w0"), sim.replica, old_frontier, :authority, {:beacon, 4, cert})

    duplicate =
      Op.new(
        Sim.identity(sim, "w0"),
        sim.replica,
        cert.claim.deps,
        :authority,
        {:beacon, 4, cert},
        cap: "different-cap"
      )

    log =
      Sim.log(sim, "w0") |> Log.append!(stolen) |> Log.append!(lifted) |> Log.append!(duplicate)

    analysis = Authority.analyze(Matter, log)
    assert analysis.reasons[stolen.id] == :unauthorized_beacon
    assert analysis.reasons[lifted.id] == :unauthorized_beacon
    refute Map.has_key?(analysis.reasons, early.id)
    refute Map.has_key?(analysis.reasons, beacon.id)
    refute Map.has_key?(analysis.reasons, duplicate.id)
    assert Lattice.state(Matter, log) == Sim.state(sim, "w0")
  end

  test "disjoint partition quorums authorize the same epoch then advance after heal" do
    sim = town()
    left = ["clerk", "resident", "w0", "w1"]
    right = ["w2", "w3", "outsider"]

    partitioned =
      Enum.reduce(for(a <- left, b <- right, do: {a, b}), sim, fn {a, b}, acc ->
        Sim.partition(acc, a, b)
      end)

    {partitioned, a} = Sim.beacon(partitioned, "w0", 4, witnesses: ["w0", "w1"])
    {partitioned, b} = Sim.beacon(partitioned, "w2", 4, witnesses: ["w2", "w3"])
    partitioned = Sim.sync_all(partitioned)
    refute Map.has_key?(Sim.log(partitioned, "w0").ops, b.id)

    healed =
      Enum.reduce(for(a <- left, b <- right, do: {a, b}), partitioned, fn {a, b}, acc ->
        Sim.heal(acc, a, b)
      end)
      |> Sim.sync_all()

    {healed, next} = Sim.beacon(healed, "w1", 5, witnesses: ["w1", "w3"])
    healed = Sim.sync_all(healed)

    for realm <- @realms do
      for id <- [a.id, b.id, next.id], do: assert(Sim.quarantined(healed, realm, id) == false)
      assert Sim.authority(healed, realm).reasons == Sim.authority(healed, "resident").reasons
    end
  end

  test "founder loss permits predelegated admission, surviving issuer revocation and witnessed lease lapse" do
    sim = town()

    recovery = %{
      successor: Sim.identity(sim, "resident").pub,
      recovery: Map.delete(policy(sim), :max_epoch_step)
    }

    root = Sim.identity(sim, "clerk")

    d =
      Delegation.genesis(root, sim.replica,
        ops: [:admit, :post, :close_matter, :reopen_matter],
        roles: [:clerk],
        live: true
      )

    {sim, _} = Sim.append(sim, "clerk", :authority, {:genesis, d, %{clerk: recovery}})
    {sim, admission} = Sim.grant(sim, "clerk", "resident", ops: [:admit, :post], live: true)
    {sim, lease} = Sim.grant(sim, "clerk", "w3", ops: [:post], expires_epoch: 3)
    sim = Sim.sync_all(sim)
    {sim, child} = Sim.grant(sim, "resident", "w2", ops: [:post])
    sim = Sim.sync_all(sim)

    lost = %{
      sim
      | realms: Map.delete(sim.realms, "clerk"),
        logs: Map.delete(sim.logs, "clerk"),
        caps: Map.delete(sim.caps, "clerk")
    }

    refute Map.has_key?(lost.realms, "clerk")

    {lost, succession} =
      Sim.succeed(lost, "resident", :clerk,
        witnesses: ["w0", "w1"],
        ops: [:close_matter, :reopen_matter]
      )

    {lost, admit} = Sim.command(lost, "resident", :admit, ["new participant"], cap: admission.id)
    {lost, revoke} = Sim.revoke(lost, "resident", child.id)
    {lost, forbidden_revoke} = Sim.revoke(lost, "resident", admission.id)
    lost = Sim.sync_all(lost)
    {lost, revoked} = Sim.command(lost, "w2", :post, ["revoked"], cap: child.id)
    {lost, subset} = Sim.beacon(lost, "w0", 4, witnesses: ["w0"])
    lost = Sim.sync_all(lost)
    refute Authority.expired?(Sim.log(lost, "resident"), lease.id)
    {lost, beacon} = Sim.beacon(lost, "w0", 4, witnesses: ["w0", "w1"])
    lost = Sim.sync_all(lost)
    {lost, expired} = Sim.command(lost, "w3", :post, ["expired"], cap: lease.id)
    lost = Sim.sync_all(lost)

    for realm <- Map.keys(lost.realms) do
      for id <- [succession.id, admit.id, revoke.id, beacon.id],
          do: assert(Sim.quarantined(lost, realm, id) == false)

      assert {true, :unauthorized_revoke} = Sim.quarantined(lost, realm, forbidden_revoke.id)
      assert {true, :revoked_capability} = Sim.quarantined(lost, realm, revoked.id)
      assert {true, :unauthorized_beacon} = Sim.quarantined(lost, realm, subset.id)
      assert {true, :lease_expired} = Sim.quarantined(lost, realm, expired.id)
      assert Authority.expired?(Sim.log(lost, realm), lease.id)
      assert Authority.delegation_active?(Sim.log(lost, realm), admission.id)
      assert Sim.state(lost, realm) == Sim.state(lost, "resident")
      assert Sim.authority(lost, realm).reasons == Sim.authority(lost, "resident").reasons
    end
  end

  test "absent policy refuses witness beacons until a valid root ancestor adds it" do
    sim = Sim.new(Matter, "replica:matter:beacon-policy-added", @realms, seed: "beacon")
    {sim, _} = Sim.create_replica(sim, "clerk")
    {sim, refused} = Sim.beacon(sim, "w0", 4, witnesses: ["w0", "w1"])
    assert {true, :unauthorized_beacon} = Sim.quarantined(sim, "w0", refused.id)
    {sim, _} = replace_policy(sim, policy(sim))
    sim = Sim.sync_all(sim)
    {sim, allowed} = Sim.beacon(sim, "w0", 4, witnesses: ["w0", "w1"])
    sim = Sim.sync_all(sim)
    assert {true, :unauthorized_beacon} = Sim.quarantined(sim, "resident", refused.id)
    assert Sim.quarantined(sim, "resident", allowed.id) == false
  end

  defmodule ReservedRoleFixture do
    use Lattice.Replica

    state do
      field(:closed?, authority: :__beacon__, default: false)
    end

    command(:close, [], do: [{:closed?, {:write, true}}])
  end

  test "a reserved-name role retains the existing genesis and transfer behavior" do
    sim = Sim.new(ReservedRoleFixture, "replica:reserved-role", @realms, seed: "beacon")

    {sim, genesis} =
      Sim.create_replica(sim, "clerk",
        policies: %{
          __beacon__: %{
            mode: :witnessed,
            version: 1,
            witnesses: ["w0", "w1"],
            threshold: 2,
            max_epoch_step: 10
          }
        }
      )

    {sim, _transfer} =
      Sim.transfer(sim, "clerk", "resident", :__beacon__, at_tick: 1, ops: [:close])

    sim = Sim.sync_all(sim)
    assert Sim.quarantined(sim, "resident", genesis.id) == false
    assert Sim.holder(sim, "resident", :__beacon__) == Sim.identity(sim, "resident").pub
    assert Sim.authority(sim, "resident").reasons == %{}
  end

  test "canonical-ceiling root epochs and witnessed horizon epochs only constrain their descendants" do
    sim = town()
    {high, root} = Sim.beacon(sim, "clerk", Canonical.max_integer())
    high = Sim.sync_all(high)
    {high, stale} = Sim.beacon(high, "w0", 4, witnesses: ["w0", "w1"])
    assert {true, :stale_beacon} = Sim.quarantined(high, "w0", stale.id)
    {high, malformed} = Sim.beacon(high, "w0", Canonical.max_integer(), witnesses: ["w0", "w1"])
    assert {true, :malformed_term} = Sim.quarantined(high, "w0", malformed.id)
    {fork, low} = Sim.beacon(sim, "w0", 4, witnesses: ["w0", "w1"])
    log = merge(Sim.log(high, "w0"), Sim.log(fork, "w0"))
    refute Map.has_key?(Authority.analyze(Matter, log).reasons, low.id)
    refute Map.has_key?(Authority.analyze(Matter, log).reasons, root.id)
    {at, _} = Sim.beacon(sim, "clerk", 9_007_199_254_740_990)
    at = Sim.sync_all(at)
    {at, _} = Sim.beacon(at, "w0", 9_007_199_254_740_991, witnesses: ["w0", "w1"])
    {at, stale} = Sim.beacon(at, "w0", 4, witnesses: ["w0", "w1"])
    assert {true, :stale_beacon} = Sim.quarantined(at, "w0", stale.id)
  end

  test "legacy max-tick pin remains root-repairable by the existing zero-dormancy policy replacement" do
    sim = Sim.new(Matter, "replica:legacy-policy-repair", @realms, seed: "beacon")

    {sim, _} =
      Sim.create_replica(sim, "clerk",
        policies: %{clerk: %{successor: "resident", dormant_ticks: 3}}
      )

    {sim, _} = Sim.heartbeat(sim, "clerk", :clerk, Canonical.max_integer())
    sim = Sim.sync_all(sim)

    {sim, blocked} =
      Sim.succeed(sim, "resident", :clerk, at_tick: Canonical.max_integer(), ops: [:close_matter])

    assert {true, :premature_succession} = Sim.quarantined(sim, "resident", blocked.id)
    root = Sim.identity(sim, "clerk")
    d = Delegation.genesis(root, sim.replica, ops: [:close_matter], roles: [:clerk], live: true)

    {sim, _} =
      Sim.append(
        sim,
        "clerk",
        :authority,
        {:genesis, d, %{clerk: %{successor: Sim.identity(sim, "resident").pub, dormant_ticks: 0}}}
      )

    sim = Sim.sync_all(sim)

    {sim, repaired} =
      Sim.succeed(sim, "resident", :clerk, at_tick: Canonical.max_integer(), ops: [:close_matter])

    assert Sim.quarantined(sim, "resident", repaired.id) == false
    assert Sim.holder(sim, "resident", :clerk) == Sim.identity(sim, "resident").pub
  end

  test "policy ceiling and fixed horizon jointly refuse a canonical-ceiling certificate" do
    sim = town()
    {sim, _} = replace_policy(sim, %{policy(sim) | max_epoch_step: Canonical.max_integer()})
    {sim, _} = Sim.beacon(sim, "clerk", 0)
    sim = Sim.sync_all(sim)
    {sim, beacon} = Sim.beacon(sim, "w0", Canonical.max_integer(), witnesses: ["w0", "w1"])
    assert {true, :malformed_term} = Sim.quarantined(sim, "w0", beacon.id)
  end
end
