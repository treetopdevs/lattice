defmodule Treehouse.MemberContinuityConflictTest do
  use ExUnit.Case, async: true
  alias Lattice.{Authority, Identity, Log, Op, Sim}
  alias Treehouse.{Invitation, MemberContinuity, Space}
  alias Treehouse.MemberContinuityCertificate, as: Certificate
  alias Treehouse.MemberContinuitySemanticFixture, as: Fixture

  test "same-old fork stays contested and a fresh all-head resolution supersedes both" do
    {sim, original} = Fixture.founded()
    log = Sim.log(sim, "root")
    a = op(sim, original)
    other = %{original | nonce: <<1::256>>}
    b = op(sim, other)

    for order <- [[a, b], [b, a]] do
      fork = append(log, order)
      assert {:ok, observed} = MemberContinuity.observe(fork)
      assert [%{status: :contested, heads: heads}] = observed.links
      assert heads == Enum.sort([Certificate.claim_id(original), Certificate.claim_id(other)])
      resolution = %{original | deps: Log.frontier(fork), parents: heads, nonce: <<2::256>>}
      resolved_op = op(sim, resolution)
      resolved = append(fork, [resolved_op])
      assert {:ok, observed} = MemberContinuity.observe(resolved)
      assert [%{status: :attested, heads: [head]}] = observed.links
      assert head == Certificate.claim_id(resolution)
      assert length(observed.records) == 3
      omitted = %{resolution | parents: [hd(heads)]}
      missing = op(sim, omitted)

      assert Authority.analyze(Space, append(fork, [missing])).reasons[missing.id] ==
               :application_continuity_stale_context
    end
  end

  test "malformed and valid causal wrappers of one claim do not crash or hide the valid parent" do
    {sim, original} = Fixture.founded()
    log = Sim.log(sim, "root")
    valid = op(sim, original)
    {:attest_member_key_v1, [claim, _, vouches]} = valid.body

    malformed =
      Op.new(
        Sim.identity(sim, "root"),
        sim.replica,
        valid.deps,
        :command,
        {:attest_member_key_v1, [claim, <<>>, vouches]},
        cap: valid.cap
      )

    for wrappers <- [[valid, malformed], [malformed, valid]] do
      log = append(log, wrappers)

      resolution = %{
        original
        | deps: Log.frontier(log),
          parents: [Certificate.claim_id(original)],
          nonce: <<3::256>>
      }

      resolved = op(sim, resolution)
      analysis = Authority.analyze(Space, append(log, [resolved]))
      assert analysis.reasons[malformed.id] == :application_invalid_continuity
      refute Map.has_key?(analysis.reasons, resolved.id)
    end
  end

  test "two valid wrappers coalesce while preserving both raw capability references" do
    {sim, original} = Fixture.founded()
    {sim, child} = Sim.grant(sim, "root", "root", ops: [:attest_member_key_v1], roles: [:admin])
    log = Sim.log(sim, "root")
    claim = %{original | deps: Log.frontier(log)}
    a = op(sim, claim)
    b = op(sim, claim, child.id)
    assert a.id != b.id
    assert {:ok, observed} = MemberContinuity.observe(append(log, [a, b]))
    assert [%{wrappers: wrappers}] = observed.records
    assert Enum.map(wrappers, & &1.op_id) == Enum.sort([a.id, b.id])
    assert MapSet.new(wrappers, & &1.cap_id) == MapSet.new([a.cap, b.cap])
  end

  test "different old members competing for one target are both denied without choosing a winner" do
    {sim, original} = Fixture.founded()
    root = Sim.identity(sim, "root")
    {sim, invite} = Sim.command(sim, "root", :issue_invitation, [Base.encode64(root.pub), []])

    {sim, admission} =
      Sim.command(sim, "root", :admit_member, [
        invite.id,
        Base.encode64(root.pub),
        "member",
        Invitation.accept(root, sim.replica, invite)
      ])

    log = Sim.log(sim, "root")
    first = %{original | deps: Log.frontier(log)}
    second = %{first | old_pub: root.pub, old_admission: admission.id}
    a = op(sim, first)
    b = op(sim, second)

    for order <- [[a, b], [b, a]] do
      joined = append(log, order)
      analysis = Authority.analyze(Space, joined)
      assert analysis.reasons[a.id] == :application_continuity_conflicting_target
      assert analysis.reasons[b.id] == :application_continuity_conflicting_target
      assert {:ok, observed} = MemberContinuity.observe(joined)
      assert observed.records == []
      assert Enum.all?(observed.links, &(&1.status == :unlinked))
    end

    causal = op(sim, %{second | deps: [a.id]})

    assert Authority.analyze(Space, append(log, [a, causal])).reasons[causal.id] ==
             :application_continuity_ineligible_member
  end

  test "unseen future parent conflict propagates without denying unrelated resolution vouchers" do
    {sim, original} = Fixture.founded()
    root = Sim.identity(sim, "root")
    base = Sim.log(sim, "root")
    parent = op(sim, original)
    removed_voucher = hd(original.vouchers)

    remove =
      Op.new(
        root,
        sim.replica,
        Log.frontier(base),
        :command,
        {:remove_member, [Base.encode64(removed_voucher.member)]},
        cap: parent.cap
      )

    sim = %{sim | logs: Map.put(sim.logs, "root", append(base, [parent]))}
    {sim, invite} = Sim.command(sim, "root", :issue_invitation, [Base.encode64(root.pub), []])

    {sim, admission} =
      Sim.command(sim, "root", :admit_member, [
        invite.id,
        Base.encode64(root.pub),
        "member",
        Invitation.accept(root, sim.replica, invite)
      ])

    before_heal = Sim.log(sim, "root")

    claim = %{
      original
      | deps: Log.frontier(before_heal),
        parents: [Certificate.claim_id(original)],
        nonce: <<4::256>>,
        vouchers:
          Enum.sort_by(
            [
              %{member: root.pub, admission: admission.id},
              Enum.at(original.vouchers, 1)
            ],
            & &1.member
          )
    }

    resolution = op(sim, claim)

    refute Map.has_key?(
             Authority.analyze(Space, append(before_heal, [resolution])).reasons,
             resolution.id
           )

    for order <- [
          [parent, invite, admission, resolution, remove],
          [remove, parent, invite, admission, resolution]
        ] do
      log = append(base, order)
      analysis = Authority.analyze(Space, log)
      assert analysis.reasons[parent.id] == :application_continuity_stale_voucher
      assert analysis.reasons[resolution.id] == :application_continuity_invalid_parent
      assert {:ok, observed} = MemberContinuity.observe(log)
      assert [%{status: :review_required}] = observed.links
    end
  end

  test "fresh review after observed stale-voucher loss uses final causal heads" do
    {sim, original} = Fixture.founded()
    parent = op(sim, original)
    voucher = hd(original.vouchers)
    member = Enum.find(Map.values(sim.realms), &(&1.pub == voucher.member))
    {sim, _} = Sim.command(sim, "root", :remove_member, [Base.encode64(voucher.member)])

    {sim, invite} =
      Sim.command(sim, "root", :issue_invitation, [Base.encode64(voucher.member), []])

    {sim, admission} =
      Sim.command(sim, "root", :admit_member, [
        invite.id,
        Base.encode64(voucher.member),
        "member",
        Invitation.accept(member, sim.replica, invite)
      ])

    log = append(Sim.log(sim, "root"), [parent])

    assert Authority.analyze(Space, log).reasons[parent.id] ==
             :application_continuity_stale_voucher

    request = %{
      old_pub: original.old_pub,
      old_admission: original.old_admission,
      new_pub: original.new_pub,
      old_membership: :active,
      nonce: <<9::256>>,
      voucher_admissions: [admission.id, Enum.at(original.vouchers, 1).admission],
      author: Sim.identity(sim, "root").pub,
      cap_id: parent.cap
    }

    assert {:ok, review} = MemberContinuity.review(log, request)
    assert review.claim.parents == []
  end

  defp op(sim, claim, cap \\ nil) do
    cap =
      cap ||
        Enum.find_value(Sim.log(sim, "root").ops, fn
          {_, %Op{body: {:genesis, delegation, _}}} ->
            if MapSet.member?(delegation.ops, :attest_member_key_v1), do: delegation.id

          _ ->
            nil
        end)

    possession = Identity.sign(Sim.identity(sim, "new"), Certificate.possession_bytes(claim))

    vouches =
      Enum.map(claim.vouchers, fn voucher ->
        member = Enum.find(Map.values(sim.realms), &(&1.pub == voucher.member))

        %{
          member: member.pub,
          signature: Identity.sign(member, Certificate.vouch_bytes(claim, possession))
        }
      end)

    Op.new(
      Sim.identity(sim, "root"),
      sim.replica,
      claim.deps,
      :command,
      {:attest_member_key_v1, [claim, possession, vouches]},
      cap: cap
    )
  end

  defp append(log, ops) do
    log = Enum.reduce(ops, log, &Log.append!(&2, &1))
    assert :ok = Log.verify_authenticity(log)
    log
  end
end
