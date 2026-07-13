defmodule Township.ExportVectorsTest do
  use ExUnit.Case, async: false

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
end
