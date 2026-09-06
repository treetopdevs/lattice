defmodule TownshipWeb.InstrumentSourceTest do
  use ExUnit.Case, async: true

  alias Lattice.{Identity, Log, Op, Sim}
  alias Township.{AuditBundle, Matter}
  alias TownshipWeb.InstrumentSource

  @repo_root Path.expand("../../../..", __DIR__)
  @tracked_dir Path.join(@repo_root, "artifacts/township")

  test "loads the instrument model only from a verified bundle" do
    assert {:ok, payload} = InstrumentSource.load(bundle_dir: @tracked_dir)

    assert payload.read_model.threads.title == "Zoning variance #24"
    assert payload.read_model.threads.summary == "Leaning approve (clerk edit)"
    assert payload.read_model.members.current == ["clerk", "resident"]
    assert payload.read_model.members.denied == []
    assert payload.read_model.roles.reasons |> Map.values() |> Enum.uniq() == [:not_holder]

    assert payload.read_model.attest == %{
             tally: %{outcome: :approve, counts: %{approve: 2, reject: 1}},
             receipt_free?: false,
             status: :stubbed
           }

    assert payload.provenance.verified == true
    assert payload.provenance.verification == :bundle_signatures
    assert payload.provenance.schema == "township-audit-bundle-v1"
    assert payload.provenance.bundle_dir == Path.expand(@tracked_dir)

    assert payload.provenance.matter_sha256 ==
             "f41566fd3ea93e6394c27e78fda04e7d55fe7a002f18a8cfe8d1cdc5754ce125"

    assert payload.causal_replay["schema"] == "township-causal-replay-v1"
    assert length(payload.causal_replay["frames"]) == 13

    assert List.last(payload.causal_replay["frames"])["state"] == %{
             "title" => "Zoning variance #24",
             "summary" => "Leaning approve (clerk edit)",
             "posts" => [
               "resident: I'll attend",
               "clerk: hearing Tuesday 6pm",
               "resident: posted while offline"
             ],
             "members" => ["clerk", "resident"],
             "clerk_locked" => true
           }
  end

  @tag :tmp_dir
  test "refuses a forged log even when every bundle projection was regenerated", %{tmp_dir: dir} do
    sim =
      Sim.new(Matter, "replica:matter:forged-instrument", ["clerk"], seed: "forged-instrument")

    {sim, _} = Sim.create_replica(sim, "clerk")
    {sim, post} = Sim.command(sim, "clerk", :post, ["forged post"])
    log = Sim.log(sim, "clerk")
    forged = %{post | sig: <<0::512>>}
    log = %{log | ops: Map.put(log.ops, forged.id, forged)}
    assert {:ok, _} = AuditBundle.write(dir, log)

    assert {:error, {:bundle_unverified, errors}} = InstrumentSource.load(bundle_dir: dir)
    assert Enum.any?(errors, &String.contains?(&1, forged.id))
  end

  test "refuses missing and corrupted bundles" do
    missing =
      Path.join(System.tmp_dir!(), "township_missing_#{System.unique_integer([:positive])}")

    assert {:error, {:bundle_unverified, missing_errors}} =
             InstrumentSource.load(bundle_dir: missing)

    assert Enum.any?(missing_errors, &String.contains?(&1, "cannot list bundle"))

    corrupt =
      Path.join(System.tmp_dir!(), "township_corrupt_#{System.unique_integer([:positive])}")

    on_exit(fn -> File.rm_rf(corrupt) end)
    File.cp_r!(@tracked_dir, corrupt)
    File.write!(Path.join(corrupt, "state.json"), ~s({"title":"forged"}))

    assert {:error, {:bundle_unverified, corrupt_errors}} =
             InstrumentSource.load(bundle_dir: corrupt)

    assert "state.json mismatch" in corrupt_errors
  end

  @tag :tmp_dir
  test "uses the captured verified log when its file changes before projection verification finishes",
       %{tmp_dir: tmp_dir} do
    dir = Path.join(tmp_dir, "bundle")
    sim = Sim.new(Matter, "replica:matter:snapshot", ["clerk"], seed: "instrument-snapshot")
    {sim, _} = Sim.create_replica(sim, "clerk")
    {sim, post} = Sim.command(sim, "clerk", :post, ["verified post"])
    log = Sim.log(sim, "clerk")
    assert {:ok, _} = AuditBundle.write(dir, log)
    matter_path = Path.join(dir, "matter.log")
    verified_hash = :crypto.hash(:sha256, File.read!(matter_path)) |> Base.encode16(case: :lower)

    # A real filesystem boundary pauses verification after its log read. This is
    # deterministic: opening the FIFO writer requires the verifier to open its reader.
    projection_path = Path.join(dir, "trust_graph.mermaid")
    projection_bytes = File.read!(projection_path)
    File.rm!(projection_path)
    assert {_, 0} = System.cmd("mkfifo", [projection_path])
    caller = self()

    writer =
      Task.async(fn ->
        {:ok, file} = File.open(projection_path, [:write, :binary, :raw])
        send(caller, {:projection_open, self()})

        receive do
          :finish ->
            :file.write(file, projection_bytes)
            :file.close(file)
        after
          10_000 -> :file.close(file)
        end
      end)

    loader = Task.async(fn -> InstrumentSource.load(bundle_dir: dir) end)
    assert_receive {:projection_open, writer_pid}, 10_000

    attacker = Identity.from_seed("attacker", <<93::256>>)

    forged =
      Op.new(attacker, post.replica, post.deps, :command, {:post, ["substituted post"]},
        cap: post.cap
      )

    forged = %{forged | author: post.author}
    forged = %{forged | id: Op.recompute_id(forged)}

    forged_log =
      Log.from_ops(log.replica, log.ops |> Map.delete(post.id) |> Map.put(forged.id, forged))

    # Raw IO keeps the attacker independent of the verifier's blocked file server.
    {:ok, replacement} = :file.open(matter_path, [:write, :binary, :raw])
    :ok = :file.write(replacement, :erlang.term_to_binary({:lattice_log_dump_v1, forged_log}))
    :ok = :file.close(replacement)
    send(writer_pid, :finish)
    Task.await(writer, 10_000)

    assert {:ok, payload} = Task.await(loader, 10_000)
    assert payload.read_model.threads.posts == ["verified post"]
    assert payload.provenance.matter_sha256 == verified_hash
    assert payload.provenance.frontier == [post.id]
  end
end
