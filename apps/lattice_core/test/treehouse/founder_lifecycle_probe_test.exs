defmodule Treehouse.FounderLifecycleProbeTest do
  @moduledoc """
  R02 characterization at 7610cc9b, using the existing Township schema as a Core
  authority probe. These assertions expose missing R03/R04 behavior; green does
  not mean the proposed Treehouse profile is ready. No production semantics or
  legacy vectors are changed. See docs/research/treehouse_founder_lifecycle.md.
  """
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Log, Sim}
  alias Lattice.Authority.Delegation
  alias Township.Matter

  defp founded(opts \\ []) do
    {name, opts} = Keyword.pop(opts, :name, "replica:r02:space")

    Sim.new(
      Matter,
      name,
      ["founder", "issuer", "successor", "member", "new_member", "w1", "w2", "w3"],
      seed: "r02-characterization"
    )
    |> Sim.create_replica("founder", opts)
    |> elem(0)
  end

  defp witnessed(name \\ "replica:r02:space") do
    founded(
      name: name,
      policies: %{
        clerk: %{
          successor: "successor",
          recovery: %{mode: :witnessed, version: 1, witnesses: ["w1", "w2", "w3"], threshold: 2}
        }
      }
    )
  end

  # Remove both signing identity and its log. Merely avoiding its use could hide
  # an accidentally surviving founder inside a purported loss scenario.
  defp lose(sim, realm) do
    %{
      sim
      | realms: Map.delete(sim.realms, realm),
        logs: Map.delete(sim.logs, realm),
        caps: Map.delete(sim.caps, realm)
    }
  end

  defp verdict_everywhere(sim, op, expected) do
    for realm <- Map.keys(sim.logs) do
      assert Sim.quarantined(sim, realm, op.id) == expected
    end

    states = for realm <- Map.keys(sim.logs), do: Sim.state(sim, realm)
    assert length(Enum.uniq(states)) == 1
  end

  test "P01 inclusive expiry and replay-stable pre-beacon commands" do
    {sim, grant} = Sim.grant(founded(), "founder", "member", ops: [:post], expires_epoch: 6)
    sim = Sim.sync_all(sim)
    {sim, _} = Sim.beacon(sim, "founder", 6)
    sim = Sim.sync_all(sim)
    {sim, last_day} = Sim.command(sim, "member", :post, ["epoch six"], cap: grant.id)
    sim = Sim.sync_all(sim)
    refute Authority.expired?(Sim.log(sim, "member"), grant.id)
    {sim, _} = Sim.beacon(sim, "founder", 7)
    sim = Sim.sync_all(sim)
    {sim, lapsed} = Sim.command(sim, "member", :post, ["epoch seven"], cap: grant.id)
    sim = Sim.sync_all(sim)
    verdict_everywhere(sim, last_day, false)
    verdict_everywhere(sim, lapsed, {true, :lease_expired})
    assert Authority.expired?(Sim.log(sim, "member"), grant.id)
  end

  test "P02 fresh children cannot renew beyond an expired founder parent" do
    {sim, parent} = Sim.grant(founded(), "founder", "issuer", ops: [:post], expires_epoch: 6)
    sim = Sim.sync_all(sim)
    {sim, _} = Sim.beacon(sim, "founder", 7)
    sim = sim |> Sim.sync_all() |> lose("founder")
    assert_raise KeyError, fn -> Sim.beacon(sim, "founder", 8) end

    {sim, within} = Sim.grant(sim, "issuer", "member", ops: [:post], expires_epoch: 6)
    {sim, beyond} = Sim.grant(sim, "issuer", "new_member", ops: [:post], expires_epoch: 13)
    sim = Sim.sync_all(sim)
    {sim, dead} = Sim.command(sim, "member", :post, ["expired parent"], cap: within.id)
    {sim, widened} = Sim.command(sim, "new_member", :post, ["extended parent"], cap: beyond.id)
    sim = Sim.sync_all(sim)
    assert within.parent_id == parent.id
    assert beyond.parent_id == parent.id

    beyond_intro =
      sim |> Sim.log("issuer") |> Log.topo_ops() |> Enum.find(&match?({:grant, ^beyond}, &1.body))

    verdict_everywhere(sim, dead, {true, :lease_expired})
    verdict_everywhere(sim, beyond_intro, {true, :not_attenuated})
    verdict_everywhere(sim, widened, {true, :invalid_capability})
  end

  test "P03 a surviving issuer revokes its child but cannot revoke the founder's grant" do
    {sim, founder_grant} = Sim.grant(founded(), "founder", "issuer", ops: [:post])
    sim = Sim.sync_all(sim)
    {sim, child} = Sim.grant(sim, "issuer", "member", ops: [:post])
    sim = sim |> Sim.sync_all() |> lose("founder")
    {sim, allowed} = Sim.revoke(sim, "issuer", child.id)
    {sim, denied} = Sim.revoke(sim, "issuer", founder_grant.id)
    sim = Sim.sync_all(sim)
    {sim, child_post} = Sim.command(sim, "member", :post, ["revoked"], cap: child.id)

    {sim, permanent} =
      Sim.command(sim, "issuer", :post, ["unleased residual"], cap: founder_grant.id)

    sim = Sim.sync_all(sim)
    verdict_everywhere(sim, allowed, false)
    verdict_everywhere(sim, denied, {true, :unauthorized_revoke})
    verdict_everywhere(sim, child_post, {true, :revoked_capability})
    verdict_everywhere(sim, permanent, false)
  end

  test "P04 founder loss before pinning cannot be repaired with an impostor genesis" do
    sim = founded() |> lose("founder")
    {sim, no_policy} = Sim.succeed(sim, "successor", :clerk, at_tick: 99)
    identity = Sim.identity(sim, "successor")
    impostor = Delegation.genesis(identity, sim.replica, ops: [:post], roles: [:clerk])

    {sim, false_pin} =
      Sim.append(
        sim,
        "successor",
        :authority,
        {:genesis, impostor, %{clerk: %{successor: identity.pub, dormant_ticks: 0}}}
      )

    sim = Sim.sync_all(sim)
    verdict_everywhere(sim, no_policy, {true, :unauthorized_succession})
    verdict_everywhere(sim, false_pin, {true, :impostor_genesis})
    assert Authority.bind_replica("replica:r02:space", identity.pub) != sim.replica
  end

  test "P05 an unconfigured witnessed beacon is refused without lapsing a lease" do
    {sim, grant} = Sim.grant(founded(), "founder", "member", ops: [:post], expires_epoch: 6)
    sim = sim |> Sim.sync_all() |> lose("founder")
    {sim, simple} = Sim.beacon(sim, "w1", 7)
    {sim, future_shape} = Sim.append(sim, "w1", :authority, {:beacon, 7, %{}})
    sim = Sim.sync_all(sim)
    verdict_everywhere(sim, simple, {true, :unauthorized_beacon})
    # R02 A13 / Plan179 migration exception: R03 adds only this audit refusal
    # to the formerly inert three-field shape. The epoch and state stay inert.
    verdict_everywhere(sim, future_shape, {true, :unauthorized_beacon})
    refute Authority.expired?(Sim.log(sim, "member"), grant.id)
    {sim, post} = Sim.command(sim, "member", :post, ["clock has not advanced"], cap: grant.id)
    verdict_everywhere(Sim.sync_all(sim), post, false)

    configured =
      founded(
        policies: %{
          __beacon__: %{
            mode: :witnessed,
            version: 1,
            witnesses: ["w1", "w2", "w3"],
            threshold: 2,
            max_epoch_step: 1
          }
        }
      )

    policy =
      Authority.analyze(configured.module, Sim.log(configured, "member")).policies.__beacon__

    assert policy.mode == :witnessed
    assert policy.version == 1
    assert policy.threshold == 2
    assert policy.max_epoch_step == 1
    assert policy.witnesses == Enum.map(["w1", "w2", "w3"], &Sim.identity(configured, &1).pub)
  end

  test "P06 one lost witness leaves two-of-three succession; two lost witnesses stop it" do
    sim = witnessed() |> lose("founder") |> lose("w3")
    {sim, acquired} = Sim.succeed(sim, "successor", :clerk, witnesses: ["w1", "w2"])
    sim = Sim.sync_all(sim)
    verdict_everywhere(sim, acquired, false)
    assert Sim.holder(sim, "member", :clerk) == Sim.identity(sim, "successor").pub

    one_left = witnessed() |> lose("founder") |> lose("w2") |> lose("w3")
    {one_left, denied} = Sim.succeed(one_left, "successor", :clerk, witnesses: ["w1"])
    verdict_everywhere(Sim.sync_all(one_left), denied, {true, :insufficient_recovery_witnesses})
  end

  test "P07 current succession can exceed its predecessor's acquisition scope" do
    {sim, narrow} =
      Sim.transfer(witnessed(), "founder", "issuer", :clerk,
        ops: [:close_matter, :reopen_matter],
        expires_epoch: 6
      )

    sim = sim |> Sim.sync_all() |> lose("founder")

    {sim, acquired} =
      Sim.succeed(sim, "successor", :clerk,
        ops: [:post, :admit, :remove_member, :close_matter, :reopen_matter],
        witnesses: ["w1", "w2"]
      )

    {:succeed, :clerk, expanded, _proof} = acquired.body
    refute MapSet.subset?(expanded.ops, narrow.ops)
    assert expanded.parent_id == nil
    assert expanded.expires_epoch == nil
    sim = Sim.sync_all(sim)
    {sim, admission} = Sim.command(sim, "successor", :admit, ["new member"], cap: expanded.id)
    {sim, child} = Sim.grant(sim, "successor", "new_member", ops: [:post], expires_epoch: 13)
    sim = Sim.sync_all(sim)
    {sim, post} = Sim.command(sim, "new_member", :post, ["expanded authority"], cap: child.id)
    sim = Sim.sync_all(sim)
    verdict_everywhere(sim, acquired, false)
    verdict_everywhere(sim, admission, false)
    verdict_everywhere(sim, post, false)
  end

  test "P08 materialized membership removal alone does not revoke an existing Core capability" do
    {sim, cap} = Sim.grant(founded(), "founder", "member", ops: [:post])
    {sim, _} = Sim.command(sim, "founder", :admit, ["member"])
    {sim, _} = Sim.command(sim, "founder", :remove_member, ["member"])
    sim = Sim.sync_all(sim)
    {sim, post} = Sim.command(sim, "member", :post, ["capability remains"], cap: cap.id)
    sim = Sim.sync_all(sim)
    refute "member" in Sim.state(sim, "member").members
    verdict_everywhere(sim, post, false)
  end

  test "P09 a surviving key can create its own child root but a Space cap grants no child authority" do
    {space, parent_cap} = Sim.grant(founded(), "founder", "issuer", ops: [:post])
    space = space |> Sim.sync_all() |> lose("founder")

    {child, genesis} =
      Sim.new(Matter, "replica:r02:new-thread", ["issuer", "member"],
        seed: "r02-characterization"
      )
      |> Sim.create_replica("issuer")

    assert Sim.identity(space, "issuer").pub == Sim.identity(child, "issuer").pub
    assert child.replica != space.replica
    {child, foreign_grant} = Sim.append(child, "issuer", :authority, {:grant, parent_cap})
    {child, post} = Sim.command(child, "issuer", :post, ["new independent root"])
    child = Sim.sync_all(child)
    verdict_everywhere(child, genesis, false)
    verdict_everywhere(child, foreign_grant, {true, :wrong_replica})
    verdict_everywhere(child, post, false)
  end

  test "P10 grant byte identity permits exact retry but re-authoring a grant op grows the log" do
    sim = founded()
    {once, grant} = Sim.grant(sim, "founder", "member", ops: [:post], expires_epoch: 6)
    {twice, same_grant} = Sim.grant(once, "founder", "member", ops: [:post], expires_epoch: 6)
    assert same_grant == grant
    assert Log.size(Sim.log(twice, "founder")) == Log.size(Sim.log(once, "founder")) + 1
    grant_op = Sim.log(once, "founder") |> Log.topo_ops() |> List.last()
    assert Log.append!(Sim.log(once, "founder"), grant_op) == Sim.log(once, "founder")
  end

  test "P11 twelve pinned replicas do not repair the thirteenth unpinned replica" do
    groups =
      for index <- 0..12 do
        name = "replica:r02:partial:#{index}"
        sim = if index < 12, do: witnessed(name), else: founded(name: name)
        lose(sim, "founder")
      end

    assert length(Enum.uniq_by(groups, & &1.replica)) == 13

    for {sim, index} <- Enum.with_index(groups) do
      opts = if index < 12, do: [witnesses: ["w1", "w2"]], else: [at_tick: 99]
      {sim, succession} = Sim.succeed(sim, "successor", :clerk, opts)
      expected = if index < 12, do: false, else: {true, :unauthorized_succession}
      verdict_everywhere(Sim.sync_all(sim), succession, expected)
    end
  end

  test "P12 revoked and expired holder capability does not erase the honored role acquisition" do
    {sim, holder_cap} =
      Sim.transfer(witnessed(), "founder", "issuer", :clerk,
        ops: [:close_matter, :reopen_matter],
        expires_epoch: 6
      )

    sim = Sim.sync_all(sim)
    {sim, _} = Sim.revoke(sim, "founder", holder_cap.id)
    {sim, _} = Sim.beacon(sim, "founder", 7)
    sim = sim |> Sim.sync_all() |> lose("founder")
    assert Authority.revoked?(Sim.log(sim, "issuer"), holder_cap.id)
    assert Authority.expired?(Sim.log(sim, "issuer"), holder_cap.id)
    assert Sim.holder(sim, "member", :clerk) == Sim.identity(sim, "issuer").pub

    {sim, succession} =
      Sim.succeed(sim, "successor", :clerk,
        ops: [:close_matter, :reopen_matter],
        witnesses: ["w1", "w2"]
      )

    {:succeed, :clerk, successor_cap, _proof} = succession.body
    sim = Sim.sync_all(sim)
    {sim, close} = Sim.command(sim, "successor", :close_matter, [], cap: successor_cap.id)
    sim = Sim.sync_all(sim)
    verdict_everywhere(sim, succession, false)
    verdict_everywhere(sim, close, false)
  end
end
