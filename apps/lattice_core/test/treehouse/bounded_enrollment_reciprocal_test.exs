defmodule Treehouse.BoundedEnrollmentReciprocalTest do
  use ExUnit.Case, async: false

  alias Lattice.{Authority, Log, Op, Sync}
  alias Lattice.Carrier.Wire
  alias Treehouse.{ReadModel, Space, Thread}

  test "TypeScript bounded enrollment and member refusals agree with verified BEAM replay and restore" do
    root = Path.expand("../../../..", __DIR__)
    client = Path.join(root, "clients/lattice-client")

    artifact =
      Path.join(
        System.tmp_dir!(),
        "bounded-enrollment-#{System.unique_integer([:positive])}.json"
      )

    on_exit(fn -> File.rm(artifact) end)

    {output, status} =
      System.cmd(
        Path.join(client, "node_modules/.bin/tsx"),
        ["test/treehouse_bounded_enrollment.ts"],
        cd: client,
        env: [{"TREEHOUSE_BOUNDED_ENROLLMENT_ARTIFACT", artifact}],
        stderr_to_stdout: true
      )

    assert status == 0, output
    captured = artifact |> File.read!() |> Jason.decode!()
    assert length(captured["logs"]) == 4

    [space_entry, thread_entry | _] = captured["logs"]
    assert hd(space_entry["frames"])["author"] != hd(thread_entry["frames"])["author"]

    for entry <- captured["logs"] do
      module = if entry["product"] == "Treehouse.Space", do: Space, else: Thread
      Code.ensure_loaded!(module)
      assert {:bounded, _} = Authority.Continuation.family(entry["replica"])
      assert {:ok, ops} = Wire.decode_ops(entry["frames"])
      assert Enum.all?(ops, &Op.valid?/1)
      # Reverse delivery exercises dependency buffering rather than assuming exported order.
      {log, report} = Sync.deliver(Log.new(entry["replica"]), Enum.reverse(ops))
      assert report.pending == []
      assert map_size(Log.ops(log)) == length(ops)

      reasons =
        Map.new(Authority.analyze(module, log).reasons, fn {id, reason} ->
          {id, Atom.to_string(reason)}
        end)

      assert reasons == entry["reasons"]
      view = ReadModel.observe(module, log)

      if module == Thread do
        assert {:ok, selected} = Authority.continuation_profile(log)
        assert selected.profile.kind == :thread
        assert selected.profile.role == :moderator
        {:ok, pin} = Log.fetch(log, selected.profile_genesis)
        {:genesis, empty, policies} = pin.body

        assert MapSet.size(empty.ops) == 0 and MapSet.size(empty.roles) == 0 and
                 empty.live == false

        assert policies.__beacon__.mode == :witnessed
        assert policies.__beacon__.witnesses == selected.profile.witnesses
        assert policies.__beacon__.threshold == selected.profile.threshold
        assert policies.__beacon__.max_epoch_step == 1
        [genesis | _] = ops
        assert {:genesis, _, root_policies} = genesis.body
        assert root_policies == %{}

        assert view.state.title == entry["state"]["title"]
        assert Enum.map(view.posts, & &1.text) == entry["state"]["posts"]
        assert Enum.map(view.posts, & &1.id) == captured["postIds"]
      else
        assert Enum.to_list(view.state.members) == entry["state"]["members"]
      end

      path = artifact <> "-#{System.unique_integer([:positive])}.log"

      try do
        assert :ok = Log.dump(log, path)
        assert {:ok, %{log: restored}} = Log.restore_verified(path)
        assert Log.ops(restored) == Log.ops(log)

        assert Authority.analyze(module, restored).reasons ==
                 Authority.analyze(module, log).reasons

        assert ReadModel.observe(module, restored) == view
      after
        File.rm(path)
      end
    end
  end
end
