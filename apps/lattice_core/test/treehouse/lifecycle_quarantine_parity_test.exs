defmodule Treehouse.LifecycleQuarantineParityTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Log, Op, Sim}
  alias Lattice.Carrier.Wire
  @client Path.expand("../../../../clients/lattice-client", __DIR__)

  test "lifecycle tombstones require the bound root before target type is checked" do
    {output, 0} =
      System.cmd("node", ["--import", "tsx", "test/support/lifecycle_quarantine_peer.ts"],
        cd: @client
      )

    histories = Jason.decode!(output)["histories"]
    assert length(histories) == 16

    for h <- histories, frames <- [h["frames"], Enum.reverse(h["frames"])] do
      {:ok, ops} = Wire.decode_ops(frames)
      assert Enum.all?(ops, &Op.valid?/1)
      log = Log.from_ops(h["replica"], Map.new(ops, &{&1.id, &1}))

      module =
        if String.starts_with?(log.replica, "replica:treehouse:space:"),
          do: Treehouse.Space,
          else: Treehouse.Thread

      reasons = reasons(module, log)

      for %Op{kind: :authority, body: {:grant, _}, id: id} <- ops do
        assert reasons[id] == nil
      end

      for op <- ops, op.kind == :tombstone do
        expected =
          if String.contains?(h["name"], "-root-"), do: nil, else: "unauthorized_tombstone"

        assert reasons[op.id] == expected
      end

      assert reasons == h["reasons"], h["name"]
    end
  end

  @tag :tmp_dir
  test "fresh BEAM lifecycle histories are independently judged by TypeScript", %{tmp_dir: dir} do
    histories =
      for {module, kind} <- [{Treehouse.Space, "space"}, {Treehouse.Thread, "thread"}],
          realm <- ["root", "member"] do
        instance =
          :crypto.hash(:sha256, "beam-lifecycle-#{kind}") |> Base.url_encode64(padding: false)

        replica = "replica:treehouse:#{kind}:#{instance}#authority:bounded-continuation-v1"

        {sim, _} =
          module
          |> Sim.new(replica, ["root", "member"], seed: "beam-lifecycle")
          |> Sim.create_replica("root")

        command = if kind == "space", do: :create_space, else: :post
        {sim, post} = Sim.command(sim, "root", command, ["retained"])
        sim = Sim.sync_all(sim)
        {sim, lifecycle} = Sim.append(sim, realm, :tombstone, nil)
        sim = Sim.sync_all(sim)

        {sim, descendant} =
          if kind == "thread" do
            Sim.command(sim, "root", :author_edit, [post.id, lifecycle.id, "wrong type"])
          else
            {sim, nil}
          end

        log = Sim.log(sim, "root")
        assert String.contains?(log.replica, "#root:")
        actual = reasons(module, log)

        assert actual[lifecycle.id] ==
                 if(realm == "root", do: nil, else: "unauthorized_tombstone")

        if descendant do
          assert actual[descendant.id] ==
                   if(realm == "root",
                     do: "application_wrong_target",
                     else: "application_target_quarantined"
                   )
        end

        frames = Enum.map(Log.topo_ops(log), &Wire.encode_op/1)

        {%{name: "beam-#{kind}-#{realm}", replica: log.replica, frames: frames}, actual}
      end

    inputs = Enum.flat_map(histories, fn {h, _} -> [h, %{h | frames: Enum.reverse(h.frames)}] end)
    path = Path.join(dir, "histories.json")
    File.write!(path, Jason.encode!(%{histories: inputs}))

    {output, 0} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/lifecycle_quarantine_peer.ts", "--consume", path],
        cd: @client
      )

    assert Jason.decode!(output)["results"] ==
             Enum.flat_map(histories, fn {_, reasons} -> [reasons, reasons] end)
  end

  defp reasons(module, log) do
    :ok = Log.verify_authenticity(log)
    analysis = Authority.analyze(module, log)

    Map.new(
      Log.topo_ops(log),
      &{&1.id, analysis.reasons[&1.id] && Atom.to_string(analysis.reasons[&1.id])}
    )
  end
end
