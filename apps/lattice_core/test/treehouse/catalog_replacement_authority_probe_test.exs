defmodule Treehouse.CatalogReplacementAuthorityProbeTest do
  @moduledoc """
  R11c PR 0 API-sufficiency spike (plan 316 §7, row 316).

  Asks whether the existing public Core judgment surface (`Lattice.Authority`
  `holder_epoch/3`, `acquisitions/3`, `analyze_with_beacon_evidence/2`,
  `analyze_with_records/2`, `analyze/2`, plus `Lattice.Log` and `Lattice.Dag`) is
  enough for a later catalog-replacement resolver to read, at an op's strict
  causal prefix, the authority facts plan 316 needs.

  Sim fixtures over the real `Treehouse.Space` schema, with disposable keys. There is
  no resolver, no `replace_catalog_v1` Space command, and no custody claim here.
  """
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Dag, Log, Op, Sim}
  alias Lattice.Authority.Delegation
  alias Treehouse.Space

  @realms ~w(root admin nominee w1 w2 w3 observer)
  @preview [
    :create_space,
    :create_thread,
    :issue_invitation,
    :revoke_invitation,
    :admit_member,
    :remove_member
  ]
  # Mirrors Space's private bounded genesis ceiling; a mismatch would surface as a
  # refused transfer or continuation, not a silent pass.
  @bounded_genesis_ops @preview ++
                         [:catalog_bootstrap_v1, :attest_member_key_v1, :replace_catalog_v1]
  @admin_ops @preview ++ [:replace_catalog_v1]
  # Placeholder only: PR 0 does not judge claim shape (PR 1 owns the codec).
  @claim_stub %{"probe" => "r11c-pr0"}

  # --- fixture --------------------------------------------------------------

  defp digest(bytes), do: :crypto.hash(:sha256, bytes) |> Base.url_encode64(padding: false)

  # Genesis (bounded ceiling incl. :replace_catalog_v1), create_space, and the root's
  # continuation + witnessed-beacon pin. No admin transfer yet.
  defp space do
    replica =
      "replica:treehouse:space:#{digest("r11c-pr0-nonce")}#authority:bounded-continuation-v1"

    sim = Sim.new(Space, replica, @realms, seed: "r11c-pr0")
    {sim, genesis} = Sim.create_replica(sim, "root", ops: @bounded_genesis_ops)
    {sim, _creation} = Sim.command(sim, "root", :create_space, ["Canopy"])
    sim = Sim.sync_all(sim)
    {sim, pin} = pin(sim)
    %{sim: sim, genesis: genesis, pin: pin}
  end

  defp profile(sim) do
    %{
      mode: :bounded_continuation,
      version: 1,
      product: :treehouse,
      kind: :space,
      role: :admin,
      nominee: Sim.identity(sim, "nominee").pub,
      witnesses: Enum.sort(Enum.map(~w(w1 w2 w3), &Sim.identity(sim, &1).pub)),
      threshold: 2,
      max_lease_epochs: 7
    }
  end

  # Same shape as Treehouse.ContinuationFixtures.pin/2, with role :admin and kind :space.
  defp pin(sim) do
    root = Sim.identity(sim, "root")
    empty = Delegation.genesis(root, sim.replica, ops: [], roles: [], live: false)
    policy = profile(sim)

    beacon = %{
      mode: :witnessed,
      version: 1,
      witnesses: policy.witnesses,
      threshold: 2,
      max_epoch_step: 1
    }

    {sim, op} =
      Sim.append(
        sim,
        "root",
        :authority,
        {:genesis, empty, %{__continuation__: policy, __beacon__: beacon}}
      )

    {Sim.sync_all(sim), op}
  end

  # Beacon 0, then a leased root → admin transfer whose ceiling includes
  # :replace_catalog_v1, synced to every realm.
  defp leased do
    fx = space()
    {sim, beacon0} = Sim.beacon(fx.sim, "root", 0)

    {sim, d} =
      Sim.transfer(sim, "root", "admin", :admin, ops: @admin_ops, expires_epoch: 6)

    sim = Sim.sync_all(sim)
    Map.merge(fx, %{sim: sim, beacon0: beacon0, delegation: d, transfer: transfer_op(sim, d)})
  end

  defp transfer_op(sim, %Delegation{id: id}) do
    sim
    |> Sim.log("root")
    |> Log.topo_ops()
    |> Enum.find(&match?(%Op{body: {:transfer, :admin, %Delegation{id: ^id}, _}}, &1))
  end

  defp replace_candidate(sim, realm, cap) do
    Sim.append(
      sim,
      realm,
      :command,
      {:replace_catalog_v1, [@claim_stub, <<0::512>>, <<0::512>>]},
      cap: cap
    )
  end

  # Strict causal prefix of `op`: its deps' reachable closure, excluding `op`. The
  # same construction as Lattice.state_at/3, from public Log/Dag APIs only.
  defp prefix(%Log{} = log, %Op{} = op) do
    ops = Log.ops(log)
    Log.from_ops(log.replica, Map.take(ops, MapSet.to_list(Dag.reachable(ops, op.deps))))
  end

  defp ops_list(%Log{} = log), do: log |> Log.ops() |> Map.values()

  # --- T1 -------------------------------------------------------------------

  test "leased admin acquisition with replace_catalog_v1 in ceiling is observable at strict prefix via holder_epoch/acquisitions" do
    fx = leased()
    {sim, _beacon1} = Sim.beacon(fx.sim, "root", 1)
    sim = Sim.sync_all(sim)
    d = fx.delegation
    {sim, candidate} = replace_candidate(sim, "admin", d.id)
    admin = Sim.identity(sim, "admin")

    p = prefix(Sim.log(sim, "admin"), candidate)
    refute Log.has?(p, candidate.id)

    assert Authority.holder_epoch(Space, p, :admin) == %{
             holder: admin.pub,
             op_id: fx.transfer.id
           }

    assert List.last(Authority.acquisitions(Space, p, :admin)) == %{
             op_id: fx.transfer.id,
             holder: admin.pub,
             delegation_id: d.id
           }

    assert d.id == candidate.cap

    # acquisition() carries only delegation_id; the struct is reachable from the prefix.
    id = candidate.cap

    assert [%Delegation{} = observed] =
             for(
               %Op{body: {:transfer, :admin, %Delegation{id: ^id} = x, _}} <- ops_list(p),
               do: x
             )

    assert observed == d
    assert :replace_catalog_v1 in observed.ops
    assert observed.expires_epoch == 6
    # Read, not assumed: Sim.transfer does not pass :live, so Delegation.new's default holds.
    assert observed.live == false
    assert observed.parent_id == fx.genesis.body |> elem(1) |> Map.fetch!(:id)
  end

  # --- T2 -------------------------------------------------------------------

  test "ancestor beacon basis derivable via analyze_with_beacon_evidence" do
    fx = leased()
    # Two concurrent epoch-1 beacons: one root tick, one witnessed tick by w1, each
    # authored before the other is synced.
    {sim, root1} = Sim.beacon(fx.sim, "root", 1)
    {sim, w1_1} = Sim.beacon(sim, "w1", 1, witnesses: ["w1", "w2"])
    sim = Sim.sync_all(sim)

    # Candidate and a root epoch-2 beacon, mutually concurrent.
    {sim, candidate} = replace_candidate(sim, "admin", fx.delegation.id)
    {sim, epoch2} = Sim.beacon(sim, "root", 2)
    sim = Sim.sync_all(sim)

    full = Sim.log(sim, "admin")
    assert Log.has?(full, candidate.id) and Log.has?(full, epoch2.id)
    p = prefix(full, candidate)
    refute Log.has?(p, epoch2.id)

    {_, beacons} = Authority.analyze_with_beacon_evidence(Space, p)
    {_, beacons2, _records} = Authority.analyze_with_records(Space, p)
    assert beacons == beacons2

    assert Enum.sort(Enum.map(beacons, & &1.op_id)) ==
             Enum.sort([fx.beacon0.id, root1.id, w1_1.id])

    {max, basis} = epoch_rule(beacons)
    assert max == 1
    assert basis == Enum.sort([root1.id, w1_1.id])
    # member_continuity.ex epoch/2's rule: 0 <= max <= 2^53-1, basis sorted.
    assert max >= 0 and max <= 9_007_199_254_740_991
    assert basis == Enum.sort(basis)

    # The evidence is global to the log it is given; only P removes the concurrent tick.
    {_, full_beacons} = Authority.analyze_with_beacon_evidence(Space, full)
    assert %{op_id: epoch2.id, epoch: 2} in full_beacons
    refute Enum.any?(beacons, &(&1.op_id == epoch2.id))
    assert {2, [epoch2.id]} == epoch_rule(full_beacons)
  end

  defp epoch_rule(beacons) do
    max = Enum.max(Enum.map(beacons, & &1.epoch), fn -> -1 end)
    {max, Enum.sort(for %{epoch: ^max, op_id: id} <- beacons, do: id)}
  end

  # --- T3 -------------------------------------------------------------------

  test "unleased root genesis cap yields no finite acquisition" do
    fx = space()
    %Delegation{} = genesis_d = elem(fx.genesis.body, 1)
    {sim, candidate} = replace_candidate(fx.sim, "root", genesis_d.id)
    root = Sim.identity(sim, "root")
    p = prefix(Sim.log(sim, "root"), candidate)

    assert candidate.cap == genesis_d.id
    assert genesis_d.expires_epoch == nil
    assert genesis_d.parent_id == nil

    acquisitions = Authority.acquisitions(Space, p, :admin)

    refute Enum.any?(acquisitions, fn %{delegation_id: id} ->
             id == candidate.cap and not is_nil(delegation(p, id).expires_epoch)
           end)

    refute Enum.any?(acquisitions, &(not is_nil(delegation(p, &1.delegation_id).expires_epoch)))

    # Recorded observation: Core names the root genesis as the :admin acquisition.
    assert Authority.holder_epoch(Space, p, :admin) == %{holder: root.pub, op_id: fx.genesis.id}

    assert acquisitions == [
             %{op_id: fx.genesis.id, holder: root.pub, delegation_id: genesis_d.id}
           ]
  end

  # Any delegation struct introduced by a genesis/grant/transfer/succeed op in `log`.
  defp delegation(%Log{} = log, id) do
    Enum.find_value(ops_list(log), fn
      %Op{kind: :authority, body: body} when is_tuple(body) ->
        body |> Tuple.to_list() |> Enum.find(&match?(%Delegation{id: ^id}, &1))

      _ ->
        nil
    end)
  end

  # --- T4 -------------------------------------------------------------------

  test "an R04 continuation acquisition (parent_id: nil) is observable via acquisitions/3 and its delegation ceiling is readable from the prefix log" do
    fx = leased()

    sim =
      Enum.reduce(1..2, fx.sim, fn epoch, s ->
        {s, _} = Sim.beacon(s, "w1", epoch, witnesses: ["w1", "w2"])
        Sim.sync_all(s)
      end)

    # Inherited-provenance check (step 4): a ceiling wider than the predecessor's
    # transfer ceiling is refused by Continuation.scope?/4's MapSet.subset?.
    assert {:error, :continuation_scope_exceeded} =
             Sim.continue_role(sim, "admin", :admin,
               ops: @admin_ops ++ [:catalog_bootstrap_v1],
               expires_epoch: 8,
               witnesses: ["w1", "w2"]
             )

    {sim, cont} =
      Sim.continue_role(sim, "admin", :admin,
        ops: @admin_ops,
        expires_epoch: 8,
        witnesses: ["w1", "w2"]
      )

    sim = Sim.sync_all(sim)
    {:succeed, :admin, %Delegation{id: cont_d_id}, {:continuation_v1, _}} = cont.body
    {sim, candidate} = replace_candidate(sim, "admin", cont_d_id)
    admin = Sim.identity(sim, "admin")
    p = prefix(Sim.log(sim, "admin"), candidate)

    last = List.last(Authority.acquisitions(Space, p, :admin))
    assert last.op_id == cont.id
    assert last.delegation_id == candidate.cap
    assert Authority.holder_epoch(Space, p, :admin) == %{holder: admin.pub, op_id: cont.id}

    id = candidate.cap

    assert [%Delegation{} = d] =
             for(
               %Op{body: {:succeed, :admin, %Delegation{id: ^id} = x, {:continuation_v1, _}}} <-
                 ops_list(p),
               do: x
             )

    assert d.parent_id == nil
    assert d.issuer == admin.pub and d.audience == admin.pub
    assert :replace_catalog_v1 in d.ops
    assert is_integer(d.expires_epoch) and d.expires_epoch == 8
    # Inherited ceiling: a subset of the leased transfer's ops, which the prefix also holds.
    assert MapSet.subset?(d.ops, fx.delegation.ops)
    assert delegation(p, fx.delegation.id) == fx.delegation

    # Residual (Sol review): per-hop subset is not monotone provenance. A later
    # continuation may drop :replace_catalog_v1, and a transfer may still attenuate an
    # older, broader rootless continuation cap, restoring it. Core honors every hop, so
    # the PR 4 resolver must validate the ceiling chain over the acquisition sequence.
    {sim, narrow} =
      Sim.continue_role(sim, "admin", :admin,
        ops: @admin_ops -- [:replace_catalog_v1],
        expires_epoch: 8,
        witnesses: ["w1", "w2"]
      )

    sim = Sim.sync_all(sim)
    nominee = Sim.identity(sim, "nominee")

    restored =
      Delegation.new(admin, sim.replica, nominee.pub,
        ops: @admin_ops,
        roles: [:admin],
        parent_id: d.id,
        expires_epoch: 8
      )

    {sim, restore_op} = Sim.append(sim, "admin", :authority, {:transfer, :admin, restored, 0})
    sim = Sim.sync_all(sim)
    {sim, late} = replace_candidate(sim, "nominee", restored.id)
    q = prefix(Sim.log(sim, "nominee"), late)

    # Genesis and the leased transfer precede these three hops.
    assert [_, _, %{op_id: cont_id}, %{op_id: narrow_id}, %{op_id: restore_id}] =
             Authority.acquisitions(Space, q, :admin)

    assert {cont_id, narrow_id, restore_id} == {cont.id, narrow.id, restore_op.id}
    {:succeed, :admin, narrow_d, _} = narrow.body
    refute :replace_catalog_v1 in narrow_d.ops
    assert :replace_catalog_v1 in restored.ops

    assert Authority.holder_epoch(Space, q, :admin) == %{
             holder: nominee.pub,
             op_id: restore_op.id
           }

    refute MapSet.member?(Authority.quarantine(Space, q), restore_op.id)
  end

  # --- T5 -------------------------------------------------------------------

  test "a refused replacement op stays in the authenticated history with its Core reason" do
    # (a) Tripwire: Space has no :replace_catalog_v1 command, and command_status runs
    # before cap_ok, so the reason is :unknown_command. PR 1 adds the command and must
    # flip this assertion to an authority (or application) reason.
    fx = leased()
    {sim, candidate} = replace_candidate(fx.sim, "admin", fx.delegation.id)
    sim = Sim.sync_all(sim)
    assert Op.valid?(candidate)

    for realm <- @realms do
      log = Sim.log(sim, realm)
      assert MapSet.member?(Log.op_ids(log), candidate.id)
      assert Sim.quarantined(sim, realm, candidate.id) == {true, :unknown_command}
      assert Authority.analyze(Space, log).reasons[candidate.id] == :unknown_command
    end

    # (b) A declared admin command under the leased cap is retained with a Core
    # authority reason. Lapse needs epoch > expires_epoch (6): epoch 6 still honors.
    {sim, at6} = Sim.beacon(fx.sim, "root", 6)

    {sim, ok} =
      Sim.command(sim, "admin", :create_thread, ["thread:a", "A"], cap: fx.delegation.id)

    sim = Sim.sync_all(sim)
    assert Sim.quarantined(sim, "observer", ok.id) == false
    assert %{op_id: at6.id, epoch: 6} in elem(beacon_evidence(sim), 1)

    {sim, at7} = Sim.beacon(sim, "root", 7)
    sim = Sim.sync_all(sim)

    {sim, late} =
      Sim.command(sim, "admin", :create_thread, ["thread:b", "B"], cap: fx.delegation.id)

    sim = Sim.sync_all(sim)
    assert %{op_id: at7.id, epoch: 7} in elem(beacon_evidence(sim), 1)
    assert_retained(sim, late, :lease_expired)

    # Revoked variant on a fresh leased fixture.
    fx = leased()
    {sim, _revoke} = Sim.revoke(fx.sim, "root", fx.delegation.id)
    sim = Sim.sync_all(sim)

    {sim, revoked} =
      Sim.command(sim, "admin", :create_thread, ["thread:c", "C"], cap: fx.delegation.id)

    sim = Sim.sync_all(sim)
    assert_retained(sim, revoked, :revoked_capability)
  end

  defp beacon_evidence(sim),
    do: Authority.analyze_with_beacon_evidence(Space, Sim.log(sim, "observer"))

  defp assert_retained(sim, op, reason) do
    assert Op.valid?(op)

    for realm <- @realms do
      log = Sim.log(sim, realm)
      assert MapSet.member?(Log.op_ids(log), op.id)
      assert Sim.quarantined(sim, realm, op.id) == {true, reason}
      assert Authority.analyze(Space, log).reasons[op.id] == reason
    end
  end
end
