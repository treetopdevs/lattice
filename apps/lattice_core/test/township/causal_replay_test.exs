defmodule Township.CausalReplayTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Lattice.{Log, Sync}
  alias Township.ReadModel

  @repo_root Path.expand("../../../..", __DIR__)
  @matter_path Path.join(@repo_root, "artifacts/township/matter.log")

  @genesis_id "3gisahML791TEKkKa56M2GSxknsj60ZgHgEl-GIO9rs"
  @title_id "DRY-4q7GFxpqrYkTFBCx01euInBkxYgizXDCN04iF5w"
  @clerk_summary_id "fV5jo4D85m4rdAhRiXIrAikFOyJ4uqMHa-Pu3kAlhrE"
  @resident_summary_id "oknDOSWoyjrt4GRLkdM7BvMSGlKiVbtblTCMse78zJI"
  @close_id "ztN26_jxZLEr6daSuCI5RxrMnxscZkEJnbiAXZ03VQY"
  @transfer_id "VPKcWvKKBA8zJ5xLSpBQg5-Furs32eieQ4k0eRX5jI8"
  @stale_reopen_id "mVp4COeiXTD__9c6y-OfO406aHuMZFDT3ahLtFZvLag"

  setup_all do
    preload_lattice_core()
    :ok
  end

  test "replay exposes JSON-safe reducer frames without projecting terminal verdicts backward" do
    log = tracked_log()
    replay = ReadModel.replay(log)

    assert replay["schema"] == "township-causal-replay-v1"
    assert length(replay["nodes"]) == 13
    assert length(replay["frames"]) == 13
    assert Jason.decode!(Jason.encode!(replay)) == replay

    assert hd(replay["frames"]) == %{
             "index" => 0,
             "head" => @genesis_id,
             "visible_ids" => [@genesis_id],
             "frontier" => [@genesis_id],
             "state" => %{
               "title" => "",
               "summary" => "",
               "posts" => [],
               "members" => [],
               "clerk_locked" => false
             },
             "holders" => %{"clerk" => "r9qi1OBHt24b"},
             "quarantine" => %{}
           }

    before_stale = Enum.at(replay["frames"], -2)
    final = List.last(replay["frames"])

    assert before_stale["head"] == @transfer_id
    assert before_stale["quarantine"] == %{}
    assert before_stale["state"]["clerk_locked"] == true
    refute @stale_reopen_id in before_stale["visible_ids"]

    assert final["index"] == 12
    assert final["head"] == @stale_reopen_id
    assert final["frontier"] == [@stale_reopen_id]
    assert final["visible_ids"] == log |> Log.op_ids() |> Enum.sort()
    assert final["quarantine"] == %{@stale_reopen_id => "not_holder"}

    assert final["state"] == %{
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

    assert final["holders"] == %{"clerk" => "xI19LiI0w767"}

    observed = ReadModel.observe(log)
    assert final["state"] == observed_state(observed)
    assert final["holders"] == stringify_holders(observed.roles.holders)
    assert final["quarantine"] == stringify_reasons(observed.roles.reasons)
  end

  test "replay attributes fields through structured command mutations" do
    replay = tracked_log() |> ReadModel.replay()
    nodes = Map.new(replay["nodes"], &{&1["id"], &1})
    fields = Map.new(replay["fields"], &{&1["id"], &1["writers"]})

    assert nodes[@genesis_id]["field"] == nil
    assert nodes[@transfer_id]["field"] == nil
    assert nodes[@title_id]["field"] == "title"
    assert nodes[@clerk_summary_id]["field"] == "summary"
    assert nodes[@resident_summary_id]["field"] == "summary"
    assert nodes[@close_id]["field"] == "clerk_locked"
    assert nodes[@stale_reopen_id]["field"] == "clerk_locked"

    assert fields["title"] == [@title_id]
    assert fields["summary"] == [@clerk_summary_id, @resident_summary_id]
    assert fields["clerk_locked"] == [@close_id, @stale_reopen_id]
  end

  property "replay is byte-identical after arbitrary delivery order" do
    source = tracked_log()
    ops = Log.topo_ops(source)
    expected = ReadModel.replay(source)
    expected_json = Jason.encode!(expected)

    check all(priorities <- fixed_list(Enum.map(ops, fn _op -> integer() end)), max_runs: 24) do
      shuffled =
        ops
        |> Enum.zip(priorities)
        |> Enum.sort_by(fn {op, priority} -> {priority, op.id} end)
        |> Enum.map(&elem(&1, 0))

      {delivered, report} = Sync.deliver(Log.new(source.replica), shuffled)

      assert report.pending == []
      assert ReadModel.replay(delivered) == expected
      assert delivered |> ReadModel.replay() |> Jason.encode!() == expected_json
    end
  end

  defp tracked_log do
    assert {:ok, log} = Log.restore(@matter_path)
    log
  end

  defp observed_state(observed) do
    %{
      "title" => observed.threads.title,
      "summary" => observed.threads.summary,
      "posts" => observed.threads.posts,
      "members" => observed.members.current,
      "clerk_locked" => observed.threads.clerk_locked?
    }
  end

  defp stringify_holders(holders) do
    Map.new(holders, fn {role, holder} -> {Atom.to_string(role), holder} end)
  end

  defp stringify_reasons(reasons) do
    Map.new(reasons, fn {id, reason} -> {id, Atom.to_string(reason)} end)
  end

  defp preload_lattice_core do
    :lattice_core
    |> Application.spec(:modules)
    |> Enum.each(&Code.ensure_loaded/1)
  end
end
