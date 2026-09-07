defmodule Treehouse.MemberContinuityPrecedenceTest do
  use ExUnit.Case, async: true
  alias Lattice.{Authority, Identity, Log, Op, Sim}
  alias Treehouse.{MemberContinuity, Space}
  alias Treehouse.MemberContinuityCertificate, as: Certificate
  alias Treehouse.MemberContinuitySemanticFixture, as: Fixture

  test "signed public frames pin shape, all target tiers, eligibility, epoch and certificate precedence" do
    {sim, claim} = Fixture.founded()
    base = Sim.log(sim, "root")
    {_, valid} = Fixture.attest(sim, claim)
    {:attest_member_key_v1, [_, possession, vouches]} = valid.body
    missing = :crypto.hash(:sha256, "absent admission") |> Base.url_encode64(padding: false)

    cases = [
      {Map.put(claim, :surplus, true), :application_invalid_continuity},
      {%{claim | old_admission: missing, epoch: 99}, :application_target_not_visible},
      {%{claim | old_admission: hd(claim.epoch_basis), epoch: 99}, :application_wrong_target},
      {%{claim | old_admission: hd(claim.vouchers).admission, epoch: 99},
       :application_wrong_target},
      {%{claim | epoch_basis: [claim.old_admission], old_membership: :removed},
       :application_wrong_target},
      {%{claim | old_membership: :removed, epoch: 99}, :application_continuity_ineligible_member},
      {%{claim | epoch: 99}, :application_continuity_invalid_epoch}
    ]

    for {changed, expected} <- cases do
      op = raw(sim, valid.cap, changed, <<0::512>>, vouches)
      assert Op.valid?(op)
      log = Log.append!(base, op)
      assert :ok = Log.verify_authenticity(log)
      assert Authority.analyze(Space, log).reasons[op.id] == expected
      assert Lattice.state(Space, log) == Lattice.state(Space, base)
    end

    bad = raw(sim, valid.cap, claim, <<0::512>>, vouches)

    assert Authority.analyze(Space, Log.append!(base, bad)).reasons[bad.id] ==
             :application_continuity_invalid_certificate

    assert possession != <<0::512>>
  end

  test "outer dependency duplicates refuse despite valid legacy canonical signature" do
    {sim, claim} = Fixture.founded()
    {_, op} = Fixture.attest(sim, claim)
    duplicated = %{op | deps: op.deps ++ op.deps}
    assert Op.valid?(duplicated)
    log = Log.append!(Sim.log(sim, "root"), duplicated)
    assert :ok = Log.verify_authenticity(log)
    assert Authority.analyze(Space, log).reasons[op.id] == :application_invalid_continuity
  end

  test "missing target wins over another quarantined target in either voucher order" do
    {sim, original} = Fixture.founded()
    {_, valid} = Fixture.attest(sim, original)

    {sim, denied} =
      Sim.command(sim, "root", :admit_member, [
        original.old_admission,
        Base.encode64(original.old_pub),
        "member",
        "wrong-acceptance"
      ])

    base = Sim.log(sim, "root")
    missing = :crypto.hash(:sha256, "absent voucher") |> Base.url_encode64(padding: false)

    claim = %{
      original
      | deps: Log.frontier(base),
        old_admission: denied.id,
        vouchers: [%{hd(original.vouchers) | admission: missing}, Enum.at(original.vouchers, 1)]
    }

    {:attest_member_key_v1, [_, _, vouches]} = valid.body
    op = raw(sim, valid.cap, claim, <<0::512>>, vouches)

    assert Authority.analyze(Space, Log.append!(base, op)).reasons[op.id] ==
             :application_target_not_visible

    claim = %{claim | vouchers: original.vouchers}
    op = raw(sim, valid.cap, claim, <<0::512>>, vouches)

    assert Authority.analyze(Space, Log.append!(base, op)).reasons[op.id] ==
             :application_target_quarantined
  end

  test "unauthorized basis is quarantined before eligibility or bad signature" do
    {sim, original} = Fixture.founded()
    {_, valid} = Fixture.attest(sim, original)
    {sim, bad_beacon} = Sim.beacon(Sim.sync_all(sim), "new", 1)
    sim = Sim.sync_all(sim)
    base = Sim.log(sim, "root")

    claim = %{
      original
      | deps: Log.frontier(base),
        epoch: 1,
        epoch_basis: [bad_beacon.id],
        old_membership: :removed
    }

    {:attest_member_key_v1, [_, _, vouches]} = valid.body
    op = raw(sim, valid.cap, claim, <<0::512>>, vouches)

    assert Authority.analyze(Space, Log.append!(base, op)).reasons[op.id] ==
             :application_target_quarantined
  end

  test "seventeen retained same-old heads expose capacity without selecting or truncating" do
    {sim, original} = Fixture.founded()
    {_, template} = Fixture.attest(sim, original)
    base = Sim.log(sim, "root")

    ops =
      Enum.map(1..17, fn i ->
        claim = %{original | nonce: <<i::256>>}
        signed(sim, claim, template.cap)
      end)

    log = Enum.reduce(ops, base, &Log.append!(&2, &1))
    assert {:ok, observed} = MemberContinuity.observe(log)
    assert length(observed.records) == 17
    assert [%{status: :capacity_stop, heads: heads}] = observed.links
    assert length(heads) == 17

    request = %{
      old_pub: original.old_pub,
      new_pub: original.new_pub,
      old_admission: original.old_admission,
      old_membership: :active,
      nonce: <<18::256>>,
      voucher_admissions: Enum.map(original.vouchers, & &1.admission),
      author: template.author,
      cap_id: template.cap
    }

    assert {:error, :capacity_stop} = MemberContinuity.review(log, request)
  end

  defp signed(sim, claim, cap) do
    possession = Identity.sign(Sim.identity(sim, "new"), Certificate.possession_bytes(claim))

    vouches =
      Enum.map(claim.vouchers, fn voucher ->
        member = Enum.find(Map.values(sim.realms), &(&1.pub == voucher.member))

        %{
          member: member.pub,
          signature: Identity.sign(member, Certificate.vouch_bytes(claim, possession))
        }
      end)

    raw(sim, cap, claim, possession, vouches)
  end

  defp raw(sim, cap, claim, possession, vouches),
    do:
      Op.new(
        Sim.identity(sim, "root"),
        sim.replica,
        claim.deps,
        :command,
        {:attest_member_key_v1, [claim, possession, vouches]},
        cap: cap
      )
end
