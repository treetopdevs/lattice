defmodule Treehouse.MemberContinuityPerformanceTest do
  use ExUnit.Case, async: false

  alias Lattice.{Authority, Dag, Identity, Log, Op, Sim}
  alias Treehouse.{Invitation, Space}
  alias Treehouse.MemberContinuityCertificate, as: Certificate
  alias Treehouse.MemberContinuitySemanticFixture, as: Fixture

  test "ordinary analysis computes the ancestor closure once for independent continuities" do
    {sim, template} = Fixture.founded()
    {sim, old_members} = admit_old_members(sim, 6)
    log = Sim.log(sim, "root")
    cap = continuity_cap(log)

    log =
      Enum.reduce(Enum.with_index(old_members), log, fn {{old, admission}, index}, log ->
        new = Identity.from_seed("new-#{index}", "continuity-performance-new-#{index}")

        claim = %{
          template
          | old_pub: old.pub,
            old_admission: admission,
            new_pub: new.pub,
            nonce: <<index::256>>,
            deps: Log.frontier(log),
            parents: []
        }

        Log.append!(log, continuity_op(sim, cap, claim, new))
      end)

    parent = self()
    tracer = spawn_link(fn -> trace_loop(parent, Dag, :all_ancestors, 1, 0) end)
    :erlang.trace_pattern({Dag, :all_ancestors, 1}, true, [:global])
    :erlang.trace(self(), true, [:call, {:tracer, tracer}])

    on_exit(fn ->
      :erlang.trace_pattern({Dag, :all_ancestors, 1}, false, [:global])
    end)

    analysis = Authority.analyze(Space, log)
    assert analysis.reasons == %{}
    :erlang.trace(self(), false, [:call])
    delivered = :erlang.trace_delivered(self())
    assert_receive {:trace_delivered, _pid, ^delivered}
    send(tracer, {:count, self()})
    assert_receive {:trace_count, 1}
  end

  defp admit_old_members(sim, count) do
    Enum.reduce(1..count, {sim, []}, fn index, {sim, members} ->
      identity = Identity.from_seed("old-#{index}", "continuity-performance-old-#{index}")
      recipient = Base.encode64(identity.pub)
      {sim, invite} = Sim.command(sim, "root", :issue_invitation, [recipient, []])

      {sim, admission} =
        Sim.command(sim, "root", :admit_member, [
          invite.id,
          recipient,
          "member",
          Invitation.accept(identity, sim.replica, invite)
        ])

      {sim, [{identity, admission.id} | members]}
    end)
  end

  defp continuity_cap(log) do
    Enum.find_value(log.ops, fn
      {_, %Op{body: {:genesis, delegation, _}}} ->
        if MapSet.member?(delegation.ops, :attest_member_key_v1), do: delegation.id

      _ ->
        nil
    end)
  end

  defp continuity_op(sim, cap, claim, new) do
    possession = Identity.sign(new, Certificate.possession_bytes(claim))

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

  defp trace_loop(parent, module, function, arity, count) do
    receive do
      {:trace, _pid, :call, {^module, ^function, args}} when length(args) == arity ->
        trace_loop(parent, module, function, arity, count + 1)

      {:count, ^parent} ->
        send(parent, {:trace_count, count})
    end
  end
end
