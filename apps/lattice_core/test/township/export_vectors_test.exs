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
end
