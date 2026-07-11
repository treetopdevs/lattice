defmodule TownshipWeb.InstrumentSourceTest do
  use ExUnit.Case, async: true

  alias TownshipWeb.InstrumentSource
  alias TownshipWeb.VerifiedInstrumentSnapshot

  @repo_root Path.expand("../../../..", __DIR__)
  @tracked_dir Path.join(@repo_root, "artifacts/township")

  test "loads the instrument model only from a verified bundle" do
    assert {:ok, %VerifiedInstrumentSnapshot{} = payload} =
             InstrumentSource.load(bundle_dir: @tracked_dir)

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
    assert payload.provenance.schema == "township-audit-bundle-v1"
    assert payload.provenance.bundle_dir == Path.expand(@tracked_dir)

    assert payload.provenance.matter_sha256 ==
             "df911bb13013abefab7af103992fd1413eb754989ecf74f26cedb9e8ef6d17d3"

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
end
