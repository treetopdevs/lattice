defmodule Mix.Tasks.Lattice.ExportVectors do
  @moduledoc """
  Export TypeScript client conformance vectors from `Lattice.Sim`.

  The exported JSON is Tier A only: op ids are opaque handles, and the TS
  reducer must reproduce Sim's state, quarantine set, and deterministic order.
  Tier B canonical bytes stay absent until the CBOR/ADR-P08 work lands.
  """

  use Mix.Task

  alias Lattice.Authority
  alias Lattice.Authority.{Delegation, SuccessionCertificate}
  alias Lattice.Canonical
  alias Lattice.Carrier.Wire, as: CarrierWire
  alias Lattice.{Identity, Log, Op, Sim, Sync}
  alias Township.Matter

  @shortdoc "Export Lattice.Sim conformance vectors for the TS client"
  @zoning_replica "replica:matter:zoning-variance-24"
  @join_replica "replica:matter:join-w0"
  @succession_replica "replica:matter:succession-w3"
  @unproven_succession_replica "replica:matter:succession-unproven-tick"
  @witnessed_succession_replica "replica:matter:succession-witnessed-recovery"
  @genesis_projection_replica "replica:matter:genesis-projection-parity"
  @witnessed_recovery_realms [
    "clerk",
    "resident",
    "witness_a",
    "witness_b",
    "witness_c",
    "mallory",
    "mallory_witness_a",
    "mallory_witness_b"
  ]
  @genesis_projection_realms [
    "clerk",
    "resident",
    "witness_a",
    "witness_b",
    "witness_c",
    "mallory"
  ]
  @random_realms ["clerk", "resident", "neighbor"]
  @randomized_seeds [101, 202, 303, 404, 505]
  @carrier_replica "replica:matter:township-g1"
  @carrier_seed "township-g1"
  @carrier_realms ["clerk", "resident"]

  @impl Mix.Task
  def run(argv) do
    {opts, _, _} = OptionParser.parse(argv, strict: [out: :string])
    out = opts[:out] || "clients/lattice-client/test/vectors"
    File.mkdir_p!(out)

    for scenario <- scenarios() do
      path = Path.join(out, "#{scenario.name}.json")
      File.write!(path, Jason.encode!(to_vector(scenario), pretty: true))
      Mix.shell().info("wrote #{path}")
    end

    :ok
  end

  defp scenarios do
    fixed = [
      township_join_w0(),
      township_zoning_variance_24(),
      township_succession_w3(),
      township_succession_unproven_tick(),
      township_succession_witnessed_recovery(),
      township_genesis_projection_parity(),
      township_authority_forged_root(),
      township_authority_embedded_replica_bypass(),
      township_authority_forged_delegation_id(),
      township_authority_forged_delegation_sig(),
      township_authority_delegation_id_collision(),
      township_authority_forged_transfer(),
      township_authority_double_transfer(),
      township_authority_unattenuated_transfer(),
      township_capability_missing(),
      township_capability_invalid(),
      township_capability_wrong_audience(),
      township_capability_operation_not_granted(),
      township_capability_not_visible(),
      township_capability_role_not_granted(),
      township_capability_revoked_causal(),
      township_capability_revoked_chain(),
      township_revoke_unauthorized(),
      township_causal_list_partition(),
      township_partial_log_lww(),
      township_carrier_w1()
    ]

    fixed ++ Enum.map(@randomized_seeds, &township_random/1)
  end

  defp township_zoning_variance_24 do
    sim = Sim.new(Matter, @zoning_replica, ["clerk", "resident"], seed: "township")

    {sim, _genesis} =
      Sim.create_replica(sim, "clerk",
        policies: %{clerk: %{successor: "resident", dormant_ticks: 3}}
      )

    {sim, _grant} =
      Sim.grant(sim, "clerk", "resident", ops: [:admit, :post, :set_summary, :set_title])

    sim = Sim.sync_all(sim)
    {sim, _} = Sim.command(sim, "clerk", :admit, ["clerk"])
    {sim, _} = Sim.command(sim, "clerk", :admit, ["resident"])
    {sim, _} = Sim.command(sim, "clerk", :set_title, ["Zoning Variance #24"])
    {sim, _} = Sim.command(sim, "clerk", :post, ["clerk: hearing Tue 6pm"])
    {sim, _} = Sim.command(sim, "resident", :post, ["resident: I will attend"])

    sim = Sim.partition(sim, "clerk", "resident")
    {clerk_branch, _} = Sim.command(sim, "clerk", :set_summary, ["Leaning approve"])
    {resident_branch, _} = Sim.command(sim, "resident", :set_summary, ["Needs traffic study"])

    {resident_branch, _} =
      Sim.command(resident_branch, "resident", :post, ["resident: posted while offline"])

    healed = resident_branch |> Sim.heal("clerk", "resident") |> Sim.sync_all()
    {healed, _close} = Sim.command(healed, "clerk", :close_matter, [])

    {healed, _transfer} =
      Sim.transfer(healed, "clerk", "resident", :clerk,
        at_tick: 1,
        ops: [:close_matter, :reopen_matter]
      )

    {stale_branch, _stale} = Sim.command(clerk_branch, "clerk", :reopen_matter, [])

    {merged, _left_report, _right_report} =
      Sync.reconcile(Sim.log(healed, "clerk"), Sim.log(stale_branch, "clerk"))

    realms = realm_index(healed)

    %{
      name: "township_zoning_variance_24",
      log: merged,
      realms: realms,
      perspectives: [
        %{name: "clerk_mid_partition", log: Sim.log(clerk_branch, "clerk")},
        %{name: "resident_mid_partition", log: Sim.log(resident_branch, "resident")}
      ],
      replica: Sim.replica(healed),
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleCarrierOps: carrier_ops(merged),
      authorityQuarantine: authority_quarantine(merged)
    }
  end

  defp township_join_w0 do
    sim = Sim.new(Matter, @join_replica, ["clerk", "resident"], seed: "township:w0")

    {sim, _genesis} =
      Sim.create_replica(sim, "clerk",
        policies: %{clerk: %{successor: "resident", dormant_ticks: 3}}
      )

    {sim, _grant} = Sim.grant(sim, "clerk", "resident", ops: [:admit, :post, :set_summary])
    sim = Sim.sync_all(sim)
    {sim, _} = Sim.command(sim, "clerk", :admit, ["clerk"])
    {sim, _} = Sim.command(sim, "clerk", :admit, ["resident"])
    sim = Sim.sync_all(sim)

    %{
      name: "township_join_w0",
      log: Sim.log(sim, "resident"),
      realms: realm_index(sim),
      perspectives: []
    }
  end

  defp township_succession_w3 do
    sim = Sim.new(Matter, @succession_replica, ["clerk", "resident"], seed: "township:w3")

    {sim, _genesis} =
      Sim.create_replica(sim, "clerk",
        policies: %{clerk: %{successor: "resident", dormant_ticks: 3}}
      )

    {sim, _grant} = Sim.grant(sim, "clerk", "resident", ops: [:post])
    sim = Sim.sync_all(sim)
    {sim, _} = Sim.command(sim, "clerk", :post, ["a durable civic record"])
    {sim, _heartbeat} = Sim.heartbeat(sim, "clerk", :clerk, 1)
    sim = Sim.sync_all(sim)

    {stale_branch, _stale_close} = Sim.command(sim, "clerk", :close_matter, [])

    {sim, _succession} =
      Sim.succeed(sim, "resident", :clerk,
        at_tick: 4,
        ops: [:close_matter, :reopen_matter]
      )

    sim = Sim.sync_all(sim)
    {sim, _resident_close} = Sim.command(sim, "resident", :close_matter, [])
    sim = Sim.sync_all(sim)

    {merged, _left_report, _right_report} =
      Sync.reconcile(Sim.log(sim, "clerk"), Sim.log(stale_branch, "clerk"))

    realms = realm_index(sim)

    %{
      name: "township_succession_w3",
      log: merged,
      realms: realms,
      perspectives: [],
      replica: Sim.replica(sim),
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleCarrierOps: carrier_ops(merged),
      authorityQuarantine: authority_quarantine(merged)
    }
  end

  defp township_succession_unproven_tick do
    sim =
      Sim.new(Matter, @unproven_succession_replica, ["clerk", "resident"],
        seed: "township:succession-unproven-tick"
      )

    {sim, _genesis} =
      Sim.create_replica(sim, "clerk",
        policies: %{clerk: %{successor: "resident", dormant_ticks: 3}}
      )

    sim = Sim.sync_all(sim)

    {sim, succession} =
      Sim.succeed(sim, "resident", :clerk,
        at_tick: 1_000_000,
        ops: [:close_matter, :reopen_matter]
      )

    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "resident")
    realms = realm_index(sim)

    %{
      name: "township_succession_unproven_tick",
      kind: "adversarial",
      log: log,
      realms: realms,
      perspectives: [],
      replica: Sim.replica(sim),
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleCarrierOps: carrier_ops(log),
      authorityQuarantine: authority_quarantine(log),
      successionOperationId: succession.id,
      tickProvenance: "author_asserted_untrusted"
    }
  end

  defp township_succession_witnessed_recovery do
    sim =
      Sim.new(Matter, @witnessed_succession_replica, @witnessed_recovery_realms,
        seed: "township:succession-witnessed-recovery"
      )

    {sim, genesis} =
      Sim.create_replica(sim, "clerk",
        policies: %{
          clerk: %{
            successor: "resident",
            recovery: %{
              mode: :witnessed,
              version: 1,
              witnesses: ["witness_a", "witness_b", "witness_c"],
              threshold: 2
            }
          }
        }
      )

    clerk = Sim.identity(sim, "clerk")
    mallory = Sim.identity(sim, "mallory")
    mallory_witness_a = Sim.identity(sim, "mallory_witness_a")
    mallory_witness_b = Sim.identity(sim, "mallory_witness_b")

    impostor_recovery = %{
      mode: :witnessed,
      version: 1,
      witnesses: [mallory_witness_a.pub, mallory_witness_b.pub],
      threshold: 2
    }

    impostor_delegation =
      Delegation.genesis(mallory, Sim.replica(sim),
        ops: [:close_matter, :reopen_matter],
        roles: [:clerk],
        live: true
      )

    {sim, impostor_genesis} =
      Sim.append(
        sim,
        "mallory",
        :authority,
        {:genesis, impostor_delegation,
         %{clerk: %{successor: mallory.pub, recovery: impostor_recovery}}}
      )

    {:ok, impostor_claim} =
      SuccessionCertificate.claim(
        Sim.replica(sim),
        :clerk,
        clerk.pub,
        genesis.id,
        mallory.pub,
        impostor_recovery
      )

    impostor_certificate =
      SuccessionCertificate.new(impostor_claim, [mallory_witness_a, mallory_witness_b])

    {sim, impostor_succession} =
      Sim.succeed(sim, "mallory", :clerk, certificate: impostor_certificate)

    sim = Sim.sync_all(sim)
    {sim, denied} = Sim.succeed(sim, "resident", :clerk, witnesses: ["witness_a"])

    {sim, honored} =
      Sim.succeed(sim, "resident", :clerk, witnesses: ["witness_a", "witness_b"])

    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "resident")
    realms = realm_index(sim)
    analysis = Authority.analyze(Matter, log)
    %{recovery: recovery} = Map.fetch!(analysis.policies, :clerk)
    {:ok, normalized_policy} = SuccessionCertificate.normalize_policy(recovery)

    {:succeed, :clerk, _delegation, {:witnessed, %{claim: claim}}} = honored.body

    %{
      name: "township_succession_witnessed_recovery",
      kind: "adversarial",
      log: log,
      realms: realms,
      perspectives: [],
      replica: Sim.replica(sim),
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleCarrierOps: carrier_ops(log),
      authorityQuarantine: authority_quarantine(log),
      witnessedRecovery: %{
        "deniedOperationId" => denied.id,
        "honoredOperationId" => honored.id,
        "impostorPolicyGenesisOperationId" => impostor_genesis.id,
        "impostorPolicySuccessionOperationId" => impostor_succession.id,
        "policyId" => claim.policy_id,
        "claim" => witnessed_claim_json(claim),
        "policy" => witnessed_policy_json(normalized_policy)
      }
    }
  end

  defp township_genesis_projection_parity do
    sim =
      Sim.new(Matter, @genesis_projection_replica, @genesis_projection_realms,
        seed: "township:genesis-projection-parity"
      )

    {sim, first_genesis} =
      Sim.create_replica(sim, "clerk",
        policies: %{
          clerk: %{
            successor: "resident",
            recovery: %{
              mode: :witnessed,
              version: 1,
              witnesses: ["witness_a", "witness_b"],
              threshold: 2
            }
          }
        }
      )

    first_log = Sim.log(sim, "clerk")
    first_analysis = Authority.analyze(Matter, first_log)
    clerk = Sim.identity(sim, "clerk")
    resident = Sim.identity(sim, "resident")
    witness_b = Sim.identity(sim, "witness_b")
    witness_c = Sim.identity(sim, "witness_c")

    second_recovery = %{
      mode: :witnessed,
      version: 1,
      witnesses: [witness_b.pub, witness_c.pub],
      threshold: 2
    }

    second_policy = %{successor: resident.pub, recovery: second_recovery}

    second_delegation =
      Delegation.genesis(clerk, Sim.replica(sim),
        ops: [:close_matter],
        roles: [:clerk],
        live: true
      )

    {sim, second_genesis} =
      Sim.append(
        sim,
        "clerk",
        :authority,
        {:genesis, second_delegation, %{clerk: second_policy}}
      )

    sim = Sim.sync_all(sim)
    mallory = Sim.identity(sim, "mallory")

    impostor_delegation =
      Delegation.genesis(mallory, Sim.replica(sim),
        ops: [:close_matter, :reopen_matter],
        roles: [:clerk],
        live: true
      )

    impostor_policy = %{
      successor: mallory.pub,
      recovery: %{
        mode: :witnessed,
        version: 1,
        witnesses: [mallory.pub],
        threshold: 1
      }
    }

    {sim, impostor_genesis} =
      Sim.append(
        sim,
        "mallory",
        :authority,
        {:genesis, impostor_delegation, %{clerk: impostor_policy}}
      )

    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "resident")
    realms = realm_index(sim)
    analysis = Authority.analyze(Matter, log)

    first_epoch = Map.fetch!(first_analysis.holder_epochs, :clerk)
    current_epoch = Map.fetch!(analysis.holder_epochs, :clerk)
    effective_policy = Map.fetch!(analysis.policies, :clerk)

    unless first_epoch == %{holder: clerk.pub, op_id: first_genesis.id} and
             current_epoch == %{holder: clerk.pub, op_id: second_genesis.id} and
             first_analysis.policies.clerk != effective_policy and
             effective_policy == second_policy and
             first_genesis.id in second_genesis.deps and
             second_genesis.id in impostor_genesis.deps and
             first_genesis.body != second_genesis.body and
             second_delegation.id != elem(first_genesis.body, 1).id and
             not Map.has_key?(analysis.reasons, first_genesis.id) and
             not Map.has_key?(analysis.reasons, second_genesis.id) and
             Map.get(analysis.reasons, impostor_genesis.id) == :impostor_genesis and
             Authority.root(log) == clerk.pub do
      raise "valid-genesis projection probe diverged from the expected BEAM oracle"
    end

    {:ok, normalized_policy} = SuccessionCertificate.normalize_policy(second_recovery)
    {:ok, policy_id} = SuccessionCertificate.policy_id(normalized_policy)

    %{
      name: "township_genesis_projection_parity",
      kind: "adversarial",
      log: log,
      realms: realms,
      perspectives: [],
      replica: Sim.replica(sim),
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleCarrierOps: carrier_ops(log),
      authorityQuarantine: authority_quarantine(log),
      genesisProjection: %{
        "role" => "clerk",
        "acquisitionOperationIds" => [first_epoch.op_id, current_epoch.op_id],
        "holderPubkey" => Base.encode64(current_epoch.holder),
        "holderEpochOperationId" => current_epoch.op_id,
        "effectivePolicy" =>
          normalized_policy
          |> witnessed_policy_json()
          |> Map.put("successorPubkey", Base.encode64(effective_policy.successor)),
        "winningPolicyGenesisOperationId" => second_genesis.id,
        "policyId" => policy_id,
        "impostorGenesisOperationId" => impostor_genesis.id
      }
    }
  end

  defp township_authority_forged_root do
    sim =
      Sim.new(
        Matter,
        "replica:matter:authority-forged-root",
        ["clerk", "mallory"],
        seed: "township:authority-forged-root"
      )

    clerk = Sim.identity(sim, "clerk")
    mallory = Sim.identity(sim, "mallory")
    replica = Authority.bind_replica(Sim.replica(sim), clerk.pub)

    impostor_delegation =
      Delegation.genesis(mallory, replica,
        ops: [:close_matter, :reopen_matter],
        roles: [:clerk],
        live: true
      )

    impostor_genesis =
      Op.new(
        mallory,
        replica,
        [],
        :authority,
        {:genesis, impostor_delegation, %{}}
      )

    log = Log.append!(Log.new(replica), impostor_genesis)
    authority_quarantine = authority_quarantine(log)

    unless [impostor_genesis.id, "impostor_genesis"] in authority_quarantine do
      raise "expected impostor genesis #{impostor_genesis.id} to quarantine"
    end

    unless is_nil(Authority.holder(Matter, log, :clerk)) do
      raise "expected impostor genesis to leave clerk unassigned"
    end

    realms = realm_index(sim)

    %{
      name: "township_authority_forged_root",
      kind: "adversarial",
      log: log,
      realms: realms,
      perspectives: [],
      replica: replica,
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleCarrierOps: carrier_ops(log),
      authorityQuarantine: authority_quarantine
    }
  end

  defp township_authority_embedded_replica_bypass do
    sim =
      Sim.new(
        Matter,
        "replica:matter:authority-embedded-replica-bypass",
        ["clerk", "mallory"],
        seed: "township:authority-embedded-replica-bypass"
      )

    clerk = Sim.identity(sim, "clerk")
    mallory = Sim.identity(sim, "mallory")
    replica = Authority.bind_replica(Sim.replica(sim), clerk.pub)

    embedded_replica =
      Authority.bind_replica("replica:matter:mallory-root-claim", mallory.pub)

    impostor_delegation =
      Delegation.genesis(mallory, embedded_replica,
        ops: [:close_matter, :reopen_matter],
        roles: [:clerk],
        live: true
      )

    impostor_genesis =
      Op.new(
        mallory,
        replica,
        [],
        :authority,
        {:genesis, impostor_delegation, %{}}
      )

    unless Op.valid?(impostor_genesis) and Delegation.valid_sig?(impostor_delegation) do
      raise "expected embedded-replica bypass evidence to be cryptographically valid"
    end

    log = Log.append!(Log.new(replica), impostor_genesis)
    authority_quarantine = authority_quarantine(log)

    unless [impostor_genesis.id, "impostor_genesis"] in authority_quarantine do
      raise "expected embedded-replica bypass #{impostor_genesis.id} to quarantine"
    end

    unless is_nil(Authority.holder(Matter, log, :clerk)) do
      raise "expected embedded-replica bypass to leave clerk unassigned"
    end

    realms = realm_index(sim)

    %{
      name: "township_authority_embedded_replica_bypass",
      kind: "adversarial",
      log: log,
      realms: realms,
      perspectives: [],
      replica: replica,
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleCarrierOps: carrier_ops(log),
      authorityQuarantine: authority_quarantine
    }
  end

  defp township_authority_forged_delegation_id do
    sim =
      Sim.new(
        Matter,
        "replica:matter:authority-forged-delegation-id",
        ["clerk"],
        seed: "township:authority-forged-delegation-id"
      )

    clerk = Sim.identity(sim, "clerk")
    replica = Authority.bind_replica(Sim.replica(sim), clerk.pub)

    pristine_delegation =
      Delegation.genesis(clerk, replica,
        ops: [:close_matter, :reopen_matter],
        roles: [:clerk],
        live: true
      )

    pristine_genesis =
      Op.new(
        clerk,
        replica,
        [],
        :authority,
        {:genesis, pristine_delegation, %{}}
      )

    pristine_log = Log.append!(Log.new(replica), pristine_genesis)

    unless Authority.holder(Matter, pristine_log, :clerk) == clerk.pub and
             authority_quarantine(pristine_log) == [] do
      raise "expected pristine delegation genesis to establish clerk authority"
    end

    forged_id = String.duplicate("A", 43)
    forged_delegation = %{pristine_delegation | id: forged_id}
    pristine_bytes = Canonical.delegation_payload(pristine_delegation)
    forged_bytes = Canonical.delegation_payload(forged_delegation)

    unless forged_id != pristine_delegation.id and
             String.match?(forged_id, ~r/\A[A-Za-z0-9_-]{43}\z/) and
             pristine_bytes == forged_bytes and
             Identity.verify(forged_delegation.issuer, forged_bytes, forged_delegation.sig) and
             not Delegation.valid_sig?(forged_delegation) do
      raise "expected forged delegation to differ only by its plausible declared id"
    end

    forged_genesis =
      Op.new(
        clerk,
        replica,
        [],
        :authority,
        {:genesis, forged_delegation, %{}}
      )

    unless Op.valid?(forged_genesis) do
      raise "expected forged-delegation-id outer op to be cryptographically valid"
    end

    log = Log.append!(Log.new(replica), forged_genesis)
    authority_quarantine = authority_quarantine(log)

    unless [forged_genesis.id, "bad_delegation_sig"] in authority_quarantine do
      raise "expected forged delegation id #{forged_genesis.id} to quarantine"
    end

    unless is_nil(Authority.holder(Matter, log, :clerk)) do
      raise "expected forged delegation id to leave clerk unassigned"
    end

    realms = realm_index(sim)

    %{
      name: "township_authority_forged_delegation_id",
      kind: "adversarial",
      log: log,
      realms: realms,
      perspectives: [],
      replica: replica,
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleCarrierOps: carrier_ops(log),
      authorityQuarantine: authority_quarantine
    }
  end

  defp township_authority_forged_delegation_sig do
    sim =
      Sim.new(
        Matter,
        "replica:matter:authority-forged-delegation-sig",
        ["clerk"],
        seed: "township:authority-forged-delegation-sig"
      )

    clerk = Sim.identity(sim, "clerk")
    replica = Authority.bind_replica(Sim.replica(sim), clerk.pub)

    pristine_delegation =
      Delegation.genesis(clerk, replica,
        ops: [:close_matter, :reopen_matter],
        roles: [:clerk],
        live: true
      )

    pristine_genesis =
      Op.new(
        clerk,
        replica,
        [],
        :authority,
        {:genesis, pristine_delegation, %{}}
      )

    pristine_log = Log.append!(Log.new(replica), pristine_genesis)

    unless Authority.holder(Matter, pristine_log, :clerk) == clerk.pub and
             authority_quarantine(pristine_log) == [] do
      raise "expected pristine delegation genesis to establish clerk authority"
    end

    <<first_sig_byte, rest_sig::binary>> = pristine_delegation.sig

    forged_delegation = %{
      pristine_delegation
      | sig: <<Bitwise.bxor(first_sig_byte, 1), rest_sig::binary>>
    }

    pristine_bytes = Canonical.delegation_payload(pristine_delegation)
    forged_bytes = Canonical.delegation_payload(forged_delegation)

    unless byte_size(pristine_delegation.sig) == 64 and
             byte_size(forged_delegation.sig) == 64 and
             forged_delegation.id == pristine_delegation.id and
             forged_delegation.sig != pristine_delegation.sig and
             pristine_bytes == forged_bytes and
             Identity.verify(pristine_delegation.issuer, pristine_bytes, pristine_delegation.sig) and
             not Identity.verify(
               forged_delegation.issuer,
               forged_bytes,
               forged_delegation.sig
             ) and
             not Delegation.valid_sig?(forged_delegation) do
      raise "expected forged delegation to differ only by one signature bit"
    end

    forged_genesis =
      Op.new(
        clerk,
        replica,
        [],
        :authority,
        {:genesis, forged_delegation, %{}}
      )

    unless Op.valid?(forged_genesis) do
      raise "expected forged-delegation-signature outer op to be cryptographically valid"
    end

    log = Log.append!(Log.new(replica), forged_genesis)
    authority_quarantine = authority_quarantine(log)

    unless [forged_genesis.id, "bad_delegation_sig"] in authority_quarantine do
      raise "expected forged delegation signature #{forged_genesis.id} to quarantine"
    end

    unless is_nil(Authority.holder(Matter, log, :clerk)) do
      raise "expected forged delegation signature to leave clerk unassigned"
    end

    realms = realm_index(sim)

    %{
      name: "township_authority_forged_delegation_sig",
      kind: "adversarial",
      log: log,
      realms: realms,
      perspectives: [],
      replica: replica,
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleCarrierOps: carrier_ops(log),
      authorityQuarantine: authority_quarantine
    }
  end

  defp township_authority_delegation_id_collision do
    sim =
      Sim.new(
        Matter,
        "replica:matter:authority-delegation-id-collision",
        ["clerk"],
        seed: "township:authority-delegation-id-collision"
      )

    clerk = Sim.identity(sim, "clerk")
    replica = Authority.bind_replica(Sim.replica(sim), clerk.pub)

    pristine_delegation =
      Delegation.genesis(clerk, replica,
        ops: [:close_matter, :reopen_matter],
        roles: [:clerk],
        live: true
      )

    pristine_genesis =
      Op.new(
        clerk,
        replica,
        [],
        :authority,
        {:genesis, pristine_delegation, %{}}
      )

    pristine_log = Log.append!(Log.new(replica), pristine_genesis)

    unless Authority.holder(Matter, pristine_log, :clerk) == clerk.pub and
             authority_quarantine(pristine_log) == [] do
      raise "expected pristine collision control to establish clerk authority"
    end

    <<first_sig_byte, rest_sig::binary>> = pristine_delegation.sig

    forged_delegation = %{
      pristine_delegation
      | sig: <<Bitwise.bxor(first_sig_byte, 1), rest_sig::binary>>
    }

    pristine_bytes = Canonical.delegation_payload(pristine_delegation)
    forged_bytes = Canonical.delegation_payload(forged_delegation)

    unless byte_size(pristine_delegation.sig) == 64 and
             byte_size(forged_delegation.sig) == 64 and
             forged_delegation.id == pristine_delegation.id and
             forged_delegation.sig != pristine_delegation.sig and
             pristine_bytes == forged_bytes and
             Identity.verify(pristine_delegation.issuer, pristine_bytes, pristine_delegation.sig) and
             not Identity.verify(
               forged_delegation.issuer,
               forged_bytes,
               forged_delegation.sig
             ) and
             not Delegation.valid_sig?(forged_delegation) do
      raise "expected collision forgery to differ only by one signature bit"
    end

    forged_genesis =
      Op.new(
        clerk,
        replica,
        [],
        :authority,
        {:genesis, forged_delegation, %{}}
      )

    unless Op.valid?(pristine_genesis) and Op.valid?(forged_genesis) and
             forged_genesis.id < pristine_genesis.id do
      raise "expected valid outer ops with forged introduction first in canonical order"
    end

    log =
      replica
      |> Log.new()
      |> Log.append!(forged_genesis)
      |> Log.append!(pristine_genesis)

    authority_quarantine = authority_quarantine(log)

    unless authority_quarantine == [[forged_genesis.id, "bad_delegation_sig"]] do
      raise "expected only the forged same-id introduction to quarantine"
    end

    unless Authority.holder(Matter, log, :clerk) == clerk.pub do
      raise "expected forged same-id introduction not to poison pristine authority"
    end

    realms = realm_index(sim)

    %{
      name: "township_authority_delegation_id_collision",
      kind: "adversarial",
      log: log,
      realms: realms,
      perspectives: [],
      replica: replica,
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleCarrierOps: carrier_ops(log),
      authorityQuarantine: authority_quarantine
    }
  end

  defp township_authority_forged_transfer do
    sim =
      Sim.new(
        Matter,
        "replica:matter:authority-forged-transfer",
        ["clerk", "mallory"],
        seed: "township:authority-forged-transfer"
      )

    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    sim = Sim.sync_all(sim)
    sim = Sim.partition(sim, "clerk", "mallory")

    clerk = Sim.identity(sim, "clerk")
    mallory = Sim.identity(sim, "mallory")
    replica = Sim.replica(sim)

    forged_delegation =
      Delegation.genesis(mallory, replica,
        ops: [:close_matter, :reopen_matter],
        roles: [:clerk],
        live: true
      )

    unless Delegation.valid_sig?(forged_delegation) do
      raise "expected the non-holder's self-issued delegation to stay structurally valid"
    end

    {sim, forged_transfer} =
      Sim.append(sim, "mallory", :authority, {:transfer, :clerk, forged_delegation, 0})

    {sim, mallory_command} =
      Sim.command(sim, "mallory", :close_matter, [], cap: forged_delegation.id)

    {sim, clerk_command} = Sim.command(sim, "clerk", :close_matter, [])

    sim = sim |> Sim.heal("clerk", "mallory") |> Sim.sync_all()
    log = Sim.log(sim, "clerk")

    unless MapSet.member?(Log.op_ids(log), clerk_command.id) do
      raise "expected the legitimate clerk command to reach the merged log"
    end

    authority_quarantine = authority_quarantine(log)

    expected_quarantine =
      Enum.sort([
        [forged_transfer.id, "transfer_not_holder"],
        [mallory_command.id, "not_holder"]
      ])

    unless authority_quarantine == expected_quarantine do
      raise "expected only the forged transfer and its follow-up command to quarantine"
    end

    unless Authority.holder(Matter, log, :clerk) == clerk.pub do
      raise "expected the forged non-holder transfer not to move clerk authority"
    end

    unless Lattice.state(Matter, log).clerk_locked? == true do
      raise "expected the legitimate concurrent clerk command to stay honored"
    end

    realms = realm_index(sim)

    %{
      name: "township_authority_forged_transfer",
      kind: "adversarial",
      log: log,
      realms: realms,
      perspectives: [],
      replica: replica,
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleCarrierOps: carrier_ops(log),
      authorityQuarantine: authority_quarantine
    }
  end

  defp township_authority_double_transfer do
    sim =
      Sim.new(
        Matter,
        "replica:matter:authority-double-transfer",
        ["clerk", "resident", "mallory"],
        seed: "township:authority-double-transfer:v2:0"
      )

    {sim, genesis} = Sim.create_replica(sim, "clerk")
    {:genesis, genesis_delegation, _policies} = genesis.body

    clerk = Sim.identity(sim, "clerk")
    resident = Sim.identity(sim, "resident")
    mallory = Sim.identity(sim, "mallory")
    replica = Sim.replica(sim)

    to_resident =
      Delegation.new(clerk, replica, resident.pub,
        ops: [:close_matter, :reopen_matter],
        roles: [:clerk],
        parent_id: genesis_delegation.id
      )

    to_mallory =
      Delegation.new(clerk, replica, mallory.pub,
        ops: [:close_matter, :reopen_matter],
        roles: [:clerk],
        parent_id: genesis_delegation.id
      )

    unless Delegation.attenuates?(to_resident, genesis_delegation) and
             Delegation.attenuates?(to_mallory, genesis_delegation) do
      raise "expected both equivocating transfers to carry sound delegations"
    end

    first_transfer =
      Op.new(clerk, replica, [genesis.id], :authority, {:transfer, :clerk, to_resident, 0})

    second_transfer =
      Op.new(clerk, replica, [genesis.id], :authority, {:transfer, :clerk, to_mallory, 0})

    unless first_transfer.id < second_transfer.id do
      raise "expected the resident transfer to sort first so the mallory branch equivocates"
    end

    log =
      replica
      |> Log.new()
      |> Log.append!(genesis)
      |> Log.append!(first_transfer)
      |> Log.append!(second_transfer)

    authority_quarantine = authority_quarantine(log)

    unless authority_quarantine == [[second_transfer.id, "double_transfer"]] do
      raise "expected only the equivocating second transfer to quarantine"
    end

    unless Authority.holder(Matter, log, :clerk) == resident.pub do
      raise "expected the first transfer in canonical order to move clerk authority"
    end

    realms = realm_index(sim)

    %{
      name: "township_authority_double_transfer",
      kind: "adversarial",
      log: log,
      realms: realms,
      perspectives: [],
      replica: replica,
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleCarrierOps: carrier_ops(log),
      authorityQuarantine: authority_quarantine
    }
  end

  defp township_authority_unattenuated_transfer do
    sim =
      Sim.new(
        Matter,
        "replica:matter:authority-unattenuated-transfer",
        ["clerk", "resident"],
        seed: "township:authority-unattenuated-transfer"
      )

    {sim, genesis} = Sim.create_replica(sim, "clerk")
    {:genesis, genesis_delegation, _policies} = genesis.body

    clerk = Sim.identity(sim, "clerk")
    resident = Sim.identity(sim, "resident")
    replica = Sim.replica(sim)

    overbroad =
      Delegation.new(clerk, replica, resident.pub,
        ops: [:close_matter, :seize_records],
        roles: [:clerk],
        parent_id: genesis_delegation.id
      )

    unless Delegation.valid_sig?(overbroad) and
             not Delegation.attenuates?(overbroad, genesis_delegation) do
      raise "expected a validly signed delegation that exceeds its parent capability"
    end

    transfer =
      Op.new(clerk, replica, [genesis.id], :authority, {:transfer, :clerk, overbroad, 0})

    log =
      replica
      |> Log.new()
      |> Log.append!(genesis)
      |> Log.append!(transfer)

    authority_quarantine = authority_quarantine(log)

    unless authority_quarantine == [[transfer.id, "invalid_transfer"]] do
      raise "expected the unattenuated transfer to quarantine as invalid"
    end

    unless Authority.holder(Matter, log, :clerk) == clerk.pub do
      raise "expected the unattenuated transfer not to move clerk authority"
    end

    realms = realm_index(sim)

    %{
      name: "township_authority_unattenuated_transfer",
      kind: "adversarial",
      log: log,
      realms: realms,
      perspectives: [],
      replica: replica,
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleCarrierOps: carrier_ops(log),
      authorityQuarantine: authority_quarantine
    }
  end

  defp township_capability_missing do
    sim =
      Sim.new(
        Matter,
        "replica:matter:capability-missing",
        ["clerk", "resident"],
        seed: "township:capability-missing"
      )

    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    sim = Sim.sync_all(sim)
    rejected_post = "resident: missing capability"
    missing_delegation_id = String.duplicate("U", 43)

    {sim, target} =
      Sim.command(sim, "resident", :post, [rejected_post], cap: missing_delegation_id)

    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "clerk")

    assert_authority_reason!(log, target.id, :no_capability)
    assert_post_absent!(log, rejected_post)

    capability_scenario("township_capability_missing", sim, log, %{
      "targetOperationId" => target.id,
      "expectedReason" => "no_capability",
      "rejectedPost" => rejected_post,
      "missingDelegationId" => missing_delegation_id
    })
  end

  defp township_capability_invalid do
    sim =
      Sim.new(
        Matter,
        "replica:matter:capability-invalid",
        ["clerk", "resident"],
        seed: "township:capability-invalid"
      )

    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    clerk = Sim.identity(sim, "clerk")
    resident = Sim.identity(sim, "resident")
    replica = Sim.replica(sim)
    missing_parent_id = String.duplicate("M", 43)

    invalid_delegation =
      Delegation.new(clerk, replica, resident.pub,
        ops: [:post],
        parent_id: missing_parent_id
      )

    unless Delegation.valid_sig?(invalid_delegation) do
      raise "expected missing-parent delegation to remain structurally signed"
    end

    introduction =
      Op.new(
        clerk,
        replica,
        Log.frontier(Sim.log(sim, "clerk")),
        :authority,
        {:grant, invalid_delegation}
      )

    log = Sim.log(sim, "clerk") |> Log.append!(introduction)
    rejected_post = "resident: invalid capability chain"

    target =
      Op.new(
        resident,
        replica,
        Log.frontier(log),
        :command,
        {:post, [rejected_post]},
        cap: invalid_delegation.id
      )

    log = Log.append!(log, target)

    assert_authority_reason!(log, introduction.id, :missing_parent)
    assert_authority_reason!(log, target.id, :invalid_capability)
    assert_post_absent!(log, rejected_post)

    capability_scenario("township_capability_invalid", sim, log, %{
      "targetOperationId" => target.id,
      "expectedReason" => "invalid_capability",
      "rejectedPost" => rejected_post,
      "invalidDelegationIntroductionId" => introduction.id,
      "invalidDelegationId" => invalid_delegation.id,
      "missingParentDelegationId" => missing_parent_id
    })
  end

  defp township_capability_wrong_audience do
    sim =
      Sim.new(
        Matter,
        "replica:matter:capability-wrong-audience",
        ["clerk", "resident", "mallory"],
        seed: "township:capability-wrong-audience"
      )

    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, delegation} = Sim.grant(sim, "clerk", "resident", ops: [:post])
    sim = Sim.sync_all(sim)
    rejected_post = "mallory: borrowed resident capability"

    {sim, target} =
      Sim.command(sim, "mallory", :post, [rejected_post], cap: delegation.id)

    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "clerk")

    assert_authority_reason!(log, target.id, :capability_wrong_audience)
    assert_post_absent!(log, rejected_post)

    capability_scenario("township_capability_wrong_audience", sim, log, %{
      "targetOperationId" => target.id,
      "expectedReason" => "capability_wrong_audience",
      "rejectedPost" => rejected_post
    })
  end

  defp township_capability_operation_not_granted do
    sim =
      Sim.new(
        Matter,
        "replica:matter:capability-operation-not-granted",
        ["clerk", "resident"],
        seed: "township:capability-operation-not-granted"
      )

    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, delegation} = Sim.grant(sim, "clerk", "resident", ops: [:set_title])
    sim = Sim.sync_all(sim)
    rejected_post = "resident: operation outside delegation"

    {sim, target} =
      Sim.command(sim, "resident", :post, [rejected_post], cap: delegation.id)

    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "clerk")

    assert_authority_reason!(log, target.id, :operation_not_granted)
    assert_post_absent!(log, rejected_post)

    capability_scenario("township_capability_operation_not_granted", sim, log, %{
      "targetOperationId" => target.id,
      "expectedReason" => "operation_not_granted",
      "rejectedPost" => rejected_post
    })
  end

  defp township_capability_not_visible do
    sim =
      Sim.new(
        Matter,
        "replica:matter:capability-not-visible",
        ["clerk", "resident"],
        seed: "township:capability-not-visible"
      )

    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    sim = sim |> Sim.sync_all() |> Sim.partition("clerk", "resident")
    {sim, delegation} = Sim.grant(sim, "clerk", "resident", ops: [:post])

    introduction =
      sim
      |> Sim.log("clerk")
      |> Log.topo_ops()
      |> Enum.find(fn
        %Op{kind: :authority, body: {:grant, %Delegation{id: id}}} ->
          id == delegation.id

        _op ->
          false
      end)

    introduction =
      case introduction do
        %Op{} = op -> op
        nil -> raise "missing not-visible delegation introduction"
      end

    rejected_post = "resident: capability was not visible"

    {sim, target} =
      Sim.command(sim, "resident", :post, [rejected_post], cap: delegation.id)

    sim = sim |> Sim.heal("clerk", "resident") |> Sim.sync_all()
    log = Sim.log(sim, "clerk")

    if introduction.id in target.deps do
      raise "expected not-visible command to exclude its grant introduction"
    end

    assert_authority_reason!(log, target.id, :capability_not_visible)
    assert_post_absent!(log, rejected_post)

    capability_scenario("township_capability_not_visible", sim, log, %{
      "targetOperationId" => target.id,
      "expectedReason" => "capability_not_visible",
      "rejectedPost" => rejected_post,
      "delegationIntroductionId" => introduction.id
    })
  end

  defp township_capability_role_not_granted do
    sim =
      Sim.new(
        Matter,
        "replica:matter:capability-role-not-granted",
        ["clerk", "resident"],
        seed: "township:capability-role-not-granted"
      )

    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    sim = Sim.sync_all(sim)
    {sim, setup} = Sim.command(sim, "clerk", :close_matter, [])
    sim = Sim.sync_all(sim)
    {sim, delegation} = Sim.grant(sim, "clerk", "resident", ops: [:reopen_matter])
    sim = Sim.sync_all(sim)

    {sim, target} =
      Sim.command(sim, "resident", :reopen_matter, [], cap: delegation.id)

    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "clerk")

    assert_authority_honored!(log, setup.id)
    assert_authority_reason!(log, target.id, :role_not_granted)

    unless Lattice.state(Matter, log).clerk_locked? do
      raise "expected role-less reopen command to preserve the closed matter"
    end

    capability_scenario("township_capability_role_not_granted", sim, log, %{
      "targetOperationId" => target.id,
      "expectedReason" => "role_not_granted",
      "setupOperationId" => setup.id
    })
  end

  defp township_capability_revoked_causal do
    sim =
      Sim.new(
        Matter,
        "replica:matter:capability-revoked-causal",
        ["clerk", "resident"],
        seed: "township:capability-revoked-causal"
      )

    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, delegation} = Sim.grant(sim, "clerk", "resident", ops: [:post])
    sim = Sim.sync_all(sim)

    before_post = "resident: causally before revoke"
    {sim, before} = Sim.command(sim, "resident", :post, [before_post], cap: delegation.id)
    sim = Sim.sync_all(sim)
    sim = Sim.partition(sim, "clerk", "resident")

    concurrent_post = "resident: concurrent with revoke"

    {sim, concurrent} =
      Sim.command(sim, "resident", :post, [concurrent_post], cap: delegation.id)

    {sim, revoke} = Sim.revoke(sim, "clerk", delegation.id)
    sim = sim |> Sim.heal("clerk", "resident") |> Sim.sync_all()
    after_post = "resident: causally after revoke"
    {sim, after_revoke} = Sim.command(sim, "resident", :post, [after_post], cap: delegation.id)
    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "clerk")

    assert_authority_honored!(log, before.id)
    assert_authority_reason!(log, concurrent.id, :revoked_capability)
    assert_authority_reason!(log, after_revoke.id, :revoked_capability)

    unless before.id in revoke.deps and concurrent.id not in revoke.deps and
             revoke.id not in concurrent.deps and revoke.id in after_revoke.deps do
      raise "expected before/concurrent/after revoke causal relationships"
    end

    posts = Lattice.state(Matter, log).posts

    unless before_post in posts and concurrent_post not in posts and after_post not in posts do
      raise "expected only the causally-before command to materialize"
    end

    capability_scenario("township_capability_revoked_causal", sim, log, %{
      "delegationId" => delegation.id,
      "beforeOperationId" => before.id,
      "beforePost" => before_post,
      "concurrentOperationId" => concurrent.id,
      "concurrentPost" => concurrent_post,
      "revokeOperationId" => revoke.id,
      "afterOperationId" => after_revoke.id,
      "afterPost" => after_post
    })
  end

  defp township_capability_revoked_chain do
    sim =
      Sim.new(
        Matter,
        "replica:matter:capability-revoked-chain",
        ["clerk", "resident", "mallory"],
        seed: "township:capability-revoked-chain"
      )

    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, parent} = Sim.grant(sim, "clerk", "resident", ops: [:post])
    sim = Sim.sync_all(sim)
    {sim, child} = Sim.grant(sim, "resident", "mallory", ops: [:post])
    sim = Sim.sync_all(sim)
    {sim, revoke} = Sim.revoke(sim, "clerk", parent.id)
    sim = Sim.sync_all(sim)
    rejected_post = "mallory: child use after parent revoke"

    {sim, target} =
      Sim.command(sim, "mallory", :post, [rejected_post], cap: child.id)

    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "clerk")

    unless child.parent_id == parent.id and revoke.id in target.deps do
      raise "expected child delegation use to follow its parent revoke"
    end

    assert_authority_reason!(log, target.id, :revoked_capability)
    assert_post_absent!(log, rejected_post)

    capability_scenario("township_capability_revoked_chain", sim, log, %{
      "parentDelegationId" => parent.id,
      "childDelegationId" => child.id,
      "revokeOperationId" => revoke.id,
      "targetOperationId" => target.id,
      "rejectedPost" => rejected_post
    })
  end

  defp township_revoke_unauthorized do
    sim =
      Sim.new(
        Matter,
        "replica:matter:revoke-unauthorized",
        ["clerk", "resident", "mallory"],
        seed: "township:revoke-unauthorized"
      )

    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, delegation} = Sim.grant(sim, "clerk", "resident", ops: [:post])
    sim = Sim.sync_all(sim)
    {sim, bad_revoke} = Sim.revoke(sim, "mallory", delegation.id)
    sim = Sim.sync_all(sim)
    honored_post = "resident: honored after unauthorized revoke"

    {sim, target} =
      Sim.command(sim, "resident", :post, [honored_post], cap: delegation.id)

    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "clerk")

    unless bad_revoke.id in target.deps do
      raise "expected honored control command to be causally after the bad revoke"
    end

    assert_authority_reason!(log, bad_revoke.id, :unauthorized_revoke)
    assert_authority_honored!(log, target.id)

    unless honored_post in Lattice.state(Matter, log).posts do
      raise "expected unauthorized revoke to leave the delegation usable"
    end

    capability_scenario("township_revoke_unauthorized", sim, log, %{
      "delegationId" => delegation.id,
      "revokeOperationId" => bad_revoke.id,
      "targetOperationId" => target.id,
      "honoredPost" => honored_post
    })
  end

  defp capability_scenario(name, sim, log, evidence) do
    realms = realm_index(sim)

    %{
      name: name,
      kind: "adversarial",
      log: log,
      realms: realms,
      perspectives: [],
      replica: log.replica,
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleCarrierOps: carrier_ops(log),
      authorityQuarantine: authority_quarantine(log),
      capabilityCase: evidence
    }
  end

  defp assert_authority_reason!(log, op_id, expected_reason) do
    actual_reason = Authority.analyze(Matter, log).reasons[op_id]

    unless actual_reason == expected_reason do
      raise "expected #{op_id} to quarantine as #{expected_reason}, got #{inspect(actual_reason)}"
    end
  end

  defp assert_authority_honored!(log, op_id) do
    if Map.has_key?(Authority.analyze(Matter, log).reasons, op_id) do
      raise "expected #{op_id} to remain authority-honored"
    end
  end

  defp assert_post_absent!(log, post) do
    if post in Lattice.state(Matter, log).posts do
      raise "expected quarantined post #{inspect(post)} not to materialize"
    end
  end

  defp township_causal_list_partition do
    sim =
      Sim.new(
        Matter,
        "replica:matter:causal-order-7",
        ["clerk", "resident"],
        seed: "township:causal-order-7"
      )

    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, _grant} = Sim.grant(sim, "clerk", "resident", ops: [:admit, :post])
    sim = Sim.sync_all(sim)
    {sim, _} = Sim.command(sim, "clerk", :admit, ["clerk"])
    {sim, _} = Sim.command(sim, "clerk", :admit, ["resident"])
    sim = Sim.sync_all(sim)

    sim = Sim.partition(sim, "clerk", "resident")
    {sim, post_m} = Sim.command(sim, "resident", :post, ["resident: first branch post"])
    {sim, post_a} = Sim.command(sim, "resident", :post, ["resident: second branch post"])
    {sim, post_z} = Sim.command(sim, "clerk", :post, ["clerk: concurrent post"])
    sim = sim |> Sim.heal("clerk", "resident") |> Sim.sync_all()

    log = Sim.log(sim, "clerk")

    # The single concurrent post sits one causal height BELOW the second branch
    # post, but both branch-post ids sort below it. A topological order that
    # tiebreaks ready ops by ascending id therefore emits the deeper branch post
    # first, while `{height, op_id}` puts the concurrent post between the two —
    # exactly the finding-2 drift class this vector exists to pin.
    unless post_m.id < post_z.id and post_a.id < post_z.id do
      raise "expected both branch post ids to sort below the concurrent post id"
    end

    expected_posts = [
      "resident: first branch post",
      "clerk: concurrent post",
      "resident: second branch post"
    ]

    unless Lattice.state(Matter, log).posts == expected_posts do
      raise "expected {height, op_id} to order the concurrent post between the branch posts"
    end

    unless Lattice.Authority.analyze(Matter, log) |> Map.fetch!(:quarantine) |> Enum.empty?() do
      raise "expected the concurrent-append partition to quarantine nothing"
    end

    realms = realm_index(sim)

    %{
      name: "township_causal_list_partition",
      kind: "adversarial",
      log: log,
      realms: realms,
      perspectives: [],
      replica: Sim.replica(sim),
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleCarrierOps: carrier_ops(log),
      authorityQuarantine: authority_quarantine(log)
    }
  end

  defp township_partial_log_lww do
    sim =
      Sim.new(
        Matter,
        "replica:matter:partial-log-2",
        ["clerk"],
        seed: "township:partial-log-2"
      )

    {sim, genesis} = Sim.create_replica(sim, "clerk")
    {:genesis, genesis_deleg, _policies} = genesis.body
    {sim, pruned_parent} = Sim.command(sim, "clerk", :set_title, ["working title"])

    clerk = Sim.identity(sim, "clerk")
    replica = Sim.replica(sim)

    # The bridge is an inbox request — the one op kind that needs no capability
    # justification — so pruning its parent leaves nothing to quarantine and the
    # vector isolates the dangling-dependency height base alone.
    bridge =
      Op.new(
        clerk,
        replica,
        [pruned_parent.id],
        :inbox,
        {:request, "prune-bridge", {:post, ["bridge"]}}
      )

    {:ok, pruned_branch_body} =
      Matter.command_body(:set_summary, ["summary reached through the pruned branch"])

    {:ok, root_branch_body} =
      Matter.command_body(:set_summary, ["summary from the surviving root"])

    pruned_branch_summary =
      Op.new(clerk, replica, [bridge.id, genesis.id], :command, pruned_branch_body,
        cap: genesis_deleg.id
      )

    root_branch_summary =
      Op.new(clerk, replica, [genesis.id], :command, root_branch_body, cap: genesis_deleg.id)

    unless root_branch_summary.id > pruned_branch_summary.id do
      raise "expected the surviving-root summary id to break the height tie in its favor"
    end

    full_log =
      Sim.log(sim, "clerk")
      |> Log.append!(bridge)
      |> Log.append!(pruned_branch_summary)
      |> Log.append!(root_branch_summary)

    unless Lattice.state(Matter, full_log).summary ==
             "summary reached through the pruned branch" do
      raise "expected the complete log to prefer the causally deeper summary"
    end

    log = %{full_log | ops: Map.delete(full_log.ops, pruned_parent.id)}

    unless Authority.analyze(Matter, log) |> Map.fetch!(:reasons) |> Enum.empty?() do
      raise "expected the pruned log to quarantine nothing"
    end

    state = Lattice.state(Matter, log)

    unless state.summary == "summary from the surviving root" and state.title == "" do
      raise "expected the -1 dangling-dependency base to flip the summary winner"
    end

    realms = realm_index(sim)

    %{
      name: "township_partial_log_lww",
      kind: "adversarial",
      log: log,
      realms: realms,
      perspectives: [],
      replica: replica
    }
  end

  defp township_carrier_w1 do
    base = carrier_base_sim()

    diverged =
      base
      |> Sim.partition("clerk", "resident")
      |> carrier_diverge("clerk")
      |> carrier_diverge("resident")

    oracle =
      diverged
      |> Sim.heal("clerk", "resident")
      |> Sim.sync_all()

    oracle_log = Sim.log(oracle, "resident")
    realms = realm_index(oracle)
    authority_unsound_grant = carrier_authority_unsound_grant(oracle, oracle_log)
    authority_revocation = carrier_authority_revocation(oracle, oracle_log)
    authority_bad_revocation = carrier_authority_bad_revocation(oracle, oracle_log)

    %{
      name: "township_carrier_w1",
      carrier?: true,
      kind: "carrier",
      schema: schema_json(),
      replica: Sim.replica(base),
      client: carrier_endpoint("resident"),
      peer: carrier_endpoint("clerk"),
      realmByPubkey: carrier_realm_by_pubkey(realms),
      oracleLog: oracle_log,
      realms: realms,
      clientBaseCarrierOps: carrier_ops(Sim.log(base, "resident")),
      clientDivergedCarrierOps: carrier_ops(Sim.log(diverged, "resident")),
      peerDivergedCarrierOps: carrier_ops(Sim.log(diverged, "clerk")),
      oracleCarrierOps: carrier_ops(oracle_log),
      canonicalOps: canonical_ops(oracle_log),
      authorityUnsoundGrant: authority_unsound_grant,
      authorityRevocation: authority_revocation,
      authorityBadRevocation: authority_bad_revocation,
      expectAfterSync: %{
        "state" => state_json(oracle_log, realms),
        "stateB64" => state_bytes_b64(oracle_log),
        "opIds" => oracle_log |> Log.op_ids() |> MapSet.to_list() |> Enum.sort(),
        "frontier" => Log.frontier(oracle_log),
        "authorityQuarantine" => authority_quarantine(oracle_log)
      }
    }
  end

  defp carrier_authority_bad_revocation(%Sim{} = sim, %Log{} = oracle_log) do
    resident = Sim.identity(sim, "resident")
    parent = resident_parent_delegation!(oracle_log, resident.pub)

    {bad_revoke, bad_revoke_op} = Sim.revoke(sim, "resident", parent.id)

    {bad_revoke, post_revoke_command_op} =
      bad_revoke
      |> Sim.sync_all()
      |> Sim.command("resident", :post, ["resident: post after unauthorized revoke"],
        cap: parent.id
      )

    final_log =
      bad_revoke
      |> Sim.sync_all()
      |> Sim.log("resident")

    authority_quarantine = authority_quarantine(final_log)

    unless [bad_revoke_op.id, "unauthorized_revoke"] in authority_quarantine do
      raise "expected bad revoke #{bad_revoke_op.id} to quarantine as unauthorized_revoke"
    end

    if Enum.any?(authority_quarantine, fn [id, _reason] -> id == post_revoke_command_op.id end) do
      raise "expected post after bad revoke #{post_revoke_command_op.id} to remain authority-honored"
    end

    unless "resident: post after unauthorized revoke" in Lattice.state(Matter, final_log).posts do
      raise "expected unauthorized revoke to leave delegation usable for a later post"
    end

    if state_bytes_b64(final_log) == state_bytes_b64(oracle_log) do
      raise "expected post after unauthorized revoke to change materialized state"
    end

    %{
      "delegationId" => parent.id,
      "revokeOp" => CarrierWire.encode_op(bad_revoke_op),
      "postRevokeCommandOp" => CarrierWire.encode_op(post_revoke_command_op),
      "authorityQuarantine" => authority_quarantine,
      "stateB64" => state_bytes_b64(final_log),
      "opIds" => final_log |> Log.op_ids() |> MapSet.to_list() |> Enum.sort()
    }
  end

  defp carrier_authority_unsound_grant(%Sim{} = sim, %Log{} = oracle_log) do
    resident = Sim.identity(sim, "resident")
    clerk = Sim.identity(sim, "clerk")
    parent = resident_parent_delegation!(oracle_log, resident.pub)

    delegation =
      Delegation.new(resident, Sim.replica(sim), clerk.pub,
        ops: [:close_matter],
        roles: [:clerk],
        parent_id: parent.id
      )

    op =
      Op.new(
        resident,
        Sim.replica(sim),
        Log.frontier(oracle_log),
        :authority,
        {:grant, delegation}
      )

    unsound_log = Log.append!(oracle_log, op)
    authority_quarantine = authority_quarantine(unsound_log)

    unless [op.id, "not_attenuated"] in authority_quarantine do
      raise "expected authority-unsound grant #{op.id} to quarantine as not_attenuated"
    end

    %{
      "carrierOp" => CarrierWire.encode_op(op),
      "parentDelegationId" => parent.id,
      "authorityQuarantine" => authority_quarantine
    }
  end

  defp carrier_authority_revocation(%Sim{} = sim, %Log{} = oracle_log) do
    resident = Sim.identity(sim, "resident")
    parent = resident_parent_delegation!(oracle_log, resident.pub)
    pre_revoke_command = resident_pre_revoke_command!(oracle_log, parent.id)

    baseline_quarantine = authority_quarantine(oracle_log)

    if Enum.any?(baseline_quarantine, fn [id, _reason] -> id == pre_revoke_command.id end) do
      raise "expected pre-revoke command #{pre_revoke_command.id} to be authority-honored"
    end

    {revoked, revoke_op} = Sim.revoke(sim, "clerk", parent.id)

    {revoked, revoked_command_op} =
      revoked
      |> Sim.sync_all()
      |> Sim.command("resident", :post, ["resident: attempted after revocation"], cap: parent.id)

    final_log =
      revoked
      |> Sim.sync_all()
      |> Sim.log("resident")

    authority_quarantine = authority_quarantine(final_log)

    unless [revoked_command_op.id, "revoked_capability"] in authority_quarantine do
      raise "expected revoked-cap command #{revoked_command_op.id} to quarantine as revoked_capability"
    end

    if Enum.any?(authority_quarantine, fn [id, _reason] -> id == revoke_op.id end) do
      raise "expected clerk-authored revoke #{revoke_op.id} to remain authority-honored"
    end

    unless state_bytes_b64(final_log) == state_bytes_b64(oracle_log) do
      raise "expected revocation fixture to leave materialized state unchanged"
    end

    %{
      "delegationId" => parent.id,
      "preRevokeCommandId" => pre_revoke_command.id,
      "revokeOp" => CarrierWire.encode_op(revoke_op),
      "revokedCommandOp" => CarrierWire.encode_op(revoked_command_op),
      "authorityQuarantine" => authority_quarantine,
      "stateB64" => state_bytes_b64(final_log),
      "opIds" => final_log |> Log.op_ids() |> MapSet.to_list() |> Enum.sort()
    }
  end

  defp resident_parent_delegation!(%Log{} = log, resident_pub) do
    log
    |> Log.topo_ops()
    |> Enum.find_value(fn
      %Op{kind: :authority, body: {:grant, %Delegation{} = delegation}} ->
        if delegation.audience == resident_pub and MapSet.member?(delegation.ops, :post) and
             not MapSet.member?(delegation.ops, :close_matter) do
          delegation
        end

      _op ->
        nil
    end)
    |> case do
      %Delegation{} = delegation -> delegation
      nil -> raise "missing resident parent delegation for authority-unsound grant vector"
    end
  end

  defp resident_pre_revoke_command!(%Log{} = log, delegation_id) do
    log
    |> Log.topo_ops()
    |> Enum.find(fn
      %Op{kind: :command, cap: ^delegation_id, body: {:post, ["resident: posted while offline"]}} ->
        true

      _op ->
        false
    end)
    |> case do
      %Op{} = op -> op
      nil -> raise "missing pre-revoke resident command for revocation vector"
    end
  end

  defp carrier_base_sim do
    sim = Sim.new(Matter, @carrier_replica, @carrier_realms, seed: @carrier_seed)

    {sim, _genesis} =
      Sim.create_replica(sim, "clerk",
        policies: %{clerk: %{successor: "resident", dormant_ticks: 3}}
      )

    {sim, _grant} =
      Sim.grant(sim, "clerk", "resident", ops: [:admit, :post, :set_summary, :set_title])

    sim = Sim.sync_all(sim)
    {sim, _} = Sim.command(sim, "clerk", :admit, ["clerk"])
    {sim, _} = Sim.command(sim, "clerk", :admit, ["resident"])
    Sim.sync_all(sim)
  end

  defp carrier_diverge(%Sim{} = sim, "clerk") do
    {sim, _} = Sim.command(sim, "clerk", :set_summary, ["Leaning approve (clerk edit)"])
    {sim, _} = Sim.command(sim, "clerk", :post, ["clerk: hearing Tuesday 6pm"])
    {sim, _} = Sim.command(sim, "clerk", :close_matter, [])

    {sim, _} =
      Sim.transfer(sim, "clerk", "resident", :clerk,
        at_tick: 1,
        ops: [:close_matter, :reopen_matter]
      )

    {sim, _} = Sim.command(sim, "clerk", :reopen_matter, [])
    sim
  end

  defp carrier_diverge(%Sim{} = sim, "resident") do
    {sim, _} = Sim.command(sim, "resident", :set_summary, ["Needs traffic study"])
    {sim, _} = Sim.command(sim, "resident", :post, ["resident: posted while offline"])
    sim
  end

  defp carrier_endpoint(realm) do
    identity = Lattice.Identity.from_seed(realm, @carrier_seed)

    %{
      "realm" => realm,
      "sessionPubkey" => Base.encode64(identity.pub),
      "sessionSeed" => @carrier_seed
    }
  end

  defp carrier_realm_by_pubkey(realms) do
    Map.new(realms, fn {pub, realm} -> {Base.encode64(pub), realm} end)
  end

  defp carrier_ops(%Log{} = log) do
    log
    |> Log.topo_ops()
    |> Enum.map(&CarrierWire.encode_op/1)
  end

  defp canonical_ops(%Log{} = log) do
    log
    |> Log.topo_ops()
    |> Enum.map(fn %Op{} = op ->
      %{
        "id" => op.id,
        "suite" => Canonical.suite(),
        "bytesHex" => op |> Op.canonical_encoding() |> Base.encode16(case: :lower),
        "hash" => Op.recompute_id(op)
      }
    end)
  end

  defp township_random(seed) do
    sim =
      Sim.new(Matter, "replica:matter:random-#{seed}", @random_realms,
        seed: "township:random:#{seed}"
      )

    {sim, _genesis} =
      Sim.create_replica(sim, "clerk",
        policies: %{clerk: %{successor: "resident", dormant_ticks: 3}}
      )

    {sim, _resident_grant} =
      Sim.grant(sim, "clerk", "resident",
        ops: [:admit, :remove_member, :post, :set_summary, :set_title]
      )

    {sim, _neighbor_grant} =
      Sim.grant(sim, "clerk", "neighbor",
        ops: [:admit, :remove_member, :post, :set_summary, :set_title]
      )

    sim = Sim.sync_all(sim)

    sim =
      Enum.reduce(@random_realms, sim, fn realm, acc ->
        acc |> Sim.command(realm, :admit, [realm]) |> elem(0)
      end)

    sim =
      seed
      |> random_actions(10)
      |> Enum.reduce(sim, &apply_random_action/2)
      |> heal_all()
      |> Sim.sync_all()

    %{
      name: "township_random_#{seed}",
      kind: "randomized",
      seed: seed,
      log: Sim.log(sim, "clerk"),
      realms: realm_index(sim),
      perspectives: []
    }
  end

  defp random_actions(seed, count) do
    rand_state = :rand.seed_s(:exsss, {seed, seed * 2 + 1, seed * 3 + 2})

    1..count
    |> Enum.map_reduce(rand_state, fn step, state ->
      {kind, state} =
        choose([:post, :summary, :title, :admit, :remove, :partition, :heal, :sync], state)

      case kind do
        :post ->
          {realm, state} = choose(@random_realms, state)
          {{:post, realm, "p#{seed}-#{step}"}, state}

        :summary ->
          {realm, state} = choose(@random_realms, state)
          {{:summary, realm, "summary #{seed}.#{step}"}, state}

        :title ->
          {realm, state} = choose(@random_realms, state)
          {{:title, realm, "Matter #{seed}.#{step}"}, state}

        :admit ->
          {realm, state} = choose(@random_realms, state)
          {{:admit, realm, "guest-#{seed}-#{step}"}, state}

        :remove ->
          {realm, state} = choose(@random_realms, state)
          {{:remove, realm, "guest-#{seed}-#{rem(step + seed, count) + 1}"}, state}

        kind when kind in [:partition, :heal, :sync] ->
          {a, b, state} = random_pair(state)
          {{kind, a, b}, state}
      end
    end)
    |> elem(0)
  end

  defp choose(list, state) do
    {idx, state} = :rand.uniform_s(length(list), state)
    {Enum.at(list, idx - 1), state}
  end

  defp random_pair(state) do
    {a, state} = choose(@random_realms, state)
    {b, state} = choose(@random_realms -- [a], state)
    {a, b, state}
  end

  defp apply_random_action({:post, realm, text}, sim),
    do: sim |> Sim.command(realm, :post, [text]) |> elem(0)

  defp apply_random_action({:summary, realm, text}, sim),
    do: sim |> Sim.command(realm, :set_summary, [text]) |> elem(0)

  defp apply_random_action({:title, realm, text}, sim),
    do: sim |> Sim.command(realm, :set_title, [text]) |> elem(0)

  defp apply_random_action({:admit, realm, member}, sim),
    do: sim |> Sim.command(realm, :admit, [member]) |> elem(0)

  defp apply_random_action({:remove, realm, member}, sim),
    do: sim |> Sim.command(realm, :remove_member, [member]) |> elem(0)

  defp apply_random_action({:partition, a, b}, sim), do: Sim.partition(sim, a, b)
  defp apply_random_action({:heal, a, b}, sim), do: Sim.heal(sim, a, b)
  defp apply_random_action({:sync, a, b}, sim), do: Sim.sync(sim, a, b)

  defp heal_all(sim) do
    Enum.reduce(@random_realms, sim, fn a, acc ->
      Enum.reduce(@random_realms, acc, fn b, acc2 ->
        if a < b, do: Sim.heal(acc2, a, b), else: acc2
      end)
    end)
  end

  defp to_vector(%{name: name, log: log, realms: realms, perspectives: perspectives} = scenario) do
    ops = Enum.map(Log.topo_ops(log), &op_json(&1, realms))

    quarantine =
      Matter
      |> Authority.analyze(log)
      |> Map.fetch!(:quarantine)
      |> MapSet.to_list()
      |> Enum.sort()

    winners = winners(ops, MapSet.new(quarantine))

    expected =
      %{
        "state" => state_json(log, realms),
        "quarantine" => quarantine,
        "winners" => winners
      }
      |> maybe_put("authorityQuarantine", Map.get(scenario, :authorityQuarantine))

    %{
      "generatedBy" => "Lattice.Sim",
      "scenario" => name,
      "schema" => schema_json(),
      "ops" => ops,
      "expectAtFullFrontier" => expected,
      "expectAtFrontier" =>
        Enum.map(perspectives, fn perspective ->
          %{
            "include" => perspective.log |> Log.op_ids() |> MapSet.to_list() |> Enum.sort(),
            "state" => state_json(perspective.log, realms),
            "note" => perspective.name
          }
        end),
      "perspectives" =>
        Enum.map(perspectives, fn perspective ->
          %{
            "name" => perspective.name,
            "include" => perspective.log |> Log.op_ids() |> MapSet.to_list() |> Enum.sort()
          }
        end)
    }
    |> maybe_put("scenarioKind", Map.get(scenario, :kind))
    |> maybe_put("seed", Map.get(scenario, :seed))
    |> maybe_put("replica", Map.get(scenario, :replica))
    |> maybe_put("realmByPubkey", Map.get(scenario, :realmByPubkey))
    |> maybe_put("oracleCarrierOps", Map.get(scenario, :oracleCarrierOps))
    |> maybe_put("successionOperationId", Map.get(scenario, :successionOperationId))
    |> maybe_put("tickProvenance", Map.get(scenario, :tickProvenance))
    |> maybe_put("witnessedRecovery", Map.get(scenario, :witnessedRecovery))
    |> maybe_put("genesisProjection", Map.get(scenario, :genesisProjection))
    |> maybe_put("capabilityCase", Map.get(scenario, :capabilityCase))
  end

  defp to_vector(%{carrier?: true} = scenario) do
    ops = Enum.map(Log.topo_ops(scenario.oracleLog), &op_json(&1, scenario.realms))

    quarantine =
      Matter
      |> Authority.analyze(scenario.oracleLog)
      |> Map.fetch!(:quarantine)
      |> MapSet.to_list()
      |> Enum.sort()

    %{
      "generatedBy" => "Lattice.Sim",
      "scenario" => scenario.name,
      "scenarioKind" => scenario.kind,
      "schema" => scenario.schema,
      "ops" => ops,
      "expectAtFullFrontier" => %{
        "state" => state_json(scenario.oracleLog, scenario.realms),
        "quarantine" => quarantine,
        "winners" => winners(ops, MapSet.new(quarantine))
      },
      "expectAtFrontier" => [],
      "perspectives" => [],
      "replica" => scenario.replica,
      "client" => scenario.client,
      "peer" => scenario.peer,
      "realmByPubkey" => scenario.realmByPubkey,
      "clientBaseCarrierOps" => scenario.clientBaseCarrierOps,
      "clientDivergedCarrierOps" => scenario.clientDivergedCarrierOps,
      "peerDivergedCarrierOps" => scenario.peerDivergedCarrierOps,
      "oracleCarrierOps" => scenario.oracleCarrierOps,
      "canonicalOps" => scenario.canonicalOps,
      "authorityUnsoundGrant" => scenario.authorityUnsoundGrant,
      "authorityRevocation" => scenario.authorityRevocation,
      "authorityBadRevocation" => scenario.authorityBadRevocation,
      "expectAfterSync" => scenario.expectAfterSync
    }
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp witnessed_claim_json(claim) do
    %{
      "version" => claim.version,
      "replica" => claim.replica,
      "role" => Atom.to_string(claim.role),
      "holderPubkey" => Base.encode64(claim.holder),
      "holderEpoch" => claim.holder_epoch,
      "successorPubkey" => Base.encode64(claim.successor),
      "policyId" => claim.policy_id
    }
  end

  defp witnessed_policy_json(policy) do
    %{
      "mode" => Atom.to_string(policy.mode),
      "version" => policy.version,
      "witnessPubkeys" => Enum.map(policy.witnesses, &Base.encode64/1),
      "threshold" => policy.threshold
    }
  end

  defp schema_json do
    %{
      "name" => "Township.Matter",
      "fields" => %{
        "title" => %{"merge" => "lww", "default" => ""},
        "summary" => %{"merge" => "lww", "default" => ""},
        "posts" => %{"merge" => "causal_list"},
        "members" => %{"merge" => "or_set"},
        "clerk" => %{"authority" => "clerk"},
        "clerk_locked" => %{"merge" => "lww", "gatedBy" => "clerk", "default" => false}
      }
    }
  end

  defp op_json(%Lattice.Op{} = op, realms) do
    payload = payload_json(op, realms)

    %{
      "id" => op.id,
      "deps" => op.deps,
      "kind" => Atom.to_string(op.kind),
      "author" => realm_for_pub(realms, op.author),
      "field" => payload.field,
      "mutation" => payload.mutation,
      "value" => payload.value,
      "hash" => op.id,
      "command" => payload.command
    }
  end

  defp payload_json(%Lattice.Op{kind: :command, body: {cmd, args}}, _realms) do
    [{field, mutation} | _] = Matter.__apply_command__(cmd, args)

    %{
      field: field_name(field),
      mutation: mutation_name(mutation),
      value: mutation_value(mutation),
      command: Atom.to_string(cmd)
    }
  rescue
    ArgumentError -> neutral_payload("malformed_command")
  end

  defp payload_json(
         %Lattice.Op{kind: :authority, body: {:genesis, %Delegation{} = deleg, _policies}},
         realms
       ) do
    if MapSet.member?(deleg.roles, :clerk) do
      %{
        field: "clerk",
        mutation: "write",
        value: realm_for_pub(realms, deleg.issuer),
        command: "genesis clerk"
      }
    else
      neutral_payload("genesis")
    end
  end

  defp payload_json(
         %Lattice.Op{kind: :authority, body: {:transfer, role, %Delegation{} = deleg, _tick}},
         realms
       ) do
    %{
      field: Atom.to_string(role),
      mutation: "write",
      value: realm_for_pub(realms, deleg.audience),
      command: "transfer #{role}"
    }
  end

  defp payload_json(
         %Lattice.Op{kind: :authority, body: {:succeed, role, %Delegation{} = deleg, _tick}},
         realms
       ) do
    %{
      field: Atom.to_string(role),
      mutation: "write",
      value: realm_for_pub(realms, deleg.audience),
      command: "succeed #{role}"
    }
  end

  defp payload_json(%Lattice.Op{kind: :authority, body: {:grant, %Delegation{} = deleg}}, realms) do
    neutral_payload("grant #{realm_for_pub(realms, deleg.audience)}")
  end

  defp payload_json(%Lattice.Op{kind: :authority, body: {:revoke, id}}, _realms) do
    neutral_payload("revoke #{id}")
  end

  defp payload_json(%Lattice.Op{kind: kind}, _realms), do: neutral_payload(Atom.to_string(kind))

  defp neutral_payload(command) do
    %{field: "__authority", mutation: "write", value: nil, command: command}
  end

  defp mutation_name({name, _value}), do: Atom.to_string(name)
  defp mutation_value({_name, value}), do: value

  defp field_name(:clerk_locked?), do: "clerk_locked"
  defp field_name(field), do: Atom.to_string(field)

  defp state_json(log, realms) do
    state = Lattice.state(Matter, log)

    %{
      "title" => state.title,
      "summary" => state.summary,
      "posts" => state.posts,
      "members" => state.members,
      "clerk" => Matter |> Authority.holder(log, :clerk) |> then(&realm_for_pub(realms, &1)),
      "clerk_locked" => state.clerk_locked?
    }
  end

  defp state_bytes_b64(%Log{} = log) do
    Matter
    |> Lattice.state(log)
    |> :erlang.term_to_binary([:deterministic, {:minor_version, 2}])
    |> Base.encode64()
  end

  defp authority_quarantine(%Log{} = log) do
    Matter
    |> Authority.analyze(log)
    |> Map.fetch!(:reasons)
    |> Enum.map(fn {id, reason} -> [id, Atom.to_string(reason)] end)
    |> Enum.sort()
  end

  defp winners(ops, quarantine) do
    by_id = Map.new(ops, &{&1["id"], &1})

    for field <- ["title", "summary", "clerk", "clerk_locked"], into: %{} do
      winner =
        ops
        |> Enum.reject(&MapSet.member?(quarantine, &1["id"]))
        |> Enum.filter(&(&1["field"] == field and &1["mutation"] == "write"))
        |> Enum.max_by(&{depth(&1["id"], by_id, %{}), &1["id"]}, fn -> nil end)

      {field, winner && winner["id"]}
    end
  end

  defp depth(id, by_id, cache) do
    case Map.fetch(cache, id) do
      {:ok, depth} ->
        depth

      :error ->
        deps = by_id |> Map.fetch!(id) |> Map.fetch!("deps")

        if deps == [] do
          0
        else
          deps
          |> Enum.filter(&Map.has_key?(by_id, &1))
          |> Enum.map(&depth(&1, by_id, cache))
          |> Enum.max(fn -> -1 end)
          |> Kernel.+(1)
        end
    end
  end

  defp realm_index(%Sim{realms: realms}) do
    Map.new(realms, fn {realm, identity} -> {identity.pub, realm} end)
  end

  defp realm_for_pub(_realms, nil), do: nil

  defp realm_for_pub(realms, pub) do
    Map.get_lazy(realms, pub, fn -> Lattice.Identity.fingerprint(pub) end)
  end
end
