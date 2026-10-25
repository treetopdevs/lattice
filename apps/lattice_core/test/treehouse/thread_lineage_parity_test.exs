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
    end
  end

  @tag :tmp_dir
  test "TypeScript independently consumes fresh BEAM malformed lineage histories", %{tmp_dir: dir} do
    instance = :crypto.hash(:sha256, "beam-thread-lineage") |> Base.url_encode64(padding: false)
    replica = "replica:treehouse:thread:#{instance}#authority:bounded-continuation-v1"

    {sim, _} =
      Treehouse.Thread
      |> Sim.new(replica, ["root"], seed: "beam-lineage")
      |> Sim.create_replica("root")

    {sim, post} = Sim.command(sim, "root", :post, ["original"])

    histories =
      for value <- [7, nil, []], previous <- [post.id, "absent"] do
        {candidate, malformed} =
          Sim.command(sim, "root", :author_edit, [post.id, previous, value])

        {candidate, descendant} =
          Sim.command(candidate, "root", :author_edit, [post.id, malformed.id, "descendant"])

        assert {true, :malformed_command} == Sim.quarantined(candidate, "root", malformed.id)

        assert {true, :application_target_quarantined} ==
                 Sim.quarantined(candidate, "root", descendant.id)

        log = Sim.log(candidate, "root")
        :ok = Log.verify_authenticity(log)
        analysis = Authority.analyze(Treehouse.Thread, log)
        ops = Log.topo_ops(log)

        reasons =
          Map.new(
            Enum.filter(ops, &(&1.kind == :command)),
            &{&1.id, analysis.reasons[&1.id] && Atom.to_string(analysis.reasons[&1.id])}
          )

        {%{replica: log.replica, frames: Enum.map(ops, &Wire.encode_op/1)}, reasons}
      end

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
end
