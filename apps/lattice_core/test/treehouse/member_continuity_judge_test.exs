defmodule Treehouse.MemberContinuityJudgeTest do
  use ExUnit.Case, async: true
  alias Lattice.{Authority, Identity, Log, Op, Sim}
  alias Lattice.Authority.Delegation
  alias Treehouse.{Invitation, MemberContinuity, Space}
  alias Treehouse.MemberContinuityCertificate, as: Certificate

  # Test-only registration connects the new callback to the real unchanged judge
  # and existing Space effects. Production Space remains unavailable.
  defmodule Adapter do
    defdelegate __lattice_fields__(), to: Space
    defdelegate __lattice_ephemeral__(), to: Space
    defdelegate __lattice_succession__(), to: Space
    defdelegate field_spec(field), to: Space
    defdelegate authority_role(field), to: Space

    def __lattice_commands__,
      do:
        Space.__lattice_commands__() ++
          [{:attest_member_key_v1, 3, [:claim, :possession, :vouches]}]

    def command_body(:attest_member_key_v1, [_, _, _] = args),
      do: {:ok, {:attest_member_key_v1, args}}

    def command_body(name, args), do: Space.command_body(name, args)

    def __apply_command__(:attest_member_key_v1, [_, _, _]),
      do: [{:admin_actions, {:write, "attest_member_key_v1"}}]

    def __apply_command__(name, args), do: Space.__apply_command__(name, args)

    def command_op_status(%Op{body: {:attest_member_key_v1, _}} = op, visible, context),
      do: MemberContinuity.command_op_status(op, visible, context)

    def command_op_status(op, visible, context), do: Space.command_op_status(op, visible, context)
    defdelegate command_conflicts(ops, verdicts, ancestors), to: MemberContinuity
  end

  test "actual authenticated judge honors only the admin marker after genuine member admissions" do
    {sim, claim} = founded()
    before = Sim.state(sim, "root")
    {sim, op} = attest(sim, claim)
    assert :ok = Log.verify_authenticity(Sim.log(sim, "root"))
    assert false == Sim.quarantined(sim, "root", op.id)
    after_state = Sim.state(sim, "root")
    assert after_state == %{before | admin_actions: "attest_member_key_v1"}
    assert Authority.analyze(Space, Sim.log(sim, "root")).reasons[op.id] == :unknown_command
    assert {:ok, observed} = MemberContinuity.observe(Sim.log(sim, "root"))
    assert observed.records == []

    assert [%{status: :unlinked, affected_wrappers: [%{op_id: id, reason: :unknown_command}]}] =
             observed.links

    assert id == op.id
    forged = %{op | sig: <<0::512>>}
    log = Sim.log(sim, "root")

    assert {:error, :invalid_verified_history} =
             MemberContinuity.observe(%{log | ops: Map.put(log.ops, op.id, forged)})
  end

  test "observation refuses missing closure, mismatched stored identity and wrong replica" do
    {sim, _claim} = founded()
    log = Sim.log(sim, "root")
    [head] = Log.frontier(log)
    missing = hd(log.ops[head].deps)

    assert {:error, :invalid_verified_history} =
             MemberContinuity.observe(%{log | ops: Map.delete(log.ops, missing)})

    assert {:error, :invalid_verified_history} =
             MemberContinuity.observe(%{
               log
               | ops: Map.put(log.ops, "duplicate-alias", log.ops[head])
             })

    assert {:error, :invalid_verified_history} =
             MemberContinuity.observe(%{log | replica: "wrong-replica"})

    assert {:error, :invalid_verified_history} =
             MemberContinuity.observe(%{log | referenced: MapSet.new()})

    assert {:error, :unsupported_continuity_history} =
             MemberContinuity.observe(Log.new("legacy-space"))

    assert {:error, :invalid_verified_history} =
             MemberContinuity.observe(%{verdicts: %{head => :honored}})
  end

  test "ordinary capability refusal precedes malformed application claims" do
    {sim, claim} = founded()
    {sim, cap} = Sim.grant(sim, "root", "root", ops: [:create_space])

    {sim, op} =
      Sim.command(
        sim,
        "root",
        :attest_member_key_v1,
        [%{claim | deps: Log.frontier(Sim.log(sim, "root"))}, <<>>, []],
        cap: cap.id
      )

    assert {true, :operation_not_granted} == Sim.quarantined(sim, "root", op.id)
  end

  test "authenticated concurrent removal causes final denial in both log delivery orders" do
    {sim, claim} = founded()
    base = Sim.log(sim, "root")
    {sim, op} = attest(sim, claim)
    root = Sim.identity(sim, "root")

    remove =
      Op.new(
        root,
        sim.replica,
        Log.frontier(base),
        :command,
        {:remove_member, [Base.encode64(hd(claim.vouchers).member)]},
        cap: op.cap
      )

    for order <- [[op, remove], [remove, op]] do
      log = Enum.reduce(order, base, &Log.append!(&2, &1))
      assert :ok = Log.verify_authenticity(log)

      assert Authority.analyze(Adapter, log).reasons[op.id] ==
               :application_continuity_stale_voucher

      path =
        Path.join(
          System.tmp_dir!(),
          "continuity-judge-#{System.unique_integer([:positive])}.dump"
        )

      on_exit(fn -> File.rm(path) end)
      assert :ok = Log.dump(log, path)
      assert {:ok, %{log: restored}} = Log.restore_verified(path)

      assert Authority.analyze(Adapter, restored).reasons ==
               Authority.analyze(Adapter, log).reasons
    end
  end

  defp founded do
    nonce = :crypto.hash(:sha256, "continuity-real-judge") |> Base.url_encode64(padding: false)

    {sim, _} =
      Sim.new(
        Adapter,
        "replica:treehouse:space:#{nonce}#authority:bounded-continuation-v1",
        ["root", "old", "new", "a", "b", "nominee"],
        seed: "continuity-real-judge"
      )
      |> Sim.create_replica("root")

    root = Sim.identity(sim, "root")
    witnesses = Enum.map(["a", "b", "old"], &Sim.identity(sim, &1).pub) |> Enum.sort()

    profile = %{
      mode: :bounded_continuation,
      version: 1,
      product: :treehouse,
      kind: :space,
      role: :admin,
      nominee: Sim.identity(sim, "nominee").pub,
      witnesses: witnesses,
      threshold: 2,
      max_lease_epochs: 7
    }

    beacon_profile = %{
      mode: :witnessed,
      version: 1,
      witnesses: witnesses,
      threshold: 2,
      max_epoch_step: 1
    }

    pin = Delegation.genesis(root, sim.replica, ops: [], roles: [], live: false)

    {sim, _} =
      Sim.append(
        sim,
        "root",
        :authority,
        {:genesis, pin, %{__continuation__: profile, __beacon__: beacon_profile}}
      )

    {sim, admissions} =
      Enum.reduce(["old", "a", "b"], {sim, %{}}, fn realm, {sim, admissions} ->
        identity = Sim.identity(sim, realm)
        recipient = Base.encode64(identity.pub)
        {sim, invite} = Sim.command(sim, "root", :issue_invitation, [recipient, []])
        signature = Invitation.accept(identity, sim.replica, invite)

        {sim, admitted} =
          Sim.command(sim, "root", :admit_member, [invite.id, recipient, "member", signature])

        assert false == Sim.quarantined(sim, "root", admitted.id)
        {sim, Map.put(admissions, realm, admitted.id)}
      end)

    {sim, beacon} = Sim.beacon(sim, "root", 0)

    claim = %{
      version: 1,
      product: :treehouse,
      space: sim.replica,
      old_pub: Sim.identity(sim, "old").pub,
      new_pub: Sim.identity(sim, "new").pub,
      old_admission: admissions["old"],
      old_membership: :active,
      nonce: <<0::256>>,
      deps: Log.frontier(Sim.log(sim, "root")),
      epoch: 0,
      epoch_basis: [beacon.id],
      parents: [],
      vouchers:
        Enum.map(["a", "b"], &%{member: Sim.identity(sim, &1).pub, admission: admissions[&1]})
        |> Enum.sort_by(& &1.member)
    }

    {sim, claim}
  end

  defp attest(sim, claim) do
    possession = Identity.sign(Sim.identity(sim, "new"), Certificate.possession_bytes(claim))

    vouches =
      Enum.map(["a", "b"], fn name ->
        member = Sim.identity(sim, name)

        %{
          member: member.pub,
          signature: Identity.sign(member, Certificate.vouch_bytes(claim, possession))
        }
      end)
      |> Enum.sort_by(& &1.member)

    Sim.command(sim, "root", :attest_member_key_v1, [claim, possession, vouches])
  end
end
