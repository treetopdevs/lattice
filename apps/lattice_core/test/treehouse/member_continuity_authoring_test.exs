defmodule Treehouse.MemberContinuityAuthoringTest do
  use ExUnit.Case, async: true
  alias Lattice.{Authority, Identity, Log, Op, Sim}
  alias Lattice.Carrier.Wire
  alias Treehouse.{MemberContinuity, MemberContinuityAuthoring, Space}
  alias Treehouse.MemberContinuityCertificate, as: Certificate
  alias Treehouse.MemberContinuitySemanticFixture, as: Fixture

  test "review derives signed bytes and assembly authenticates an ordinary honored frame" do
    {sim, claim, request} = fixture()
    log = Sim.log(sim, "root")
    assert {:ok, review} = MemberContinuity.review(log, request)
    assert review.claim == claim
    assert review.claim_bytes == Certificate.claim_bytes(claim)
    assert review.verified_frontier == Log.frontier(log)
    certificate = certificate(sim, review.claim)
    before = Sim.state(sim, "root")

    assert {:ok, result} =
             MemberContinuity.assemble(log, review, certificate, Sim.identity(sim, "root"))

    assert {:ok, op} = Wire.decode_op(result.frame)
    assert Op.valid?(op)
    assert op == result.op
    assert {:ok, accepted} = Log.accept(log, op)
    assert {:ok, observed} = MemberContinuity.observe(accepted)
    assert [%{status: :attested}] = observed.links
    assert Lattice.state(Space, accepted) == %{before | admin_actions: "attest_member_key_v1"}
    assert {:ok, duplicate} = Log.accept(accepted, op)
    assert duplicate == accepted
  end

  test "changed frontier, tampered review and bad vouch never invoke the signer" do
    {sim, _claim, request} = fixture()
    log = Sim.log(sim, "root")
    assert {:ok, review} = MemberContinuity.review(log, request)
    cert = certificate(sim, review.claim)
    signer = forbidden_signer(request.author)
    {changed, _} = Sim.command(sim, "root", :create_space, ["changed"])

    assert {:error, :stale_verified_state} =
             MemberContinuity.assemble(Sim.log(changed, "root"), review, cert, signer)

    assert {:error, :stale_verified_state} =
             MemberContinuity.assemble(log, %{review | claim_bytes: "changed"}, cert, signer)

    assert {:error, :application_continuity_invalid_certificate} =
             MemberContinuity.assemble(log, review, %{cert | possession: <<0::512>>}, signer)

    refute_received :signer_called
  end

  test "revoked capability, wrong holder and signer identity cannot sign" do
    {sim, _claim, request} = fixture()
    log = Sim.log(sim, "root")
    assert {:ok, review} = MemberContinuity.review(log, request)
    cert = certificate(sim, review.claim)

    assert {:error, :wrong_signer} =
             MemberContinuity.assemble(
               log,
               review,
               cert,
               forbidden_signer(Sim.identity(sim, "a").pub)
             )

    {sim, cap} = Sim.grant(sim, "root", "a", ops: [:attest_member_key_v1])
    request_a = %{request | author: Sim.identity(sim, "a").pub, cap_id: cap.id}
    assert {:error, reason} = MemberContinuity.review(Sim.log(sim, "root"), request_a)
    assert reason == :role_not_granted
    {sim, _} = Sim.append(sim, "root", :authority, {:revoke, request.cap_id})

    assert {:error, :stale_verified_state} =
             MemberContinuity.assemble(
               Sim.log(sim, "root"),
               review,
               cert,
               forbidden_signer(request.author)
             )

    refute_received :signer_called
  end

  test "root possession cannot widen an existing six-command preview ceiling" do
    preview = [
      :create_space,
      :create_thread,
      :issue_invitation,
      :revoke_invitation,
      :admit_member,
      :remove_member
    ]

    {sim, claim} = Fixture.founded(ops: preview)
    base = Sim.log(sim, "root")

    cap =
      Enum.find_value(base.ops, fn
        {_, %Op{body: {:genesis, cap, _}}} -> if MapSet.member?(cap.ops, :admit_member), do: cap
        _ -> nil
      end)

    cert = certificate(sim, claim)

    op =
      Op.new(
        Sim.identity(sim, "root"),
        sim.replica,
        claim.deps,
        :command,
        {:attest_member_key_v1, [claim, cert.possession, cert.vouches]},
        cap: cap.id
      )

    assert Authority.analyze(Space, Log.append!(base, op)).reasons[op.id] ==
             :operation_not_granted

    assert MapSet.size(cap.ops) == 6
  end

  test "former admin's still-valid command capability cannot invoke signing after holder transfer" do
    {sim, _claim, request} = fixture()
    before = Sim.log(sim, "root")
    assert {:ok, review} = MemberContinuity.review(before, request)

    {sim, _cap} =
      Sim.transfer(sim, "root", "a", :admin, ops: [:attest_member_key_v1], expires_epoch: 6)

    log = Sim.log(sim, "root")
    assert {:error, :not_holder} = MemberContinuity.review(log, request)

    assert {:error, :stale_verified_state} =
             MemberContinuity.assemble(
               log,
               review,
               certificate(sim, review.claim),
               forbidden_signer(request.author)
             )

    refute_received :signer_called
  end

  test "closed review refuses caller-derived epoch, parents and membership rewriting" do
    {sim, claim, request} = fixture()
    log = Sim.log(sim, "root")

    assert {:error, :application_invalid_continuity} =
             MemberContinuity.review(log, Map.put(request, :epoch, 999))

    assert {:error, :application_invalid_continuity} =
             MemberContinuity.review(log, Map.put(request, :parents, []))

    {removed, _} = Sim.command(sim, "root", :remove_member, [Base.encode64(claim.old_pub)])

    assert {:error, :application_continuity_ineligible_member} =
             MemberContinuity.review(Sim.log(removed, "root"), request)

    assert {:ok, review} =
             MemberContinuity.review(Sim.log(removed, "root"), %{
               request
               | old_membership: :removed
             })

    assert review.claim.old_membership == :removed
  end

  test "bad returned signatures and raised signer errors never escape as frames" do
    {sim, _claim, request} = fixture()
    log = Sim.log(sim, "root")
    assert {:ok, review} = MemberContinuity.review(log, request)
    cert = certificate(sim, review.claim)

    assert {:error, _} =
             MemberContinuity.assemble(log, review, cert, %{
               pub: request.author,
               sign: fn _ -> <<0::512>> end
             })

    assert {:error, :invalid_signer_signature} =
             MemberContinuity.assemble(log, review, cert, %{
               pub: request.author,
               sign: fn _ -> <<0>> end
             })

    assert {:error, :signer_failed} =
             MemberContinuity.assemble(log, review, cert, %{
               pub: request.author,
               sign: fn _ -> raise "failure" end
             })
  end

  test "exact JSON push bound accepts 64000 and refuses 64001 actual signed envelopes" do
    {sim, _claim, _request} = fixture()
    root = Sim.identity(sim, "root")
    log = Sim.log(sim, "root")

    size = fn op ->
      byte_size(Jason.encode!(%{"type" => "push", "ops" => [Wire.encode_op(op)]}))
    end

    for target <- [64_000, 64_001] do
      # Ordinary inbox request references are integer terms; select a genuine
      # reference whose decimal length permits the Base64 text to hit the bound.
      op =
        Enum.find_value([1, 10, 100, 1000], fn ref ->
          build = fn text ->
            Op.new(
              root,
              sim.replica,
              Log.frontier(log),
              :inbox,
              {:request, ref, {:create_space, [text]}}
            )
          end

          delta = target - size.(build.(""))
          if rem(delta, 4) == 0, do: build.(String.duplicate("x", div(delta, 4) * 3))
        end)

      assert Op.valid?(op)
      assert {:ok, accepted} = Log.accept(log, op)
      assert :ok = Log.verify_authenticity(accepted)
      assert size.(op) == target

      assert MemberContinuityAuthoring.envelope_status(op) ==
               if(target == 64_000, do: :ok, else: {:error, :capacity_stop})
    end
  end

  test "oversized genuine retained frontier stops review and assembly before signer invocation" do
    {sim, _claim, request} = fixture()
    base = Sim.log(sim, "root")
    assert {:ok, review} = MemberContinuity.review(base, request)
    root = Sim.identity(sim, "root")

    branches =
      Enum.map(1..600, fn i ->
        Op.new(
          root,
          sim.replica,
          Log.frontier(base),
          :inbox,
          {:request, i, {:create_space, ["branch"]}}
        )
      end)

    log = Enum.reduce(branches, base, &Log.append!(&2, &1))
    assert :ok = Log.verify_authenticity(log)
    assert length(Log.frontier(log)) == 600
    assert {:error, :capacity_stop} = MemberContinuity.review(log, request)

    assert {:error, :capacity_stop} =
             MemberContinuity.assemble(
               log,
               review,
               certificate(sim, review.claim),
               forbidden_signer(request.author)
             )

    refute_received :signer_called
  end

  test "missing valid beacon and exact high epoch refuse fresh review" do
    {sim, claim, request} = fixture()
    base = Sim.log(sim, "root")
    no_beacon = Log.from_ops(base.replica, Map.delete(base.ops, hd(claim.epoch_basis)))
    assert :ok = Log.verify_authenticity(no_beacon)

    assert {:error, :application_continuity_invalid_epoch} =
             MemberContinuity.review(no_beacon, request)

    {sim, _} = Sim.beacon(sim, "root", 9_007_199_254_740_993)

    assert {:error, :application_continuity_invalid_epoch} =
             MemberContinuity.review(Sim.log(sim, "root"), request)
  end

  test "malformed derived vouchers refuse before a missing epoch" do
    {sim, claim, request} = fixture()
    base = Sim.log(sim, "root")
    no_beacon = Log.from_ops(base.replica, Map.delete(base.ops, hd(claim.epoch_basis)))
    assert :ok = Log.verify_authenticity(no_beacon)

    for malformed <- [
          %{request | voucher_admissions: [claim.old_admission, hd(request.voucher_admissions)]},
          %{request | new_pub: hd(claim.vouchers).member}
        ] do
      assert {:error, :application_invalid_continuity} =
               MemberContinuity.review(no_beacon, malformed)
    end
  end

  test "founder and lost old-member signing state are absent during actual witnessed continuation" do
    {sim, claim, request} = fixture()

    {sim, _} =
      Sim.transfer(sim, "root", "old", :admin, ops: [:attest_member_key_v1], expires_epoch: 6)

    sim = Sim.sync_all(sim)

    sim = %{
      sim
      | realms: Map.drop(sim.realms, ["root", "old"]),
        logs: Map.drop(sim.logs, ["root", "old"]),
        caps: Map.drop(sim.caps, ["root", "old"])
    }

    {sim, _} = Sim.beacon(sim, "a", 1, witnesses: ["a", "b"])
    sim = Sim.sync_all(sim)

    {sim, acquired} =
      Sim.continue_role(sim, "nominee", :admin,
        ops: [:attest_member_key_v1],
        expires_epoch: 7,
        witnesses: ["a", "b"]
      )

    refute Map.has_key?(sim.realms, "root")
    refute Map.has_key?(sim.realms, "old")
    assert false == Sim.quarantined(sim, "nominee", acquired.id)
    {:succeed, :admin, cap, _} = acquired.body
    request = %{request | author: Sim.identity(sim, "nominee").pub, cap_id: cap.id}
    log = Sim.log(sim, "nominee")
    assert {:ok, review} = MemberContinuity.review(log, request)
    assert review.claim.epoch == 1
    assert review.claim.old_pub == claim.old_pub

    assert {:ok, result} =
             MemberContinuity.assemble(
               log,
               review,
               certificate(sim, review.claim),
               Sim.identity(sim, "nominee")
             )

    assert {:ok, accepted} = Log.accept(log, result.op)
    assert {:ok, observed} = MemberContinuity.observe(accepted)
    assert [%{status: :attested}] = observed.links
  end

  test "analysis evidence exposes only judge-produced signed zero and preserves exact high evidence" do
    {sim, claim, _request} = fixture()
    log = Sim.log(sim, "root")

    {_analysis, evidence} = Authority.analyze_with_beacon_evidence(Space, log)

    assert evidence == [
             %{op_id: hd(claim.epoch_basis), epoch: 0}
           ]

    {unauthorized, bad} = Sim.beacon(Sim.sync_all(sim), "new", 9_007_199_254_740_993)
    unauthorized = Sim.sync_all(unauthorized)

    {analysis, evidence} =
      Authority.analyze_with_beacon_evidence(Space, Sim.log(unauthorized, "root"))

    assert analysis.reasons[bad.id] == :unauthorized_beacon
    assert evidence == [%{op_id: hd(claim.epoch_basis), epoch: 0}]
    {high, beacon} = Sim.beacon(sim, "root", 9_007_199_254_740_993)

    {_analysis, evidence} = Authority.analyze_with_beacon_evidence(Space, Sim.log(high, "root"))
    assert %{op_id: beacon.id, epoch: 9_007_199_254_740_993} in evidence
  end

  defp fixture do
    {sim, claim} = Fixture.founded()

    {:ok, cap_id} =
      Sim.log(sim, "root").ops
      |> Enum.find_value(fn
        {_, %Op{body: {:genesis, cap, _}}} ->
          if MapSet.member?(cap.ops, :attest_member_key_v1), do: {:ok, cap.id}

        _ ->
          nil
      end)

    request = %{
      old_pub: claim.old_pub,
      old_admission: claim.old_admission,
      new_pub: claim.new_pub,
      old_membership: claim.old_membership,
      nonce: claim.nonce,
      voucher_admissions: Enum.map(claim.vouchers, & &1.admission),
      author: Sim.identity(sim, "root").pub,
      cap_id: cap_id
    }

    {sim, claim, request}
  end

  defp certificate(sim, claim) do
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

    %{claim: claim, possession: possession, vouches: vouches}
  end

  defp forbidden_signer(pub),
    do: %{
      pub: pub,
      sign: fn _ ->
        send(self(), :signer_called)
        <<0::512>>
      end
    }
end
