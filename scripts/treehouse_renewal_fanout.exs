# R02 measurement on existing Core authority. Run with MIX_ENV=test mix run.
# Synthetic identities only; the output contains aggregate counts, never keys.
# This is root-present workload measurement, not R04 founder-loss evidence.
alias Lattice.{Authority, Canonical, Log, Sim}
alias Lattice.Authority.Delegation
alias Lattice.Carrier.Wire
alias Township.Matter

members = Enum.map(1..12, &"member-#{&1}")

measure = fn ops ->
  Enum.reduce(
    ops,
    %{
      operations: 0,
      signatures: 0,
      signature_bytes: 0,
      canonical_preimage_bytes: 0,
      wire_json_bytes: 0
    },
    fn op, acc ->
      delegation =
        case op.body do
          {:grant, %Delegation{} = d} -> d
          {:genesis, %Delegation{} = d, _} -> d
          _ -> nil
        end

      extra_sig = if delegation, do: byte_size(delegation.sig), else: 0
      canonical = Canonical.op_bytes(op.replica, op.author, op.deps, op.kind, op.body, op.cap)
      # Canonical op preimages include embedded delegation terms. Sum excludes the
      # separate delegation signing preimage, so this is storage, not hash workload.
      wire_bytes = op |> Wire.encode_op() |> Jason.encode!() |> byte_size()

      %{
        operations: acc.operations + 1,
        signatures: acc.signatures + if(delegation, do: 2, else: 1),
        signature_bytes: acc.signature_bytes + byte_size(op.sig) + extra_sig,
        canonical_preimage_bytes: acc.canonical_preimage_bytes + byte_size(canonical),
        wire_json_bytes: acc.wire_json_bytes + wire_bytes
      }
    end
  )
end

rows =
  for replica_index <- 0..12 do
    {sim, _genesis} =
      Sim.new(Matter, "replica:r02:fanout:#{replica_index}", ["founder" | members],
        seed: "r02-fanout"
      )
      |> Sim.create_replica("founder")

    {sim, _} = Sim.beacon(sim, "founder", 0)

    {sim, cycles, all_grants} =
      Enum.reduce(0..2, {sim, [], []}, fn cycle, {acc, reports, old_grants} ->
        # Renewal at the start of the final two inclusive epochs: 0 -> 5 -> 10.
        # A rolling seven-epoch lease therefore needs renewal every five epochs.
        epoch = cycle * 5

        acc =
          if cycle == 0,
            do: acc,
            else:
              Enum.reduce((epoch - 4)..epoch, acc, fn e, s ->
                elem(Sim.beacon(s, "founder", e), 0)
              end)

        before = Sim.log(acc, "founder")

        for old <- Enum.take(old_grants, 12) do
          false = Authority.expired?(before, old.id)
        end

        {acc, grants} =
          Enum.reduce(members, {acc, []}, fn member, {s, ds} ->
            {s, grant} = Sim.grant(s, "founder", member, ops: [:post], expires_epoch: epoch + 6)
            {s, [grant | ds]}
          end)

        acc = Sim.sync_all(acc)
        after_log = Sim.log(acc, "founder")

        for grant <- grants do
          false = Authority.expired?(after_log, grant.id)
          true = Authority.delegation_active?(after_log, grant.id)
        end

        grant_ops =
          after_log |> Log.topo_ops() |> Enum.reject(&Map.has_key?(Log.ops(before), &1.id))

        report =
          Map.merge(measure.(grant_ops), %{
            cycle: cycle,
            issue_epoch: epoch,
            inclusive_expiry: epoch + 6
          })

        {acc, reports ++ [report], grants ++ old_grants}
      end)

    sim = Enum.reduce(11..14, sim, fn e, s -> elem(Sim.beacon(s, "founder", e), 0) end)
    ops = sim |> Sim.log("founder") |> Log.topo_ops()
    # Round-trip every measured frame into a fresh integrity-checking log, then
    # independently analyze that log rather than trusting the Sim caps cache.
    restored =
      Enum.reduce(ops, Log.new(sim.replica), fn op, log ->
        {:ok, decoded} = op |> Wire.encode_op() |> Wire.decode_op()
        Log.append!(log, decoded)
      end)

    0 = MapSet.size(Authority.analyze(Matter, restored).quarantine)

    for grant <- all_grants do
      expected_lapsed = grant.expires_epoch < 14
      ^expected_lapsed = Authority.expired?(restored, grant.id)
    end

    Map.merge(measure.(ops), %{replica_index: replica_index, cycles: cycles})
  end

sum = fn items ->
  Enum.reduce(
    items,
    %{
      operations: 0,
      signatures: 0,
      signature_bytes: 0,
      canonical_preimage_bytes: 0,
      wire_json_bytes: 0
    },
    fn row, acc ->
      Map.new(acc, fn {key, value} -> {key, value + Map.fetch!(row, key)} end)
    end
  )
end

renewals = for row <- rows, cycle <- row.cycles, cycle.cycle > 0, do: cycle
624 = sum.(renewals).signatures
312 = sum.(renewals).operations

result = %{
  evidence_kind: "current_core_root_present_synthetic_measurement",
  source_base: "7610cc9b",
  schema: "Township.Matter",
  grant_ops_scope: ["post"],
  adopted_profile: false,
  founder_removed: false,
  runtimes_executed: ["BEAM"],
  native_presence_prompts_executed: 0,
  members: 12,
  replicas: 13,
  renewal_cycles: 2,
  epoch_unit_for_this_probe:
    "explicit signed integer; fourteen increments, renewal at epochs five and ten",
  lease_window_inclusive_epochs: 7,
  warning_inclusive_epochs: 2,
  renewal_interval_epochs: 5,
  initial_and_two_cycles: sum.(rows),
  renewals_only: sum.(renewals),
  per_replica: rows,
  unmeasured: [
    "Treehouse command scopes",
    "R04 continuation acquisitions",
    "R03 witnessed beacon certificates",
    "native prompts and user time",
    "transport admission",
    "catalogs",
    "roles",
    "user content",
    "carrier envelope overhead"
  ],
  candidate_budget_not_implemented: %{
    grant_signature_calls_two_cycles: 624,
    one_prompt_per_member_renewal_intent: 312,
    exact_replica_batches_of_twelve_prompts_two_cycles: 26,
    daily_witnessed_beacon_operations_after_initial_epoch_over_fourteen_days: 182,
    threshold_two_witness_signatures_for_those_beacons: 364,
    beacon_author_op_signatures_for_those_beacons: 182,
    one_prompt_per_witness_claim: 364,
    additional_beacon_author_prompts_if_not_same_review: 182
  }
}

IO.puts(Jason.encode!(result, pretty: true))
