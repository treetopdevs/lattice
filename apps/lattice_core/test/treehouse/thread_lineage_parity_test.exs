defmodule Treehouse.ThreadLineageParityTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Log, Op, Sim}
  alias Lattice.Carrier.Wire

  @client Path.expand("../../../../clients/lattice-client", __DIR__)

  test "malformed edits cannot supply lineage targets to descendants" do
    {output, 0} =
      System.cmd("node", ["--import", "tsx", "test/support/thread_lineage_peer.ts"], cd: @client)

    cases = Jason.decode!(output)["cases"]
    assert length(cases) >= 14

    for c <- cases, frames <- [c["frames"], Enum.reverse(c["frames"])] do
      {:ok, ops} = Wire.decode_ops(frames)
      assert Enum.all?(ops, &Op.valid?/1)
      log = Log.from_ops(c["replica"], Map.new(ops, &{&1.id, &1}))
      :ok = Log.verify_authenticity(log)
      analysis = Authority.analyze(Treehouse.Thread, log)

      actual =
        Map.new(Enum.filter(ops, &(&1.kind == :command)), fn op ->
          {op.id, analysis.reasons[op.id] && Atom.to_string(analysis.reasons[op.id])}
        end)

      assert actual == c["reasons"], c["name"]
      result = reduction(log)

      for key <- ["posts", "state", "quarantine", "order"] do
        assert result[key] == c[key], "#{c["name"]}: #{key}"
      end
    end
  end

  @tag :tmp_dir
  test "TypeScript independently consumes fresh BEAM malformed lineage histories", %{tmp_dir: dir} do
    instance = :crypto.hash(:sha256, "beam-thread-lineage") |> Base.url_encode64(padding: false)
    replica = "replica:treehouse:thread:#{instance}#authority:bounded-continuation-v1"

    {sim, _} =
      Treehouse.Thread
      |> Sim.new(replica, ["root", "other"], seed: "beam-lineage")
      |> Sim.create_replica("root")

    {sim, post} = Sim.command(sim, "root", :post, ["original"])

    histories =
      for value <- [7, nil, []],
          previous <- [post.id, "absent"],
          command <- [:author_edit, :author_tombstone, :moderator_tombstone] do
        {candidate, malformed} =
          Sim.command(sim, "root", :author_edit, [post.id, previous, value])

        args =
          [post.id, malformed.id] ++ if(command == :author_edit, do: ["descendant"], else: [])

        {candidate, descendant} = Sim.command(candidate, "root", command, args)

        assert {true, :malformed_command} == Sim.quarantined(candidate, "root", malformed.id)

        assert {true, :application_target_quarantined} ==
                 Sim.quarantined(candidate, "root", descendant.id)

        candidate
      end

    {valid, edit} = Sim.command(sim, "root", :author_edit, [post.id, post.id, "valid"])
    {valid, _} = Sim.command(valid, "root", :author_edit, [post.id, edit.id, "latest"])
    {missing, prior} = Sim.command(sim, "root", :author_edit, [post.id, "absent", "valid"])

    {missing, _} =
      Sim.command(missing, "root", :author_edit, [post.id, prior.id, "still traverses"])

    {bom, _} = Sim.command(sim, "root", :post, ["\uFEFFretained text"])
    {bom_target, _} = Sim.command(sim, "root", :author_tombstone, ["\uFEFF" <> post.id, post.id])
    {wrong, _} = Sim.grant(sim, "root", "other", ops: [:author_edit])
    wrong = Sim.sync_all(wrong)

    {wrong, predecessor} =
      Sim.command(wrong, "other", :author_edit, [post.id, post.id, "forged"])

    wrong = Sim.sync_all(wrong)

    {wrong, descendant} =
      Sim.command(wrong, "root", :author_edit, [post.id, predecessor.id, "laundered"])

    wrong = Sim.sync_all(wrong)
    assert {true, :application_wrong_author} == Sim.quarantined(wrong, "root", predecessor.id)

    assert {true, :application_target_quarantined} ==
             Sim.quarantined(wrong, "root", descendant.id)

    assert Sim.state(wrong, "root").posts == ["original"]

    histories = Enum.map(histories ++ [valid, missing, bom, bom_target, wrong], &history/1)

    inputs =
      Enum.flat_map(histories, fn {history, _} ->
        [history, %{history | frames: Enum.reverse(history.frames)}]
      end)

    path = Path.join(dir, "histories.json")
    File.write!(path, Jason.encode!(%{histories: inputs}))

    {output, 0} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/thread_lineage_peer.ts", "--consume", path],
        cd: @client
      )

    expected = Enum.flat_map(histories, fn {_, reasons} -> [reasons, reasons] end)
    assert Jason.decode!(output)["results"] == expected
  end

  defp history(sim) do
    log = Sim.log(sim, "root")
    :ok = Log.verify_authenticity(log)
    ops = Log.topo_ops(log)

    {%{replica: log.replica, frames: Enum.map(ops, &Wire.encode_op/1)}, reduction(log)}
  end

  defp reduction(log) do
    analysis = Authority.analyze(Treehouse.Thread, log)
    ops = Log.topo_ops(log)
    state = Lattice.state(Treehouse.Thread, log)

    %{
      "reasons" =>
        Map.new(
          Enum.filter(ops, &(&1.kind == :command)),
          &{&1.id, analysis.reasons[&1.id] && Atom.to_string(analysis.reasons[&1.id])}
        ),
      "posts" => state.posts,
      # TypeScript exposes the authority holder as a synthetic state field.
      "state" =>
        state
        |> Map.put(:moderator, Base.encode64(analysis.holders.moderator))
        |> Jason.encode!()
        |> Jason.decode!(),
      "quarantine" => Enum.sort(analysis.quarantine),
      "order" => Enum.map(ops, & &1.id)
    }
  end
end
