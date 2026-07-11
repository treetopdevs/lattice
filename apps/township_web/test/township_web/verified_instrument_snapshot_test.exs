defmodule TownshipWeb.VerifiedInstrumentSnapshotTest do
  use ExUnit.Case, async: true

  alias TownshipWeb.VerifiedInstrumentSnapshot

  @repo_root Path.expand("../../../..", __DIR__)
  @tracked_dir Path.join(@repo_root, "artifacts/township")

  test "builds every instrument projection from one verified bundle log" do
    assert {:ok, snapshot} = VerifiedInstrumentSnapshot.load_bundle(@tracked_dir)
    assert %VerifiedInstrumentSnapshot{} = snapshot

    assert snapshot.provenance.verified
    assert snapshot.op_counts == %{total: 13, honored: 12, quarantined: 1}

    final_frame = List.last(snapshot.causal_replay["frames"])
    assert final_frame["state"]["title"] == snapshot.read_model.threads.title
    assert final_frame["state"]["summary"] == snapshot.read_model.threads.summary

    assert final_frame["visible_ids"] ==
             snapshot.read_model.op_dag.nodes |> Enum.map(& &1.id) |> Enum.sort()
  end
end
