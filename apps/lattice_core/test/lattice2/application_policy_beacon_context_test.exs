defmodule Lattice2.ApplicationPolicyBeaconContextTest do
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Wire
  alias Lattice.{Authority, Log, Op, Sim}

  defmodule ContextReplica do
    use Lattice.Replica

    state do
      field(:events, merge: :causal_list, default: [])
      field(:admin_events, authority: :admin, default: nil)
    end

    command(:baseline, [:value], do: [{:events, {:append, value}}])
    command(:probe, [:expected], do: [{:events, {:append, expected}}])
    command(:admin_probe, [:expected], do: [{:admin_events, {:write, expected}}])

    def command_op_status(%Op{body: {name, [expected]}} = op, visible, context)
        when name in [:probe, :admin_probe] do
      notify({:policy, op.id, Enum.sort(visible), context})

      case Map.fetch(context, :valid_beacons) do
        :error -> {:error, :missing_valid_beacons}
        {:ok, ^expected} -> :ok
        {:ok, _other} -> {:error, :wrong_valid_beacons}
      end
    end

    def command_op_status(op, visible, context) do
      notify({:policy, op.id, Enum.sort(visible), context})
      :ok
    end

    def command_conflicts(ops, verdicts, ancestors) do
      notify({:conflicts, ops, verdicts, ancestors})
      %{}
    end

    defp notify(event) do
      if observer = Process.get(:authority_evidence_observer), do: send(observer, event)
    end
  end

  defmodule LegacyReplica do
    use Lattice.Replica

    state do
      field(:events, merge: :causal_list, default: [])
    end

    command(:baseline, [:value], do: [{:events, {:append, value}}])
    command(:legacy_deny, [:value], do: [{:events, {:append, value}}])

    def command_op_status(%Op{body: {:legacy_deny, [_]}}, _visible),
      do: {:error, :legacy_application_denied}

    def command_op_status(_op, _visible), do: :ok
  end

  @tag :beacon_api
  test "each public entry point is one pass and preserves the exact seven-key map in every family" do
    for family <- [:legacy, :bounded, :unsupported] do
      sim = founded("public-api-#{family}", family: family)
      {sim, zero} = Sim.beacon(sim, "root", 0)
      {sim, high} = Sim.beacon(sim, "root", 18_446_744_073_709_551_615)
      expected = records([{zero, 0}, {high, 18_446_744_073_709_551_615}])

      cap =
        sim
        |> Sim.log("root")
        |> Log.topo_ops()
        |> hd()
        |> Map.fetch!(:body)
        |> elem(1)
        |> Map.fetch!(:id)

      {sim, command} = Sim.command(sim, "root", :probe, [expected], cap: cap)
      authenticate!(sim, "root")
      log = Sim.log(sim, "root")
      {ordinary, ordinary_events} = observed(fn -> Authority.analyze(ContextReplica, log) end)

      {{analysis, evidence}, evidence_events} =
        observed(fn -> Authority.analyze_with_beacon_evidence(ContextReplica, log) end)

      assert analysis == ordinary

      assert :erlang.term_to_binary(analysis, [:deterministic]) ==
               :erlang.term_to_binary(ordinary, [:deterministic])

      assert Enum.sort(Map.keys(analysis)) == [
               :audit,
               :holder_epochs,
               :holders,
               :policies,
               :quarantine,
               :reasons,
               :requests
             ]

      assert evidence == expected
      assert evidence_events == ordinary_events

      assert [{:policy, id, _visible, context}, {:conflicts, _ops, _verdicts, _ancestors}] =
               evidence_events

      assert id == command.id
      assert context.valid_beacons == expected

      if family == :unsupported,
        do: assert(analysis.reasons[command.id] == :unsupported_authority_profile)
    end
  end

  @tag :beacon_api
  test "global evidence retains valid concurrent and future records while callbacks keep strict past" do
    sim = founded("global-api")
    {empty, []} = Authority.analyze_with_beacon_evidence(ContextReplica, Sim.log(sim, "root"))
    assert empty == Authority.analyze(ContextReplica, Sim.log(sim, "root"))
    {sim, grant} = Sim.grant(sim, "root", "peer", ops: [:probe])
    {sim, zero} = Sim.beacon(sim, "root", 0)
    sim = sim |> Sim.sync_all() |> Sim.partition("root", "peer")
    {sim, concurrent} = Sim.beacon(sim, "root", 4)
    expected = records([{zero, 0}])
    {sim, command} = Sim.command(sim, "peer", :probe, [expected], cap: grant.id)
    sim = sim |> Sim.heal("root", "peer") |> Sim.sync_all()
    {sim, future} = Sim.beacon(sim, "root", 9)
    log = Sim.log(sim, "root")
    authenticate!(sim, "root")

    {{analysis, evidence}, events} =
      observed(fn -> Authority.analyze_with_beacon_evidence(ContextReplica, log) end)

    refute Map.has_key?(analysis.reasons, command.id)
    assert evidence == records([{zero, 0}, {concurrent, 4}, {future, 9}])
    assert [{:policy, id, _visible, context}, {:conflicts, _, _, _}] = events
    assert id == command.id
    assert context.valid_beacons == expected
  end

  defp observed(fun) do
    old = Process.put(:authority_evidence_observer, self())

    try do
      value = fun.()
      {value, evidence_events([])}
    after
      if old,
        do: Process.put(:authority_evidence_observer, old),
        else: Process.delete(:authority_evidence_observer)
    end
  end

  defp evidence_events(acc) do
    receive do
      {:policy, _, _, _} = event -> evidence_events([event | acc])
      {:conflicts, _, _, _} = event -> evidence_events([event | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  test "context is present and empty before any signed beacon" do
    sim = founded("empty")
    {sim, command} = Sim.command(sim, "root", :probe, [[]])
    assert_honored(sim, "root", command, [])
  end

  test "signed epoch zero is one causal record rather than absent evidence" do
    sim = founded("zero")
    {sim, zero} = Sim.beacon(sim, "root", 0)
    assert false == Sim.quarantined(sim, "root", zero.id)
    expected = records([{zero, 0}])
    {sim, command} = Sim.command(sim, "root", :probe, [expected])
    assert_honored(sim, "root", command, expected)
  end

  test "causal concurrent witnessed maxima appear once each in exact ASCII ID order" do
    sim = founded("witnessed", witnessed: true)
    {sim, zero} = Sim.beacon(sim, "root", 0)
    sim = sim |> Sim.sync_all() |> Sim.partition("root", "peer")
    {sim, left} = Sim.beacon(sim, "root", 1, witnesses: ["root", "peer"])
    {sim, right} = Sim.beacon(sim, "peer", 1, witnesses: ["root", "peer"])
    sim = sim |> Sim.heal("root", "peer") |> Sim.sync_all()

    for beacon <- [zero, left, right],
        do: assert(false == Sim.quarantined(sim, "root", beacon.id))

    refute left.id in right.deps
    refute right.id in left.deps
    expected = records([{zero, 0}, {left, 1}, {right, 1}])
    assert length(expected) == 3
    {sim, command} = Sim.command(sim, "root", :probe, [expected])
    assert_honored(sim, "root", command, expected)
  end

  test "earlier causal epochs remain present alongside the maximum" do
    sim = founded("all-epochs")
    {sim, zero} = Sim.beacon(sim, "root", 0)
    {sim, earlier} = Sim.beacon(sim, "root", 2)
    {sim, maximum} = Sim.beacon(sim, "root", 9)
    expected = records([{zero, 0}, {earlier, 2}, {maximum, 9}])
    {sim, command} = Sim.command(sim, "root", :probe, [expected])
    assert_honored(sim, "root", command, expected)
  end

  test "two distinct high legacy uint64 epochs stay exact through signed Wire roundtrip" do
    sim = founded("high")
    {sim, first} = Sim.beacon(sim, "root", 9_007_199_254_740_992)
    {sim, last} = Sim.beacon(sim, "root", 18_446_744_073_709_551_615)
    assert false == Sim.quarantined(sim, "root", first.id)
    assert false == Sim.quarantined(sim, "root", last.id)
    expected = records([{first, 9_007_199_254_740_992}, {last, 18_446_744_073_709_551_615}])
    {sim, command} = Sim.command(sim, "root", :probe, [expected])
    assert_honored(sim, "root", command, expected)
  end

  test "valid concurrent and future beacons are excluded from the command's strict past" do
    sim = founded("strict-past")
    {sim, _grant} = Sim.grant(sim, "root", "peer", ops: [:probe])
    {sim, zero} = Sim.beacon(sim, "root", 0)
    sim = sim |> Sim.sync_all() |> Sim.partition("root", "peer")
    {sim, concurrent} = Sim.beacon(sim, "root", 4)
    expected = records([{zero, 0}])
    {sim, command} = Sim.command(sim, "peer", :probe, [expected])
    sim = sim |> Sim.heal("root", "peer") |> Sim.sync_all()
    {sim, future} = Sim.beacon(sim, "root", 7)
    sim = Sim.sync_all(sim)

    for beacon <- [zero, concurrent, future],
        do: assert(false == Sim.quarantined(sim, "peer", beacon.id))

    refute concurrent.id in command.deps
    assert command.id in future.deps
    assert_honored(sim, "peer", command, expected)
  end

  test "unauthorized, stale and command-kind beacon-shaped signed ops are excluded" do
    sim = founded("invalid-beacons")
    {sim, zero} = Sim.beacon(sim, "root", 0)
    {sim, five} = Sim.beacon(sim, "root", 5)
    sim = Sim.sync_all(sim)
    {sim, unauthorized} = Sim.beacon(sim, "peer", 18_446_744_073_709_551_615)
    sim = Sim.sync_all(sim)
    {sim, stale} = Sim.beacon(sim, "root", 5)
    {sim, wrong_kind} = Sim.append(sim, "root", :command, {:beacon, 8})
    {sim, invalid_certificate} = Sim.beacon(sim, "root", 6, certificate: %{})

    assert {true, :unauthorized_beacon} == Sim.quarantined(sim, "root", unauthorized.id)
    assert {true, :stale_beacon} == Sim.quarantined(sim, "root", stale.id)
    assert {true, :malformed_command} == Sim.quarantined(sim, "root", wrong_kind.id)
    assert {true, :unauthorized_beacon} == Sim.quarantined(sim, "root", invalid_certificate.id)
    expected = records([{zero, 0}, {five, 5}])
    {sim, command} = Sim.command(sim, "root", :probe, [expected])
    assert_honored(sim, "root", command, expected)
  end

  test "ordinary and legacy two-argument callbacks retain their outcomes" do
    sim = founded("ordinary")
    {sim, command} = Sim.command(sim, "root", :baseline, ["accepted"])
    authenticate!(sim, "root")
    assert false == Sim.quarantined(sim, "root", command.id)
    assert Sim.state(sim, "root").events == ["accepted"]

    legacy = founded("legacy", module: LegacyReplica)
    {legacy, accepted} = Sim.command(legacy, "root", :baseline, ["legacy-accepted"])
    {legacy, refused} = Sim.command(legacy, "root", :legacy_deny, ["never-materialize"])
    authenticate!(legacy, "root")
    assert false == Sim.quarantined(legacy, "root", accepted.id)
    assert {true, :legacy_application_denied} == Sim.quarantined(legacy, "root", refused.id)
    assert Sim.state(legacy, "root").events == ["legacy-accepted"]
  end

  test "capability, operation scope and holder refusals precede application context" do
    sim = founded("gates")
    {sim, missing} = Sim.command(sim, "root", :probe, [[]], cap: :none)
    assert {true, :no_capability} == Sim.quarantined(sim, "root", missing.id)

    {sim, scope} = Sim.grant(sim, "root", "peer", ops: [:baseline])
    sim = Sim.sync_all(sim)
    {sim, ungranted} = Sim.command(sim, "peer", :probe, [[]], cap: scope.id)
    assert {true, :operation_not_granted} == Sim.quarantined(sim, "peer", ungranted.id)

    {sim, holder_cap} = Sim.grant(sim, "root", "peer", ops: [:admin_probe], roles: [:admin])
    sim = Sim.sync_all(sim)
    {sim, not_holder} = Sim.command(sim, "peer", :admin_probe, [[]], cap: holder_cap.id)
    authenticate!(sim, "peer")
    assert {true, :not_holder} == Sim.quarantined(sim, "peer", not_holder.id)
  end

  test "finite lease honors signed zero then lapses before the application callback" do
    sim = founded("lease")
    {sim, grant} = Sim.grant(sim, "root", "peer", ops: [:baseline, :probe], expires_epoch: 0)
    {sim, _zero} = Sim.beacon(sim, "root", 0)
    sim = Sim.sync_all(sim)
    {sim, at_zero} = Sim.command(sim, "peer", :baseline, ["at-zero"], cap: grant.id)
    assert false == Sim.quarantined(sim, "peer", at_zero.id)
    sim = Sim.sync_all(sim)
    {sim, _one} = Sim.beacon(sim, "root", 1)
    sim = Sim.sync_all(sim)
    {sim, expired} = Sim.command(sim, "peer", :probe, [[]], cap: grant.id)
    authenticate!(sim, "peer")
    assert {true, :lease_expired} == Sim.quarantined(sim, "peer", expired.id)
    assert Sim.state(sim, "peer").events == ["at-zero"]
  end

  test "revocation stays stronger than lease expiry and missing application context" do
    sim = founded("revoke")
    {sim, grant} = Sim.grant(sim, "root", "peer", ops: [:probe], expires_epoch: 0)
    {sim, _revoke} = Sim.revoke(sim, "root", grant.id)
    {sim, _one} = Sim.beacon(sim, "root", 1)
    sim = Sim.sync_all(sim)
    {sim, command} = Sim.command(sim, "peer", :probe, [[]], cap: grant.id)
    authenticate!(sim, "peer")
    assert {true, :revoked_capability} == Sim.quarantined(sim, "peer", command.id)
  end

  defp founded(label, options \\ []) do
    module = Keyword.get(options, :module, ContextReplica)

    replica =
      case Keyword.get(options, :family, :legacy) do
        :legacy ->
          "replica:r19b-context:#{label}"

        family ->
          nonce = :crypto.hash(:sha256, label) |> Base.url_encode64(padding: false)
          name = if family == :bounded, do: "bounded-continuation-v1", else: "future-v1"
          "replica:treehouse:space:#{nonce}#authority:#{name}"
      end

    sim =
      Sim.new(module, replica, ["root", "peer"], seed: "r19b-context-#{label}")

    policies =
      if Keyword.get(options, :witnessed, false) do
        %{
          __beacon__: %{
            mode: :witnessed,
            version: 1,
            witnesses: ["root", "peer"],
            threshold: 2,
            max_epoch_step: 4
          }
        }
      else
        %{}
      end

    {sim, _genesis} = Sim.create_replica(sim, "root", policies: policies)
    Sim.sync_all(sim)
  end

  defp records(entries) do
    entries
    |> Enum.map(fn {op, epoch} -> %{op_id: op.id, epoch: epoch} end)
    |> Enum.sort_by(fn record -> :binary.bin_to_list(record.op_id) end)
  end

  defp assert_honored(sim, realm, command, expected) do
    authenticate!(sim, realm)
    assert false == Sim.quarantined(sim, realm, command.id)
    assert expected in Sim.state(sim, realm).events

    {analysis, evidence} =
      Authority.analyze_with_beacon_evidence(ContextReplica, Sim.log(sim, realm))

    assert analysis == Authority.analyze(ContextReplica, Sim.log(sim, realm))
    assert MapSet.subset?(MapSet.new(expected), MapSet.new(evidence))
    assert evidence == Enum.sort_by(evidence, & &1.op_id)
    assert Enum.uniq_by(evidence, & &1.op_id) == evidence
  end

  defp authenticate!(sim, realm) do
    log = Sim.log(sim, realm)
    assert :ok == Log.verify_authenticity(log)

    for op <- Log.topo_ops(log) do
      assert Op.valid?(op)
      encoded = op |> Wire.encode_op() |> Jason.encode!() |> Jason.decode!()
      assert {:ok, ^op} = Wire.decode_op(encoded)
    end
  end
end
