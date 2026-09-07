defmodule Treehouse.MemberContinuityPolicyTest do
  use ExUnit.Case, async: true
  alias Lattice.{Dag, Identity, Op}
  alias Treehouse.MemberContinuity
  alias Treehouse.MemberContinuityCertificate, as: Certificate
  alias Treehouse.MemberContinuityVectors, as: Vectors

  test "a closed certificate without causal targets cannot authorize a statement" do
    f = Vectors.fixture()

    op =
      Op.new(
        f.root,
        f.claim.space,
        f.claim.deps,
        :command,
        {:attest_member_key_v1, [f.claim, f.certificate.possession, f.certificate.vouches]}
      )

    assert {:error, :application_target_not_visible} =
             MemberContinuity.command_op_status(op, MapSet.new(), %{
               visible_ops: %{},
               verdicts: %{},
               valid_beacons: []
             })
  end

  test "shape precedes missing evidence and cryptographic failure" do
    f = Vectors.fixture()

    op =
      Op.new(
        f.root,
        f.claim.space,
        f.claim.deps,
        :command,
        {:attest_member_key_v1,
         [Map.put(f.claim, :extra, true), <<0::512>>, f.certificate.vouches]}
      )

    assert {:error, :application_invalid_continuity} =
             MemberContinuity.command_op_status(op, MapSet.new(), %{
               visible_ops: %{},
               verdicts: %{},
               valid_beacons: []
             })
  end

  test "signed zero and exact active tags pass; bad signatures fail last" do
    {f, claim, context} = causal_fixture()
    op = signed(f, claim)
    assert :ok = judge(op, context)
    {:attest_member_key_v1, [c, _, v]} = op.body
    bad = %{op | body: {:attest_member_key_v1, [c, <<0::512>>, v]}}
    assert {:error, :application_continuity_invalid_certificate} = judge(bad, context)

    assert {:error, :application_continuity_invalid_epoch} =
             judge(op, %{context | valid_beacons: []})

    assert {:error, :application_continuity_invalid_epoch} =
             judge(op, %{
               context
               | valid_beacons: [%{op_id: hd(claim.epoch_basis), epoch: 9_007_199_254_740_992}]
             })
  end

  test "target tiers scan all references before quarantined and wrong targets" do
    {f, claim, context} = causal_fixture()
    missing = hd(claim.vouchers).admission

    quarantined = %{
      context
      | verdicts: Map.put(context.verdicts, claim.old_admission, :bad_signature)
    }

    missing_context = %{quarantined | visible_ops: Map.delete(context.visible_ops, missing)}
    assert {:error, :application_target_not_visible} = judge(signed(f, claim), missing_context)
    assert {:error, :application_target_quarantined} = judge(signed(f, claim), quarantined)
    wrong = %{claim | old_pub: Identity.from_seed("stranger", "stranger").pub}
    assert {:error, :application_wrong_target} = judge(signed(f, wrong), context)
  end

  test "causal remove readmit does not revive the selected voucher admission" do
    {f, claim, context} = causal_fixture()
    voucher = hd(claim.vouchers)

    remove =
      Op.new(
        f.root,
        claim.space,
        claim.deps,
        :command,
        {:remove_member, [Base.encode64(voucher.member)]}
      )

    readmit = admission(f, voucher.member, [remove.id])
    context = add(context, [remove, readmit])
    claim = %{claim | deps: [readmit.id]}
    assert {:error, :application_continuity_ineligible_member} = judge(signed(f, claim), context)
    claim = %{claim | vouchers: [%{voucher | admission: readmit.id}, Enum.at(claim.vouchers, 1)]}
    assert :ok = judge(signed(f, claim), context)
  end

  test "old status is aggregate OR-set state, not selected tag liveness" do
    {f, claim, context} = causal_fixture()

    remove =
      Op.new(
        f.root,
        claim.space,
        claim.deps,
        :command,
        {:remove_member, [Base.encode64(claim.old_pub)]}
      )

    context = add(context, [remove])
    claim = %{claim | deps: [remove.id]}
    assert {:error, :application_continuity_ineligible_member} = judge(signed(f, claim), context)
    assert :ok = judge(signed(f, %{claim | old_membership: :removed}), context)
    readmit = admission(f, claim.old_pub, [remove.id])
    assert :ok = judge(signed(f, %{claim | deps: [readmit.id]}), add(context, [readmit]))
  end

  test "concurrent exact-tag removal denies; later removal preserves historical statement" do
    {f, claim, context} = causal_fixture()
    op = signed(f, claim)
    key = hd(claim.vouchers).member

    remove =
      Op.new(f.root, claim.space, claim.deps, :command, {:remove_member, [Base.encode64(key)]})

    assert conflicts(add(context, [op, remove])) == %{
             op.id => :application_continuity_stale_voucher
           }

    later = Op.new(f.root, claim.space, [op.id], :command, {:remove_member, [Base.encode64(key)]})
    assert conflicts(add(context, [op, later])) == %{}
    unseen = Op.new(f.root, claim.space, [], :command, {:remove_member, [Base.encode64(key)]})
    assert conflicts(add(context, [op, unseen])) == %{}
  end

  test "cross-old collision denies both and propagates only to causal parent wrappers" do
    {f, claim, context} = causal_fixture()
    a = signed(f, claim)
    b = signed(f, %{claim | old_pub: Identity.from_seed("other", "other").pub})

    resolution =
      signed(f, %{claim | deps: Enum.sort([a.id, b.id]), parents: [Certificate.claim_id(claim)]})

    denied = conflicts(add(context, [a, b, resolution]))
    assert denied[a.id] == :application_continuity_conflicting_target
    assert denied[b.id] == :application_continuity_conflicting_target
    assert denied[resolution.id] == :application_continuity_invalid_parent
    reversed = add(context, Enum.reverse([a, b, resolution]))
    assert conflicts(reversed) == denied

    individually_denied = %{
      reversed
      | verdicts: Map.put(reversed.verdicts, b.id, :operation_not_granted)
    }

    assert conflicts(individually_denied) == %{}
  end

  test "stale voucher seeds take priority over cross-old collision" do
    {f, claim, context} = causal_fixture()
    a = signed(f, claim)
    b = signed(f, %{claim | old_pub: Identity.from_seed("other", "other").pub})

    remove =
      Op.new(
        f.root,
        claim.space,
        claim.deps,
        :command,
        {:remove_member, [Base.encode64(hd(claim.vouchers).member)]}
      )

    denied = conflicts(add(context, [a, b, remove]))
    assert denied[a.id] == :application_continuity_stale_voucher
    assert denied[b.id] == :application_continuity_stale_voucher
  end

  test "missing all-head context precedes signature failure" do
    {f, claim, context} = causal_fixture()
    parent = signed(f, claim)
    context = add(context, [parent])
    next = %{claim | deps: [parent.id], nonce: <<2::256>>}
    assert {:error, :application_continuity_stale_context} = judge(signed(f, next), context)
    resolution = %{next | parents: [Certificate.claim_id(claim)]}
    assert :ok = judge(signed(f, resolution), context)
    malformed_parent = %{parent | body: {:attest_member_key_v1, [claim, <<>>, []]}}

    context = %{
      context
      | visible_ops: Map.put(context.visible_ops, parent.id, malformed_parent),
        verdicts: Map.put(context.verdicts, parent.id, :application_invalid_continuity)
    }

    assert {:error, :application_target_quarantined} = judge(signed(f, resolution), context)
  end

  test "same-old heads are coalesced by claim ID with no selected winner" do
    {f, claim, _} = causal_fixture()
    a = signed(f, claim)
    b_claim = %{claim | nonce: <<1::256>>}
    b = signed(f, b_claim)
    {:ok, ca} = MemberContinuity.certificate(a)
    {:ok, cb} = MemberContinuity.certificate(b)

    assert MemberContinuity.heads([{a.id, ca}, {"wrapper", ca}, {b.id, cb}], claim.old_pub) ==
             Enum.sort([Certificate.claim_id(claim), Certificate.claim_id(b_claim)])
  end

  defp judge(op, context),
    do: MemberContinuity.command_op_status(op, MapSet.new(Map.keys(context.visible_ops)), context)

  defp conflicts(context) do
    ancestors =
      Map.new(context.visible_ops, fn {id, _} -> {id, Dag.ancestors(context.visible_ops, id)} end)

    MemberContinuity.command_conflicts(context.visible_ops, context.verdicts, ancestors)
  end

  defp add(context, ops) do
    %{
      context
      | visible_ops: Map.merge(context.visible_ops, Map.new(ops, &{&1.id, &1})),
        verdicts: Map.merge(context.verdicts, Map.new(ops, &{&1.id, :honored}))
    }
  end

  defp causal_fixture do
    f = Vectors.fixture()
    old = admission(f, f.old.pub, [])
    vouchers = Enum.map(f.members, &admission(f, &1.pub, []))

    beacon =
      Op.new(f.root, f.claim.space, Enum.map([old | vouchers], & &1.id), :authority, {:beacon, 0})

    claim = %{
      f.claim
      | old_admission: old.id,
        deps: [beacon.id],
        epoch_basis: [beacon.id],
        vouchers: Enum.zip_with(f.members, vouchers, &%{member: &1.pub, admission: &2.id})
    }

    context =
      add(%{visible_ops: %{}, verdicts: %{}, valid_beacons: [%{op_id: beacon.id, epoch: 0}]}, [
        old,
        beacon | vouchers
      ])

    {f, claim, context}
  end

  defp admission(f, key, deps),
    do:
      Op.new(
        f.root,
        f.claim.space,
        deps,
        :command,
        {:admit_member,
         ["test-only-invitation", Base.encode64(key), "member", "test-only-acceptance"]}
      )

  defp signed(f, claim) do
    possession = Identity.sign(f.next, Certificate.possession_bytes(claim))

    vouches =
      Enum.map(
        f.members,
        &%{
          member: &1.pub,
          signature: Identity.sign(&1, Certificate.vouch_bytes(claim, possession))
        }
      )

    Op.new(
      f.root,
      claim.space,
      claim.deps,
      :command,
      {:attest_member_key_v1, [claim, possession, vouches]}
    )
  end
end
