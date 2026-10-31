defmodule Lattice2.MalformedDelegationTest do
  @moduledoc """
  Row 289: a correctly signed delegation whose `ops` or `roles` is a list, not a
  `MapSet`, must fail `Delegation.valid_sig?/1` and be judged `:bad_delegation_sig`.
  `Authority.analyze/2` and `Lattice.Verdict` must not raise on that log.
  """
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Identity, Log, Op, Sim, Verdict}
  alias Lattice.Authority.Delegation
  alias Lattice.Demo.Thread

  @replica "replica:malformed-delegation"
  @module Thread

  defp issuer, do: Identity.from_seed("issuer", "malformed:issuer")
  defp audience, do: Identity.from_seed("audience", "malformed:audience")

  test "valid_sig? is false when ops is the signed names as a list" do
    d = Delegation.new(issuer(), @replica, audience().pub, ops: [:post])
    assert Delegation.valid_sig?(d)
    refute Delegation.valid_sig?(%{d | ops: [:post]})
  end

  test "valid_sig? is false when roles is the signed names as a list" do
    d = Delegation.new(issuer(), @replica, audience().pub, roles: [:moderator])
    assert Delegation.valid_sig?(d)
    refute Delegation.valid_sig?(%{d | roles: [:moderator]})
  end

  test "attenuates? is false, not a raise, when the child's ops is a list" do
    parent = Delegation.new(issuer(), @replica, audience().pub, ops: [:post], live: true)

    child =
      Delegation.new(audience(), @replica, issuer().pub,
        ops: [:post],
        parent_id: parent.id
      )

    assert Delegation.attenuates?(child, parent)
    refute Delegation.attenuates?(%{child | ops: [:post]}, parent)
  end

  test "a grant whose ops is a list does not crash the judge" do
    {log, grant, post} = grant_log(ops: [:post], as_list: :ops, command: {:post, ["x"]})

    assert Op.valid?(grant)
    assert {:ok, _} = log |> Log.dump_bytes() |> Log.restore_verified_bytes()

    analysis = Authority.analyze(@module, log)
    assert analysis.reasons[grant.id] == :bad_delegation_sig
    assert analysis.reasons[post.id] == :invalid_capability

    assert %{status: :invalid} = Verdict.delegation_status(@module, log, carried_id(grant))
  end

  test "a grant whose roles is a list does not crash the judge" do
    {log, grant, lock} =
      grant_log(ops: [:lock], roles: [:moderator], as_list: :roles, command: {:lock, []})

    assert Op.valid?(grant)

    analysis = Authority.analyze(@module, log)
    assert analysis.reasons[grant.id] == :bad_delegation_sig
    assert analysis.reasons[lock.id] == :invalid_capability

    assert %{status: :invalid} = Verdict.delegation_status(@module, log, carried_id(grant))
  end

  test "a genesis whose roles is a list does not crash the judge" do
    sim = Sim.new(@module, @replica, ["r0", "r1"], seed: "row-289-genesis")
    {sim, _genesis} = Sim.create_replica(sim, "r0")
    log = Sim.log(sim, "r0")
    genesis = Enum.find(Log.topo_ops(log), &match?(%Op{body: {:genesis, _, _}}, &1))
    {:genesis, d, policies} = genesis.body
    rewritten = %{genesis | body: {:genesis, %{d | roles: MapSet.to_list(d.roles)}, policies}}
    assert Op.valid?(rewritten)

    log = Log.from_ops(log.replica, Map.put(log.ops, genesis.id, rewritten))
    analysis = Authority.analyze(@module, log)
    assert analysis.reasons[rewritten.id] == :bad_delegation_sig
    assert %{status: :invalid} = Verdict.delegation_status(@module, log, d.id)
  end

  defp grant_log(opts) do
    as_list = Keyword.fetch!(opts, :as_list)
    {cmd, args} = Keyword.fetch!(opts, :command)
    grant_opts = Keyword.take(opts, [:ops, :roles])

    sim = Sim.new(@module, @replica, ["r0", "r1"], seed: "row-289-#{as_list}")
    {sim, _genesis} = Sim.create_replica(sim, "r0")
    {_sim, good} = Sim.grant(sim, "r0", "r1", grant_opts)
    malformed = %{good | as_list => MapSet.to_list(Map.fetch!(good, as_list))}
    {sim, grant} = Sim.append(sim, "r0", :authority, {:grant, malformed})
    {sim, command} = Sim.command(Sim.sync_all(sim), "r1", cmd, args, cap: malformed.id)
    log = sim |> Sim.sync_all() |> Sim.log("r0")
    {log, grant, command}
  end

  defp carried_id(%Op{body: {:grant, %Delegation{id: id}}}), do: id
end
