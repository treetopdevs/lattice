defmodule Township.ExportVectorsTest do
  use ExUnit.Case, async: false

  @single_capability_cases [
    {"township_capability_missing", "no_capability"},
    {"township_capability_invalid", "invalid_capability"},
    {"township_capability_wrong_audience", "capability_wrong_audience"},
    {"township_capability_operation_not_granted", "operation_not_granted"},
    {"township_capability_not_visible", "capability_not_visible"},
    {"township_capability_role_not_granted", "role_not_granted"}
  ]

  test "lattice.export_vectors pins capability and revocation decisions to the BEAM oracle" do
    out_dir =
      Path.join(
        System.tmp_dir!(),
        "lattice_capability_vectors_#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    for {scenario, reason} <- @single_capability_cases do
      vector = read_vector!(out_dir, scenario)

      assert vector["generatedBy"] == "Lattice.Sim"
      assert vector["scenario"] == scenario
      assert vector["scenarioKind"] == "adversarial"

      evidence = vector["capabilityCase"]
      target_id = evidence["targetOperationId"]
      expected = vector["expectAtFullFrontier"]

      assert is_binary(target_id)
      assert evidence["expectedReason"] == reason
      assert target_id in expected["quarantine"]
      assert [target_id, reason] in expected["authorityQuarantine"]
      assert Enum.any?(vector["oracleCarrierOps"], &(&1["id"] == target_id))

      case scenario do
        "township_capability_role_not_granted" ->
          setup_id = evidence["setupOperationId"]
          assert is_binary(setup_id)
          refute setup_id in expected["quarantine"]
          assert expected["state"]["clerk_locked"] == true

        "township_capability_not_visible" ->
          introduction_id = evidence["delegationIntroductionId"]
          assert is_binary(introduction_id)
          refute introduction_id in carrier_op!(vector, target_id)["deps"]

          rejected_post = evidence["rejectedPost"]
          assert is_binary(rejected_post)
          refute rejected_post in expected["state"]["posts"]

        _ ->
          rejected_post = evidence["rejectedPost"]
          assert is_binary(rejected_post)
          refute rejected_post in expected["state"]["posts"]
      end
    end

    missing = read_vector!(out_dir, "township_capability_missing")
    missing_evidence = missing["capabilityCase"]
    missing_delegation_id = missing_evidence["missingDelegationId"]

    assert is_binary(missing_delegation_id)

    assert carrier_op!(missing, missing_evidence["targetOperationId"])["cap"] ==
             ["bin", Base.encode64(missing_delegation_id)]

    invalid = read_vector!(out_dir, "township_capability_invalid")
    invalid_evidence = invalid["capabilityCase"]

    assert is_binary(invalid_evidence["invalidDelegationIntroductionId"])
    assert is_binary(invalid_evidence["invalidDelegationId"])
    assert is_binary(invalid_evidence["missingParentDelegationId"])

    assert Enum.any?(invalid["oracleCarrierOps"], fn
             %{
               "id" => introduction_id,
               "body" => [
                 "tuple",
                 [
                   ["atom", "grant"],
                   [
                     "delegation",
                     %{"id" => delegation_id, "parent_id" => missing_parent_id}
                   ]
                 ]
               ]
             } ->
               introduction_id == invalid_evidence["invalidDelegationIntroductionId"] and
                 delegation_id == invalid_evidence["invalidDelegationId"] and
                 missing_parent_id == invalid_evidence["missingParentDelegationId"]

             _frame ->
               false
           end)

    causal = read_vector!(out_dir, "township_capability_revoked_causal")
    causal_evidence = causal["capabilityCase"]
    causal_expected = causal["expectAtFullFrontier"]
    before_id = causal_evidence["beforeOperationId"]
    concurrent_id = causal_evidence["concurrentOperationId"]
    revoke_id = causal_evidence["revokeOperationId"]
    after_id = causal_evidence["afterOperationId"]

    assert [concurrent_id, "revoked_capability"] in causal_expected["authorityQuarantine"]
    assert [after_id, "revoked_capability"] in causal_expected["authorityQuarantine"]

    refute Enum.any?(causal_expected["authorityQuarantine"], fn [id, _reason] ->
             id == before_id
           end)

    refute before_id in causal_expected["quarantine"]
    assert concurrent_id in causal_expected["quarantine"]
    assert after_id in causal_expected["quarantine"]

    carrier_op!(causal, before_id)
    concurrent = carrier_op!(causal, concurrent_id)
    revoke = carrier_op!(causal, revoke_id)
    after_revoke = carrier_op!(causal, after_id)

    assert before_id in revoke["deps"]
    refute concurrent_id in revoke["deps"]
    refute revoke_id in concurrent["deps"]
    assert revoke_id in after_revoke["deps"]

    assert causal_evidence["beforePost"] in causal_expected["state"]["posts"]
    refute causal_evidence["concurrentPost"] in causal_expected["state"]["posts"]
    refute causal_evidence["afterPost"] in causal_expected["state"]["posts"]

    chain = read_vector!(out_dir, "township_capability_revoked_chain")
    chain_evidence = chain["capabilityCase"]
    chain_expected = chain["expectAtFullFrontier"]
    chain_target_id = chain_evidence["targetOperationId"]
    chain_revoke_id = chain_evidence["revokeOperationId"]

    assert chain_evidence["parentDelegationId"] != chain_evidence["childDelegationId"]
    assert [chain_target_id, "revoked_capability"] in chain_expected["authorityQuarantine"]
    assert chain_revoke_id in carrier_op!(chain, chain_target_id)["deps"]
    refute chain_evidence["rejectedPost"] in chain_expected["state"]["posts"]

    unauthorized = read_vector!(out_dir, "township_revoke_unauthorized")
    unauthorized_evidence = unauthorized["capabilityCase"]
    unauthorized_expected = unauthorized["expectAtFullFrontier"]
    bad_revoke_id = unauthorized_evidence["revokeOperationId"]
    honored_id = unauthorized_evidence["targetOperationId"]

    assert [bad_revoke_id, "unauthorized_revoke"] in unauthorized_expected["authorityQuarantine"]

    refute Enum.any?(unauthorized_expected["authorityQuarantine"], fn [id, _reason] ->
             id == honored_id
           end)

    assert bad_revoke_id in carrier_op!(unauthorized, honored_id)["deps"]
    assert unauthorized_evidence["honoredPost"] in unauthorized_expected["state"]["posts"]
  end

  test "lattice.export_vectors writes a Sim-generated Township conformance vector" do
    out_dir =
      Path.join(System.tmp_dir!(), "lattice_vectors_#{System.unique_integer([:positive])}")

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    assert File.exists?(Path.join(out_dir, "township_join_w0.json"))
    assert File.exists?(Path.join(out_dir, "township_succession_w3.json"))
    assert File.exists?(Path.join(out_dir, "township_carrier_w1.json"))
    assert File.exists?(Path.join(out_dir, "township_authority_forged_root.json"))
    assert File.exists?(Path.join(out_dir, "township_authority_embedded_replica_bypass.json"))
    assert File.exists?(Path.join(out_dir, "township_authority_forged_delegation_id.json"))
    assert File.exists?(Path.join(out_dir, "township_authority_forged_delegation_sig.json"))
    assert File.exists?(Path.join(out_dir, "township_authority_delegation_id_collision.json"))
    assert File.exists?(Path.join(out_dir, "township_authority_forged_transfer.json"))
    assert File.exists?(Path.join(out_dir, "township_authority_double_transfer.json"))
    assert File.exists?(Path.join(out_dir, "township_authority_unattenuated_transfer.json"))
    assert File.exists?(Path.join(out_dir, "township_causal_list_partition.json"))
    assert File.exists?(Path.join(out_dir, "township_partial_log_lww.json"))

    random_paths = Path.wildcard(Path.join(out_dir, "township_random_*.json"))
    assert length(random_paths) >= 5

    for path <- random_paths do
      vector = path |> File.read!() |> Jason.decode!()
      assert vector["generatedBy"] == "Lattice.Sim"
      assert vector["scenarioKind"] == "randomized"
      assert is_integer(vector["seed"])
      assert length(vector["ops"]) >= 6
    end

    vector_path = Path.join(out_dir, "township_zoning_variance_24.json")
    assert File.exists?(vector_path)

    vector = vector_path |> File.read!() |> Jason.decode!()

    assert vector["generatedBy"] == "Lattice.Sim"
    assert vector["scenario"] == "township_zoning_variance_24"
    refute Map.has_key?(vector, "$comment")

    ops = vector["ops"]
    assert length(ops) >= 10
    refute Enum.any?(ops, &String.match?(&1["id"], ~r/^op\d+$/))

    state = vector["expectAtFullFrontier"]["state"]
    assert state["title"] == "Zoning Variance #24"
    assert state["members"] == ["clerk", "resident"]
    assert state["clerk_locked"] == true

    [stale_id] = vector["expectAtFullFrontier"]["quarantine"]

    assert Enum.any?(ops, fn op ->
             op["id"] == stale_id and op["command"] == "reopen_matter"
           end)

    assert [%{"name" => "clerk_mid_partition"}, %{"name" => "resident_mid_partition"}] =
             vector["perspectives"]
  end

  test "lattice.export_vectors pins an unproven author-asserted succession tick" do
    out_dir =
      Path.join(
        System.tmp_dir!(),
        "lattice_unproven_tick_vectors_#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    vector_path = Path.join(out_dir, "township_succession_unproven_tick.json")
    assert File.exists?(vector_path)

    vector = vector_path |> File.read!() |> Jason.decode!()

    assert vector["generatedBy"] == "Lattice.Sim"
    assert vector["scenario"] == "township_succession_unproven_tick"
    assert vector["scenarioKind"] == "adversarial"
    assert vector["tickProvenance"] == "author_asserted_untrusted"

    succession_id = vector["successionOperationId"]
    assert is_binary(succession_id)
    assert Enum.any?(vector["oracleCarrierOps"], &(&1["id"] == succession_id))

    expected = vector["expectAtFullFrontier"]
    assert expected["state"]["clerk"] == "resident"
    assert expected["winners"]["clerk"] == succession_id
    refute succession_id in expected["quarantine"]

    refute Enum.any?(expected["authorityQuarantine"], fn [id, _reason] ->
             id == succession_id
           end)
  end

  test "lattice.export_vectors pins witnessed recovery to the BEAM oracle" do
    out_dir =
      Path.join(
        System.tmp_dir!(),
        "lattice_witnessed_recovery_vectors_#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    vector_path = Path.join(out_dir, "township_succession_witnessed_recovery.json")
    assert File.exists?(vector_path)

    vector = vector_path |> File.read!() |> Jason.decode!()

    assert vector["generatedBy"] == "Lattice.Sim"
    assert vector["scenario"] == "township_succession_witnessed_recovery"
    assert vector["scenarioKind"] == "adversarial"
    assert length(vector["oracleCarrierOps"]) == 5

    recovery = vector["witnessedRecovery"]
    denied_id = recovery["deniedOperationId"]
    honored_id = recovery["honoredOperationId"]
    impostor_genesis_id = recovery["impostorPolicyGenesisOperationId"]
    impostor_succession_id = recovery["impostorPolicySuccessionOperationId"]
    claim = recovery["claim"]
    policy = recovery["policy"]

    assert is_binary(denied_id)
    assert is_binary(honored_id)
    assert is_binary(impostor_genesis_id)
    assert is_binary(impostor_succession_id)
    assert recovery["policyId"] == claim["policyId"]

    assert claim["version"] == 1
    assert claim["replica"] == vector["replica"]
    assert claim["role"] == "clerk"
    assert vector["realmByPubkey"][claim["holderPubkey"]] == "clerk"
    assert vector["realmByPubkey"][claim["successorPubkey"]] == "resident"

    assert policy["mode"] == "witnessed"
    assert policy["version"] == 1
    assert policy["threshold"] == 2

    assert policy["witnessPubkeys"]
           |> Enum.map(&vector["realmByPubkey"][&1])
           |> Enum.sort() == ["witness_a", "witness_b", "witness_c"]

    frames = vector["oracleCarrierOps"]
    genesis = Enum.find(frames, &(&1["id"] == claim["holderEpoch"]))
    impostor_genesis = Enum.find(frames, &(&1["id"] == impostor_genesis_id))
    impostor_succession = Enum.find(frames, &(&1["id"] == impostor_succession_id))
    denied = Enum.find(frames, &(&1["id"] == denied_id))
    honored = Enum.find(frames, &(&1["id"] == honored_id))

    assert claim["holderEpoch"] == genesis["id"]
    assert impostor_genesis["deps"] == [genesis["id"]]
    assert impostor_genesis_id in impostor_succession["deps"]
    assert impostor_succession_id in denied["deps"]
    assert denied_id in honored["deps"]

    for frame <- [impostor_succession, denied, honored] do
      assert [
               "tuple",
               [
                 ["atom", "succeed"],
                 ["atom", "clerk"],
                 ["delegation", _delegation],
                 ["tuple", [["atom", "witnessed"], ["map", certificate_entries]]]
               ]
             ] = frame["body"]

      assert Enum.any?(certificate_entries, fn
               [["atom", "claim"], ["map", _claim_entries]] -> true
               _entry -> false
             end)

      assert Enum.any?(certificate_entries, fn
               [["atom", "signatures"], ["list", _signatures]] -> true
               _entry -> false
             end)
    end

    expected = vector["expectAtFullFrontier"]
    assert expected["state"]["clerk"] == "resident"
    assert expected["winners"]["clerk"] == honored_id

    assert MapSet.new(expected["quarantine"]) ==
             MapSet.new([impostor_genesis_id, impostor_succession_id, denied_id])

    assert MapSet.new(expected["authorityQuarantine"]) ==
             MapSet.new([
               [impostor_genesis_id, "impostor_genesis"],
               [impostor_succession_id, "unauthorized_succession"],
               [denied_id, "insufficient_recovery_witnesses"]
             ])
  end

  test "lattice.export_vectors pins valid-genesis holder and policy projection to the BEAM oracle" do
    out_dir =
      Path.join(
        System.tmp_dir!(),
        "lattice_genesis_projection_vectors_#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    vector = read_vector!(out_dir, "township_genesis_projection_parity")

    assert vector["generatedBy"] == "Lattice.Sim"
    assert vector["scenarioKind"] == "adversarial"

    projection = vector["genesisProjection"]
    [first_genesis_id, second_genesis_id] = projection["acquisitionOperationIds"]
    impostor_genesis_id = projection["impostorGenesisOperationId"]

    assert projection["role"] == "clerk"
    assert is_binary(first_genesis_id)
    assert is_binary(second_genesis_id)
    assert first_genesis_id != second_genesis_id
    assert projection["holderEpochOperationId"] == second_genesis_id
    assert projection["winningPolicyGenesisOperationId"] == second_genesis_id
    assert is_binary(projection["holderPubkey"])
    assert vector["realmByPubkey"][projection["holderPubkey"]] == "clerk"
    assert is_binary(projection["policyId"])
    assert is_binary(impostor_genesis_id)

    policy = projection["effectivePolicy"]
    assert policy["mode"] == "witnessed"
    assert policy["version"] == 1
    assert policy["threshold"] == 2
    assert vector["realmByPubkey"][policy["successorPubkey"]] == "resident"

    assert policy["witnessPubkeys"]
           |> Enum.map(&vector["realmByPubkey"][&1])
           |> Enum.sort() == ["witness_b", "witness_c"]

    frames = vector["oracleCarrierOps"]
    first_genesis = Enum.find(frames, &(&1["id"] == first_genesis_id))
    second_genesis = Enum.find(frames, &(&1["id"] == second_genesis_id))
    impostor_genesis = Enum.find(frames, &(&1["id"] == impostor_genesis_id))

    assert first_genesis["deps"] == []
    assert second_genesis["deps"] == [first_genesis_id]
    assert impostor_genesis["deps"] == [second_genesis_id]

    for frame <- [first_genesis, second_genesis, impostor_genesis] do
      assert [
               "tuple",
               [
                 ["atom", "genesis"],
                 ["delegation", _delegation],
                 ["map", _policies]
               ]
             ] = frame["body"]
    end

    assert [impostor_genesis_id, "impostor_genesis"] in vector["expectAtFullFrontier"][
             "authorityQuarantine"
           ]

    refute impostor_genesis_id in projection["acquisitionOperationIds"]
    assert vector["expectAtFullFrontier"]["state"]["clerk"] == "clerk"
    assert vector["expectAtFullFrontier"]["winners"]["clerk"] == second_genesis_id
  end

  test "lattice.export_vectors isolates an impostor genesis that Sim rejects" do
    out_dir =
      Path.join(
        System.tmp_dir!(),
        "lattice_forged_root_vectors_#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    vector =
      out_dir
      |> Path.join("township_authority_forged_root.json")
      |> File.read!()
      |> Jason.decode!()

    assert vector["generatedBy"] == "Lattice.Sim"
    assert vector["scenario"] == "township_authority_forged_root"
    assert vector["scenarioKind"] == "adversarial"
    assert is_binary(vector["replica"])
    assert is_map(vector["realmByPubkey"])
    assert length(vector["oracleCarrierOps"]) == 1

    expected = vector["expectAtFullFrontier"]
    assert expected["state"]["clerk"] == nil

    assert [
             %{
               "id" => impostor_genesis_id,
               "kind" => "authority",
               "body" => [
                 "tuple",
                 [
                   ["atom", "genesis"],
                   [
                     "delegation",
                     %{"parent_id" => nil, "roles" => roles, "issuer" => issuer}
                   ],
                   ["map", _policies]
                 ]
               ],
               "author" => issuer
             }
           ] = vector["oracleCarrierOps"]

    assert "clerk" in roles
    assert [impostor_genesis_id, "impostor_genesis"] in expected["authorityQuarantine"]
  end

  test "lattice.export_vectors isolates an embedded-replica root bypass that Sim rejects" do
    out_dir =
      Path.join(
        System.tmp_dir!(),
        "lattice_embedded_replica_vectors_#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    vector =
      out_dir
      |> Path.join("township_authority_embedded_replica_bypass.json")
      |> File.read!()
      |> Jason.decode!()

    assert vector["generatedBy"] == "Lattice.Sim"
    assert vector["scenario"] == "township_authority_embedded_replica_bypass"
    assert vector["scenarioKind"] == "adversarial"

    assert [
             %{
               "id" => impostor_genesis_id,
               "replica" => outer_replica,
               "author" => issuer,
               "body" => [
                 "tuple",
                 [
                   ["atom", "genesis"],
                   [
                     "delegation",
                     %{
                       "replica" => embedded_replica,
                       "issuer" => issuer,
                       "audience" => issuer,
                       "sig" => delegation_sig
                     }
                   ],
                   ["map", _policies]
                 ]
               ],
               "sig" => op_sig
             }
           ] = vector["oracleCarrierOps"]

    assert outer_replica == vector["replica"]
    refute outer_replica == embedded_replica
    assert is_binary(delegation_sig) and delegation_sig != ""
    assert is_binary(op_sig) and op_sig != ""

    expected = vector["expectAtFullFrontier"]
    assert expected["state"]["clerk"] == nil
    assert [impostor_genesis_id, "impostor_genesis"] in expected["authorityQuarantine"]
  end

  test "lattice.export_vectors isolates a forged delegation id that Sim rejects" do
    out_dir =
      Path.join(
        System.tmp_dir!(),
        "lattice_forged_delegation_id_vectors_#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    vector =
      out_dir
      |> Path.join("township_authority_forged_delegation_id.json")
      |> File.read!()
      |> Jason.decode!()

    assert vector["generatedBy"] == "Lattice.Sim"
    assert vector["scenario"] == "township_authority_forged_delegation_id"
    assert vector["scenarioKind"] == "adversarial"

    assert [
             %{
               "id" => forged_genesis_id,
               "replica" => replica,
               "author" => issuer,
               "body" => [
                 "tuple",
                 [
                   ["atom", "genesis"],
                   [
                     "delegation",
                     %{
                       "id" => forged_delegation_id,
                       "replica" => replica,
                       "issuer" => issuer,
                       "audience" => issuer,
                       "parent_id" => nil,
                       "sig" => delegation_sig
                     }
                   ],
                   ["map", _policies]
                 ]
               ],
               "sig" => op_sig
             }
           ] = vector["oracleCarrierOps"]

    assert replica == vector["replica"]
    assert String.match?(forged_delegation_id, ~r/\A[A-Za-z0-9_-]{43}\z/)
    assert is_binary(delegation_sig) and delegation_sig != ""
    assert is_binary(op_sig) and op_sig != ""

    expected = vector["expectAtFullFrontier"]
    assert expected["state"]["clerk"] == nil
    assert [forged_genesis_id, "bad_delegation_sig"] in expected["authorityQuarantine"]
  end

  test "lattice.export_vectors isolates a forged delegation signature that Sim rejects" do
    out_dir =
      Path.join(
        System.tmp_dir!(),
        "lattice_forged_delegation_sig_vectors_#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    vector =
      out_dir
      |> Path.join("township_authority_forged_delegation_sig.json")
      |> File.read!()
      |> Jason.decode!()

    assert vector["generatedBy"] == "Lattice.Sim"
    assert vector["scenario"] == "township_authority_forged_delegation_sig"
    assert vector["scenarioKind"] == "adversarial"

    assert [
             %{
               "id" => forged_genesis_id,
               "replica" => replica,
               "author" => issuer,
               "body" => [
                 "tuple",
                 [
                   ["atom", "genesis"],
                   [
                     "delegation",
                     %{
                       "id" => delegation_id,
                       "replica" => replica,
                       "issuer" => issuer,
                       "audience" => issuer,
                       "parent_id" => nil,
                       "sig" => delegation_sig
                     }
                   ],
                   ["map", _policies]
                 ]
               ],
               "sig" => op_sig
             }
           ] = vector["oracleCarrierOps"]

    assert replica == vector["replica"]
    assert String.match?(delegation_id, ~r/\A[A-Za-z0-9_-]{43}\z/)
    assert is_binary(delegation_sig) and delegation_sig != ""
    assert is_binary(op_sig) and op_sig != ""

    expected = vector["expectAtFullFrontier"]
    assert expected["state"]["clerk"] == nil
    assert [forged_genesis_id, "bad_delegation_sig"] in expected["authorityQuarantine"]
  end

  test "lattice.export_vectors keeps an early same-id forgery from poisoning a valid delegation" do
    out_dir =
      Path.join(
        System.tmp_dir!(),
        "lattice_delegation_id_collision_vectors_#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    vector =
      out_dir
      |> Path.join("township_authority_delegation_id_collision.json")
      |> File.read!()
      |> Jason.decode!()

    assert vector["generatedBy"] == "Lattice.Sim"
    assert vector["scenario"] == "township_authority_delegation_id_collision"
    assert vector["scenarioKind"] == "adversarial"

    assert [
             %{
               "id" => forged_genesis_id,
               "replica" => replica,
               "author" => issuer,
               "body" => [
                 "tuple",
                 [
                   ["atom", "genesis"],
                   ["delegation", forged_delegation],
                   ["map", _forged_policies]
                 ]
               ],
               "sig" => forged_op_sig
             },
             %{
               "id" => pristine_genesis_id,
               "replica" => replica,
               "author" => issuer,
               "body" => [
                 "tuple",
                 [
                   ["atom", "genesis"],
                   ["delegation", pristine_delegation],
                   ["map", _pristine_policies]
                 ]
               ],
               "sig" => pristine_op_sig
             }
           ] = vector["oracleCarrierOps"]

    assert replica == vector["replica"]
    assert forged_genesis_id < pristine_genesis_id
    assert forged_delegation["id"] == pristine_delegation["id"]
    assert Map.drop(forged_delegation, ["sig"]) == Map.drop(pristine_delegation, ["sig"])
    assert forged_delegation["sig"] != pristine_delegation["sig"]
    assert is_binary(forged_op_sig) and forged_op_sig != ""
    assert is_binary(pristine_op_sig) and pristine_op_sig != ""

    expected = vector["expectAtFullFrontier"]
    assert expected["state"]["clerk"] == "clerk"
    assert expected["authorityQuarantine"] == [[forged_genesis_id, "bad_delegation_sig"]]
    assert expected["winners"]["clerk"] == pristine_genesis_id
  end

  test "lattice.export_vectors pins a forged non-holder transfer to the Sim oracle" do
    out_dir =
      Path.join(
        System.tmp_dir!(),
        "lattice_forged_transfer_vectors_#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    vector =
      out_dir
      |> Path.join("township_authority_forged_transfer.json")
      |> File.read!()
      |> Jason.decode!()

    assert vector["generatedBy"] == "Lattice.Sim"
    assert vector["scenario"] == "township_authority_forged_transfer"
    assert vector["scenarioKind"] == "adversarial"

    ops = vector["ops"]

    assert [genesis] = Enum.filter(ops, &(&1["kind"] == "authority" and &1["author"] == "clerk"))

    assert [forged_transfer] =
             Enum.filter(ops, &(&1["kind"] == "authority" and &1["author"] == "mallory"))

    assert [mallory_command] =
             Enum.filter(ops, &(&1["kind"] == "command" and &1["author"] == "mallory"))

    assert [clerk_command] =
             Enum.filter(ops, &(&1["kind"] == "command" and &1["author"] == "clerk"))

    expected = vector["expectAtFullFrontier"]
    assert expected["state"]["clerk"] == "clerk"
    assert expected["state"]["clerk_locked"] == true

    assert expected["authorityQuarantine"] ==
             Enum.sort([
               [forged_transfer["id"], "transfer_not_holder"],
               [mallory_command["id"], "not_holder"]
             ])

    assert Enum.sort(expected["quarantine"]) ==
             Enum.sort([forged_transfer["id"], mallory_command["id"]])

    assert expected["winners"]["clerk"] == genesis["id"]
    assert expected["winners"]["clerk_locked"] == clerk_command["id"]
  end

  test "lattice.export_vectors pins an equivocating double transfer to the Sim oracle" do
    out_dir =
      Path.join(
        System.tmp_dir!(),
        "lattice_double_transfer_vectors_#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    vector =
      out_dir
      |> Path.join("township_authority_double_transfer.json")
      |> File.read!()
      |> Jason.decode!()

    assert vector["generatedBy"] == "Lattice.Sim"
    assert vector["scenario"] == "township_authority_double_transfer"
    assert vector["scenarioKind"] == "adversarial"

    authority_ops = Enum.filter(vector["ops"], &(&1["kind"] == "authority"))
    assert length(authority_ops) == 3

    assert [genesis] = Enum.filter(authority_ops, &(&1["deps"] == []))

    assert [first_transfer] =
             Enum.filter(authority_ops, &(&1["deps"] != [] and &1["value"] == "resident"))

    assert [second_transfer] =
             Enum.filter(authority_ops, &(&1["deps"] != [] and &1["value"] == "mallory"))

    assert first_transfer["deps"] == [genesis["id"]]
    assert second_transfer["deps"] == [genesis["id"]]
    assert first_transfer["id"] < second_transfer["id"]

    expected = vector["expectAtFullFrontier"]
    assert expected["state"]["clerk"] == "resident"
    assert expected["authorityQuarantine"] == [[second_transfer["id"], "double_transfer"]]
    assert expected["quarantine"] == [second_transfer["id"]]
    assert expected["winners"]["clerk"] == first_transfer["id"]
  end

  test "lattice.export_vectors pins an unattenuated transfer refusal to the Sim oracle" do
    out_dir =
      Path.join(
        System.tmp_dir!(),
        "lattice_unattenuated_transfer_vectors_#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    vector =
      out_dir
      |> Path.join("township_authority_unattenuated_transfer.json")
      |> File.read!()
      |> Jason.decode!()

    assert vector["generatedBy"] == "Lattice.Sim"
    assert vector["scenario"] == "township_authority_unattenuated_transfer"
    assert vector["scenarioKind"] == "adversarial"

    assert [genesis] =
             Enum.filter(vector["ops"], &(&1["kind"] == "authority" and &1["deps"] == []))

    assert [transfer] =
             Enum.filter(vector["ops"], &(&1["kind"] == "authority" and &1["deps"] != []))

    expected = vector["expectAtFullFrontier"]
    assert expected["state"]["clerk"] == "clerk"
    assert expected["authorityQuarantine"] == [[transfer["id"], "invalid_transfer"]]
    assert expected["quarantine"] == [transfer["id"]]
    assert expected["winners"]["clerk"] == genesis["id"]
  end

  test "lattice.export_vectors pins concurrent-append causal order to {height, op_id}" do
    out_dir =
      Path.join(
        System.tmp_dir!(),
        "lattice_causal_order_vectors_#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    vector =
      out_dir
      |> Path.join("township_causal_list_partition.json")
      |> File.read!()
      |> Jason.decode!()

    assert vector["generatedBy"] == "Lattice.Sim"
    assert vector["scenario"] == "township_causal_list_partition"
    assert vector["scenarioKind"] == "adversarial"

    posts =
      Enum.filter(vector["ops"], &(&1["field"] == "posts" and &1["mutation"] == "append"))

    assert length(posts) == 3

    resident_posts = Enum.filter(posts, &(&1["author"] == "resident"))

    assert [second_branch] =
             Enum.filter(resident_posts, fn post ->
               Enum.any?(resident_posts, &(&1["id"] in post["deps"]))
             end)

    assert [first_branch] = resident_posts -- [second_branch]
    assert [concurrent] = Enum.filter(posts, &(&1["author"] == "clerk"))

    assert first_branch["id"] < concurrent["id"]
    assert second_branch["id"] < concurrent["id"]

    expected = vector["expectAtFullFrontier"]
    assert expected["quarantine"] == []

    assert expected["state"]["posts"] == [
             "resident: first branch post",
             "clerk: concurrent post",
             "resident: second branch post"
           ]
  end

  test "lattice.export_vectors pins the dangling-dependency height base on a pruned log" do
    out_dir =
      Path.join(
        System.tmp_dir!(),
        "lattice_partial_log_vectors_#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    vector =
      out_dir
      |> Path.join("township_partial_log_lww.json")
      |> File.read!()
      |> Jason.decode!()

    assert vector["generatedBy"] == "Lattice.Sim"
    assert vector["scenario"] == "township_partial_log_lww"
    assert vector["scenarioKind"] == "adversarial"

    ops = vector["ops"]
    op_ids = MapSet.new(ops, & &1["id"])

    assert [bridge] = Enum.filter(ops, &(&1["kind"] == "inbox"))
    assert [pruned_dep] = bridge["deps"]
    refute MapSet.member?(op_ids, pruned_dep)

    summaries =
      Enum.filter(ops, &(&1["field"] == "summary" and &1["mutation"] == "write"))

    assert [pruned_branch] = Enum.filter(summaries, &(bridge["id"] in &1["deps"]))
    assert [root_branch] = summaries -- [pruned_branch]
    assert root_branch["id"] > pruned_branch["id"]

    expected = vector["expectAtFullFrontier"]
    assert expected["quarantine"] == []
    assert expected["state"]["summary"] == "summary from the surviving root"
    assert expected["state"]["title"] == ""
    assert expected["winners"]["summary"] == root_branch["id"]
  end

  test "lattice.export_vectors writes a real-carrier Township W1 vector for the TS client" do
    out_dir =
      Path.join(
        System.tmp_dir!(),
        "lattice_carrier_vectors_#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf(out_dir) end)

    Mix.Task.clear()
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", out_dir])

    vector_path = Path.join(out_dir, "township_carrier_w1.json")
    assert File.exists?(vector_path)

    vector = vector_path |> File.read!() |> Jason.decode!()

    assert vector["scenario"] == "township_carrier_w1"
    assert vector["scenarioKind"] == "carrier"
    assert vector["generatedBy"] == "Lattice.Sim"
    assert vector["client"]["realm"] == "resident"
    assert vector["peer"]["realm"] == "clerk"

    assert length(vector["clientBaseCarrierOps"]) >= 4
    assert length(vector["clientDivergedCarrierOps"]) > length(vector["clientBaseCarrierOps"])

    [first_op | _] = vector["clientBaseCarrierOps"]
    assert %{"v" => 1, "id" => _, "body" => _, "sig" => _} = first_op

    expected = vector["expectAfterSync"]
    assert is_binary(expected["stateB64"])
    assert length(expected["opIds"]) == length(vector["oracleCarrierOps"])
    assert expected["authorityQuarantine"] != []

    assert %{
             "carrierOp" => %{
               "v" => 1,
               "id" => unsound_grant_id,
               "kind" => "authority",
               "body" => ["tuple", [["atom", "grant"], ["delegation", _delegation]]]
             },
             "parentDelegationId" => parent_delegation_id,
             "authorityQuarantine" => unsound_authority_quarantine
           } = vector["authorityUnsoundGrant"]

    assert is_binary(parent_delegation_id)
    assert [unsound_grant_id, "not_attenuated"] in unsound_authority_quarantine

    assert %{
             "delegationId" => revoked_delegation_id,
             "preRevokeCommandId" => pre_revoke_command_id,
             "revokeOp" => %{
               "id" => revoke_id,
               "kind" => "authority",
               "body" => revoke_body,
               "cap" => ["nil"]
             },
             "revokedCommandOp" => %{
               "id" => revoked_command_id,
               "kind" => "command",
               "body" => revoked_command_body,
               "cap" => revoked_command_cap
             },
             "authorityQuarantine" => revocation_authority_quarantine,
             "stateB64" => revocation_state_b64,
             "opIds" => revocation_op_ids
           } = vector["authorityRevocation"]

    assert revoked_delegation_id == parent_delegation_id

    assert revoke_body == [
             "tuple",
             [["atom", "revoke"], ["bin", Base.encode64(revoked_delegation_id)]]
           ]

    assert revoked_command_body == [
             "tuple",
             [
               ["atom", "post"],
               ["list", [["bin", Base.encode64("resident: attempted after revocation")]]]
             ]
           ]

    assert revoked_command_cap == ["bin", Base.encode64(revoked_delegation_id)]

    refute Enum.any?(expected["authorityQuarantine"], fn [id, _reason] ->
             id == pre_revoke_command_id
           end)

    assert [revoked_command_id, "revoked_capability"] in revocation_authority_quarantine
    assert revocation_state_b64 == expected["stateB64"]
    assert revoke_id in revocation_op_ids
    assert revoked_command_id in revocation_op_ids
    assert length(revocation_op_ids) == length(expected["opIds"]) + 2

    assert %{
             "delegationId" => bad_revoke_delegation_id,
             "revokeOp" => %{
               "id" => bad_revoke_id,
               "kind" => "authority",
               "body" => bad_revoke_body,
               "cap" => ["nil"]
             },
             "postRevokeCommandOp" => %{
               "id" => bad_revoke_command_id,
               "kind" => "command",
               "body" => bad_revoke_command_body,
               "cap" => bad_revoke_command_cap
             },
             "authorityQuarantine" => bad_revoke_authority_quarantine,
             "stateB64" => bad_revoke_state_b64,
             "opIds" => bad_revoke_op_ids
           } = vector["authorityBadRevocation"]

    assert bad_revoke_delegation_id == parent_delegation_id

    assert bad_revoke_body == [
             "tuple",
             [["atom", "revoke"], ["bin", Base.encode64(bad_revoke_delegation_id)]]
           ]

    assert bad_revoke_command_body == [
             "tuple",
             [
               ["atom", "post"],
               ["list", [["bin", Base.encode64("resident: post after unauthorized revoke")]]]
             ]
           ]

    assert bad_revoke_command_cap == ["bin", Base.encode64(bad_revoke_delegation_id)]
    assert [bad_revoke_id, "unauthorized_revoke"] in bad_revoke_authority_quarantine

    refute Enum.any?(bad_revoke_authority_quarantine, fn [id, _reason] ->
             id == bad_revoke_command_id
           end)

    refute bad_revoke_state_b64 == expected["stateB64"]
    assert bad_revoke_id in bad_revoke_op_ids
    assert bad_revoke_command_id in bad_revoke_op_ids
    assert length(bad_revoke_op_ids) == length(expected["opIds"]) + 2

    assert length(vector["canonicalOps"]) == length(vector["oracleCarrierOps"])

    [canonical | _] = vector["canonicalOps"]
    assert canonical["suite"] == "lattice-cbor-v1"
    assert is_binary(canonical["id"])
    assert is_binary(canonical["bytesHex"])
    assert canonical["hash"] == canonical["id"]
  end

  test "CI regenerates TS vectors and runs client conformance" do
    workflow =
      "../../../../.github/workflows/flagship.yml"
      |> Path.expand(__DIR__)
      |> File.read!()

    assert workflow =~ "mix lattice.export_vectors --out clients/lattice-client/test/vectors"
    assert workflow =~ "working-directory: clients/lattice-client"
    assert workflow =~ "npm run typecheck"
    assert workflow =~ "npm run conformance"
    assert workflow =~ "npm run canonical"
    assert workflow =~ "npm run carrier:township"
    assert workflow =~ "npm run carrier:township:live"
  end

  defp read_vector!(out_dir, scenario) do
    path = Path.join(out_dir, "#{scenario}.json")
    assert File.exists?(path), "missing Sim-exported capability vector #{scenario}"
    path |> File.read!() |> Jason.decode!()
  end

  defp carrier_op!(vector, id) do
    assert %{} = op = Enum.find(vector["oracleCarrierOps"], &(&1["id"] == id))
    op
  end
end
