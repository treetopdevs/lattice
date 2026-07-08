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
