defmodule Treehouse.MemberContinuitySemanticFixture do
  @moduledoc "Synthetic genuine signed Space membership and continuity fixtures."
  import ExUnit.Assertions
  alias Lattice.Authority.Delegation
  alias Lattice.{Identity, Log, Sim}
  alias Treehouse.{Invitation, Space}
  alias Treehouse.MemberContinuityCertificate, as: Certificate

  def founded(opts \\ []) do
    nonce = :crypto.hash(:sha256, "continuity-real-judge") |> Base.url_encode64(padding: false)

    {sim, _} =
      Sim.new(
        Space,
        "replica:treehouse:space:#{nonce}#authority:bounded-continuation-v1",
        ["root", "old", "new", "a", "b", "nominee"],
        seed: "continuity-real-judge"
      )
      |> Sim.create_replica("root", opts)

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

  def attest(sim, claim) do
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
