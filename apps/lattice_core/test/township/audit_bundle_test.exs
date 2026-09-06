defmodule Township.AuditBundleTest do
  use ExUnit.Case, async: false

  alias Lattice.{Identity, Log, Op, Sim}
  alias Township.{AuditBundle, Matter}

  @moduletag timeout: 120_000

  @repo_root Path.expand("../../../..", __DIR__)
  @tracked_dir Path.join(@repo_root, "artifacts/township")
  @bundle_files [
    "audit.json",
    "manifest.json",
    "matter.log",
    "op_dag.json",
    "state.json",
    "trust_graph.dot",
    "trust_graph.mermaid"
  ]

  test "rejects a self-consistent bundle whose post impersonates its declared author" do
    dir = Path.join(System.tmp_dir!(), "township_forged_#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(dir) end)
    sim = Sim.new(Matter, "replica:matter:restore", ["clerk"], seed: "bundle-authenticity")
    {sim, _} = Sim.create_replica(sim, "clerk")
    {sim, post} = Sim.command(sim, "clerk", :post, ["forged clerk post"])
    log = Sim.log(sim, "clerk")
    assert {:ok, _} = AuditBundle.write(dir, log)
    assert :ok = AuditBundle.verify(dir)

    attacker = Identity.from_seed("attacker", <<91::256>>)
    forged = Op.new(attacker, post.replica, post.deps, :command, post.body, cap: post.cap)
    forged = %{forged | author: post.author}
    forged = %{forged | id: Op.recompute_id(forged)}
    refute Op.valid?(forged)

    forged_log =
      Log.from_ops(log.replica, log.ops |> Map.delete(post.id) |> Map.put(forged.id, forged))

    # Regenerate every projection too: consistency alone must not verify this forgery.
    assert {:ok, _} = AuditBundle.write(dir, forged_log)

    assert Jason.decode!(File.read!(Path.join(dir, "state.json")))["posts"] ==
             ["forged clerk post"]

    assert {:error, errors} = AuditBundle.verify(dir)
    assert Enum.any?(errors, &String.contains?(&1, forged.id))
  end

  @tag :tmp_dir
  test "authentic accepted history with rejected-signature evidence still verifies", %{
    tmp_dir: dir
  } do
    sim = Sim.new(Matter, "replica:matter:quarantine", ["clerk"], seed: "bundle-quarantine")
    {sim, _} = Sim.create_replica(sim, "clerk")
    {sim, post} = Sim.command(sim, "clerk", :post, ["accepted post"])
    log = Sim.log(sim, "clerk")
    rejected = %{post | body: {:post, ["rejected post"]}, sig: <<0::512>>}
    rejected = %{rejected | id: Op.recompute_id(rejected)}
    {:quarantined, log, :bad_signature} = Log.accept(log, rejected)

    assert {:ok, _} = AuditBundle.write(dir, log)
    assert :ok = AuditBundle.verify(dir)
    assert {:ok, snapshot} = AuditBundle.load_verified(dir)
    assert snapshot.log.quarantine == log.quarantine
  end

  @tag :tmp_dir
  test "malformed log bytes and serialized structures return bundle errors", %{tmp_dir: tmp_dir} do
    dir = Path.join(tmp_dir, "bundle")
    File.cp_r!(@tracked_dir, dir)
    path = Path.join(dir, "matter.log")
    assert {:ok, log} = Log.restore(path)

    for bytes <- [
          "corrupted dump",
          :erlang.term_to_binary({:lattice_log_dump_v1, %{log | ops: []}}),
          :erlang.term_to_binary({:lattice_log_dump_v1, %{log | ops: %{"broken" => :invalid}}})
        ] do
      File.write!(path, bytes)
      assert {:error, [_ | _]} = AuditBundle.verify(dir)
    end
  end

  test "fresh processes emit and independently verify the outsider audit bundle" do
    out_dir =
      Path.join(System.tmp_dir!(), "township_audit_bundle_#{System.unique_integer([:positive])}")

    on_exit(fn -> File.rm_rf(out_dir) end)
    tracked_before = directory_snapshot(@tracked_dir)

    {demo_output, demo_status} =
      run_mix(
        ["run", "--no-compile", "--no-deps-check", "scripts/township_demo.exs"],
        [{"TOWNSHIP_ARTIFACTS_DIR", out_dir}]
      )

    assert demo_status == 0, demo_output
    assert File.dir?(out_dir), "demo did not honor TOWNSHIP_ARTIFACTS_DIR:\n#{demo_output}"
    assert Enum.sort(File.ls!(out_dir)) == @bundle_files
    assert directory_snapshot(@tracked_dir) == tracked_before

    for file <- @bundle_files do
      assert File.read!(Path.join(out_dir, file)) == Map.fetch!(tracked_before, file)
    end

    state = out_dir |> Path.join("state.json") |> File.read!() |> Jason.decode!()
    assert state["title"] == "Zoning variance #24"
    assert state["summary"] == "Leaning approve (clerk edit)"
    assert state["members"] == ["clerk", "resident"]
    assert state["clerk_locked"] == true
    assert length(state["posts"]) == 3

    audit = out_dir |> Path.join("audit.json") |> File.read!() |> Jason.decode!()
    assert length(audit["quarantine"]) == 1
    assert Map.fetch!(audit["reasons"], hd(audit["quarantine"])) == "not_holder"

    op_dag = out_dir |> Path.join("op_dag.json") |> File.read!() |> Jason.decode!()

    assert String.starts_with?(
             op_dag["replica"],
             "replica:matter:zoning-variance-24#root:"
           )

    assert length(op_dag["nodes"]) > 10
    assert Enum.any?(op_dag["nodes"], &(&1["status"] == "quarantined"))
    assert op_dag["frontier"] != []

    manifest = out_dir |> Path.join("manifest.json") |> File.read!() |> Jason.decode!()
    assert manifest["schema"] == "township-audit-bundle-v1"
    assert Enum.sort(Map.values(manifest["labels"])) == ["clerk", "resident"]

    {verify_output, verify_status} =
      run_mix(["lattice.township.verify_bundle", "--dir", out_dir])

    assert verify_status == 0, verify_output
    assert verify_output =~ "Township audit bundle verified"

    audit_path = Path.join(out_dir, "audit.json")
    clean_audit = File.read!(audit_path)
    audit = Jason.decode!(clean_audit)

    File.write!(
      audit_path,
      Jason.encode!(%{audit | "quarantine" => ["tampered-op"]}, pretty: true)
    )

    {audit_output, audit_status} =
      run_mix(["lattice.township.verify_bundle", "--dir", out_dir])

    assert audit_status != 0
    assert audit_output =~ "audit.json"
    File.write!(audit_path, clean_audit)

    manifest_path = Path.join(out_dir, "manifest.json")
    clean_manifest = File.read!(manifest_path)
    [{fingerprint, label} | rest] = Enum.sort(manifest["labels"])

    changed_labels =
      Map.new([{fingerprint, label <> " altered"} | rest])

    File.write!(
      manifest_path,
      Jason.encode!(%{manifest | "labels" => changed_labels}, pretty: true)
    )

    {label_output, label_status} =
      run_mix(["lattice.township.verify_bundle", "--dir", out_dir])

    assert label_status != 0
    assert label_output =~ "trust_graph"
    refute label_output =~ "state.json"
    refute label_output =~ "audit.json"
    refute label_output =~ "op_dag.json"

    invalid_labels = Map.put(manifest["labels"], fingerprint, "clerk\nmalicious")

    File.write!(
      manifest_path,
      Jason.encode!(%{manifest | "labels" => invalid_labels}, pretty: true)
    )

    {invalid_label_output, invalid_label_status} =
      run_mix(["lattice.township.verify_bundle", "--dir", out_dir])

    assert invalid_label_status != 0
    assert invalid_label_output =~ "manifest labels"

    File.write!(manifest_path, clean_manifest)
    File.write!(Path.join(out_dir, "unexpected.txt"), "not part of the contract")

    {extra_output, extra_status} =
      run_mix(["lattice.township.verify_bundle", "--dir", out_dir])

    assert extra_status != 0
    assert extra_output =~ "bundle file set mismatch"
    assert extra_output =~ "unexpected.txt"
  end

  test "Plan 121 records the named outsider-replay gate without claiming UI completion" do
    plan =
      File.read!(Path.join(@repo_root, "plans/121-township-outsider-replay-audit-bundle-g1.md"))

    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ "mix lattice.township.verify_bundle --dir"
    assert plan =~ "deterministic external term encoding"
    assert plan =~ "does not build Phoenix, LiveView, Vue"

    assert build_map =~ ~r/Plan 121 adds the\s+outsider-replayable Township audit bundle/
    assert build_map =~ "lattice.township.verify_bundle"
    assert build_map =~ "plans 023-133"
    assert build_map =~ "Phase G's audit surface is implemented by Plan 121"

    assert plans_index =~
             "| 121 | Township outsider-replay audit bundle | P1 | M | 012, 017 | DONE |"
  end

  defp run_mix(args, extra_env \\ []) do
    System.cmd(mix_executable(), args,
      cd: @repo_root,
      env: [{"MIX_ENV", "test"} | extra_env],
      stderr_to_stdout: true
    )
  end

  defp mix_executable do
    asdf_mix = Path.expand("~/.asdf/shims/mix")

    cond do
      File.exists?(asdf_mix) -> asdf_mix
      mix = System.find_executable("mix") -> mix
      true -> raise "mix executable not found"
    end
  end

  defp directory_snapshot(dir) do
    dir
    |> File.ls!()
    |> Enum.sort()
    |> Map.new(fn name -> {name, File.read!(Path.join(dir, name))} end)
  end
end
