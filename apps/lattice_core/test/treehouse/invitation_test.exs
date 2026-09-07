defmodule Treehouse.InvitationTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Sim, Sync}
  alias Treehouse.{Invitation, Space}

  defp founded do
    {sim, _} =
      Space
      |> Sim.new("treehouse:invites", ["root", "alice", "bob"], seed: "invites")
      |> Sim.create_replica("root")

    {sim, _} = Sim.command(sim, "root", :create_thread, ["thread:one", "One"])
    sim
  end

  defp recipient(sim, realm),
    do: sim |> Sim.identity(realm) |> Map.fetch!(:pub) |> Base.encode64()

  test "issue binds one canonical recipient and the exact current Thread scope" do
    sim = founded()
    alice = recipient(sim, "alice")

    for args <- [
          ["not-a-key", ["thread:one"]],
          [alice, []],
          [alice, ["thread:one", "thread:one"]],
          [alice, ["other-thread"]]
        ] do
      {candidate, op} = Sim.command(sim, "root", :issue_invitation, args)
      assert {true, :application_invalid_invitation} == Sim.quarantined(candidate, "root", op.id)
      assert Sim.state(candidate, "root") == Sim.state(sim, "root")
    end
  end

  test "acceptance cannot change recipient, invitation, Space, signature or membership level" do
    sim = founded()
    alice = recipient(sim, "alice")
    {sim, invite} = Sim.command(sim, "root", :issue_invitation, [alice, ["thread:one"]])
    signature = Invitation.accept(Sim.identity(sim, "alice"), Sim.replica(sim), invite)
    wrong_space = Invitation.accept(Sim.identity(sim, "alice"), "other-space", invite)
    wrong_signer = Invitation.accept(Sim.identity(sim, "bob"), Sim.replica(sim), invite)

    for args <- [
          [invite.id, recipient(sim, "bob"), "member", signature],
          [invite.id, alice, "admin", signature],
          [invite.id, alice, "member", wrong_space],
          [invite.id, alice, "member", wrong_signer],
          [invite.id, alice, "member", ""]
        ] do
      {candidate, op} = Sim.command(sim, "root", :admit_member, args)
      assert {true, :application_invalid_invitation} == Sim.quarantined(candidate, "root", op.id)
      assert Sim.state(candidate, "root").members == []
    end
  end

  test "revocation and changed Thread scope prevent later acceptance" do
    sim = founded()
    alice = recipient(sim, "alice")
    {sim, invite} = Sim.command(sim, "root", :issue_invitation, [alice, ["thread:one"]])
    signature = Invitation.accept(Sim.identity(sim, "alice"), Sim.replica(sim), invite)
    {revoked, _} = Sim.command(sim, "root", :revoke_invitation, [invite.id])
    {changed, _} = Sim.command(sim, "root", :create_thread, ["thread:two", "Two"])

    for candidate <- [revoked, changed] do
      {candidate, op} =
        Sim.command(candidate, "root", :admit_member, [invite.id, alice, "member", signature])

      assert {true, :application_invalid_invitation} == Sim.quarantined(candidate, "root", op.id)
      assert Sim.state(candidate, "root").members == []
    end
  end

  test "repeated authorized admission is one visible member and removal drops observed membership" do
    sim = founded()
    alice = recipient(sim, "alice")
    {sim, invite} = Sim.command(sim, "root", :issue_invitation, [alice, ["thread:one"]])
    signature = Invitation.accept(Sim.identity(sim, "alice"), Sim.replica(sim), invite)

    {sim, first} =
      Sim.command(sim, "root", :admit_member, [invite.id, alice, "member", signature])

    {sim, repeat} =
      Sim.command(sim, "root", :admit_member, [invite.id, alice, "member", signature])

    assert first.id != repeat.id
    assert false == Sim.quarantined(sim, "root", repeat.id)
    assert Sim.state(sim, "root").members == [alice]
    {sim, removed} = Sim.command(sim, "root", :remove_member, [alice])
    assert false == Sim.quarantined(sim, "root", removed.id)
    assert Sim.state(sim, "root").members == []
  end

  test "concurrent revocation does not rewrite admission's causal verdict" do
    sim = founded()
    alice = recipient(sim, "alice")
    {sim, invite} = Sim.command(sim, "root", :issue_invitation, [alice, ["thread:one"]])
    signature = Invitation.accept(Sim.identity(sim, "alice"), Sim.replica(sim), invite)

    {_, admitted} =
      Sim.command(sim, "root", :admit_member, [invite.id, alice, "member", signature])

    {_, revoked} = Sim.command(sim, "root", :revoke_invitation, [invite.id])
    assert admitted.deps == revoked.deps

    for order <- [[admitted, revoked], [revoked, admitted]] do
      {log, report} = Sync.deliver(Sim.log(sim, "root"), order)
      assert report.pending == []
      assert Authority.quarantine(Space, log) == MapSet.new()
      assert Lattice.state(Space, log).members == [alice]
    end
  end

  test "a causally visible quarantined revocation cannot close an invitation" do
    sim = founded()
    alice = recipient(sim, "alice")
    {sim, invite} = Sim.command(sim, "root", :issue_invitation, [alice, ["thread:one"]])
    {sim, grant} = Sim.grant(sim, "root", "bob", ops: [:revoke_invitation])
    sim = Sim.sync_all(sim)
    {sim, forged} = Sim.command(sim, "bob", :revoke_invitation, [invite.id], cap: grant.id)
    sim = Sim.sync_all(sim)
    signature = Invitation.accept(Sim.identity(sim, "alice"), Sim.replica(sim), invite)

    {sim, admitted} =
      Sim.command(sim, "root", :admit_member, [invite.id, alice, "member", signature])

    assert {true, :role_not_granted} == Sim.quarantined(sim, "root", forged.id)
    assert false == Sim.quarantined(sim, "root", admitted.id)
    assert Sim.state(sim, "root").members == [alice]
  end

  test "malformed invitation argument types refuse before policy or state effects" do
    sim = founded()
    alice = recipient(sim, "alice")

    for {command, args} <- [
          {:issue_invitation, [42, []]},
          {:issue_invitation, [alice, [42]]},
          {:issue_invitation, [alice, "thread:one"]},
          {:revoke_invitation, [42]},
          {:admit_member, [42, alice, "member", "sig"]},
          {:admit_member, ["id", [alice], "member", "sig"]},
          {:admit_member, ["id", alice, ["member"], "sig"]},
          {:admit_member, ["id", alice, "member", nil]}
        ] do
      {candidate, op} = Sim.command(sim, "root", command, args)
      assert {true, :malformed_command} == Sim.quarantined(candidate, "root", op.id)
      assert Sim.state(candidate, "root") == Sim.state(sim, "root")
    end
  end

  test "revocation must cite an honored causal invitation" do
    sim = founded()
    {sim, wrong_kind} = Sim.command(sim, "root", :create_space, ["not an invite"])
    {sim, denied} = Sim.command(sim, "root", :issue_invitation, ["bad-key", ["thread:one"]])

    for {id, reason} <- [
          {"missing", :application_target_not_visible},
          {wrong_kind.id, :application_wrong_target},
          {denied.id, :application_target_quarantined}
        ] do
      {candidate, op} = Sim.command(sim, "root", :revoke_invitation, [id])
      assert {true, reason} == Sim.quarantined(candidate, "root", op.id)
      assert Sim.state(candidate, "root").revoked_invitations == []
    end
  end
end
