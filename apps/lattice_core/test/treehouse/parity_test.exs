defmodule Treehouse.ParityTest do
  use ExUnit.Case, async: false

  alias Lattice.{Authority, Identity, Log, Sync}
  alias Lattice.Carrier.Wire

  test "Treehouse signed histories and projections survive restore in an independent VM" do
    root = Path.expand("../../../..", __DIR__)
    paths = Path.wildcard(Path.join(root, "clients/lattice-client/test/vectors/treehouse_*.json"))

    for vector_path <- paths do
      vector = vector_path |> File.read!() |> Jason.decode!()

      module =
        if vector["schema"]["name"] == "Treehouse.Space",
          do: Treehouse.Space,
          else: Treehouse.Thread

      Code.ensure_loaded!(module)

      ops =
        Enum.map(vector["oracleCarrierOps"], fn frame ->
          {:ok, op} = Wire.decode_op(frame)
          op
        end)

      {log, %{pending: []}} = Sync.deliver(Log.new(vector["replica"]), ops)
      expected = Treehouse.ReadModel.observe(module, log)

      path =
        Path.join(
          System.tmp_dir!(),
          "treehouse-restore-#{System.unique_integer([:positive])}.log"
        )

      on_exit(fn -> File.rm(path) end)
      assert :ok = Log.dump(log, path)
      assert {:ok, restored} = Log.restore(path)
      assert Log.ops(restored) == Log.ops(log)
      assert Treehouse.ReadModel.observe(module, restored) == expected

      digest =
        :crypto.hash(:sha256, :erlang.term_to_binary(expected, [:deterministic]))
        |> Base.encode16()

      script = """
      Code.ensure_loaded!(Treehouse.Space)
      Code.ensure_loaded!(Treehouse.Thread)
      {:ok, log} = Lattice.Log.restore(#{inspect(path)})
      true = Enum.all?(Lattice.Log.ops(log), fn {_, op} -> Lattice.Op.valid?(op) end)
      view = Treehouse.ReadModel.observe(#{inspect(module)}, log)
      #{inspect(digest)} = :crypto.hash(:sha256, :erlang.term_to_binary(view, [:deterministic])) |> Base.encode16()
      IO.puts("TREEHOUSE_RESTORE_OK")
      """

      elixir = System.find_executable("elixir") || raise "Elixir executable unavailable"

      {output, status} =
        System.cmd(elixir, ["-pa", Application.app_dir(:lattice_core, "ebin"), "-e", script],
          stderr_to_stdout: true
        )

      assert status == 0, output
      assert output =~ "TREEHOUSE_RESTORE_OK", output
    end
  end

  test "generated Treehouse vectors retain one signed node and every command effect" do
    dir = Path.join(System.tmp_dir!(), "treehouse_vectors_#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(dir) end)
    Mix.Task.reenable("lattice.export_vectors")
    assert :ok = Mix.Task.run("lattice.export_vectors", ["--out", dir])

    for name <- [
          "treehouse_space_membership",
          "treehouse_space_roles",
          "treehouse_space_succession",
          "treehouse_thread_archive",
          "treehouse_thread_conflicts",
          "treehouse_space_map_order"
        ] do
      vector = dir |> Path.join(name <> ".json") |> File.read!() |> Jason.decode!()
      assert vector["generatedBy"] == "Lattice.Sim"
      assert length(vector["ops"]) == length(vector["oracleCarrierOps"])

      assert vector["ops"] |> Enum.map(& &1["id"]) |> Enum.uniq() |> length() ==
               length(vector["ops"])

      assert Enum.all?(vector["ops"], &is_list(&1["effects"]))
      assert is_list(vector["expectAtFullFrontier"]["authorityQuarantine"])
      assert Enum.any?(vector["ops"], &(length(&1["effects"]) > 1))
    end
  end

  test "TS product-authored frames replay through BEAM with identical state, roles, verdicts and order" do
    root = Path.expand("../../../..", __DIR__)
    client = Path.join(root, "clients/lattice-client")

    output =
      Path.join(
        System.tmp_dir!(),
        "treehouse_ts_frames_#{System.unique_integer([:positive])}.json"
      )

    on_exit(fn -> File.rm(output) end)

    {message, status} =
      System.cmd(Path.join(client, "node_modules/.bin/tsx"), ["test/treehouse.ts"],
        cd: client,
        env: [{"TREEHOUSE_TS_FRAMES", output}],
        stderr_to_stdout: true
      )

    assert status == 0, message

    for {scenario, frames} <- output |> File.read!() |> Jason.decode!() do
      vector =
        client
        |> Path.join("test/vectors/" <> scenario <> ".json")
        |> File.read!()
        |> Jason.decode!()

      module =
        if vector["schema"]["name"] == "Treehouse.Space",
          do: Treehouse.Space,
          else: Treehouse.Thread

      Code.ensure_loaded!(module)

      ops =
        Enum.map(frames, fn frame ->
          {:ok, op} = Wire.decode_op(frame)
          op
        end)

      {log, report} = Sync.deliver(Log.new(vector["replica"]), Enum.reverse(ops))
      assert report.pending == []
      assert map_size(Log.ops(log)) == length(frames)
      assert Enum.map(Log.topo_ops(log), & &1.id) == Enum.map(vector["ops"], & &1["id"])

      state =
        Map.new(Lattice.state(module, log), fn {field, value} ->
          {Atom.to_string(field), value}
        end)

      state =
        Enum.reduce([:admin, :moderator], state, fn role, acc ->
          if Map.has_key?(vector["schema"]["fields"], Atom.to_string(role)) do
            holder = Authority.holder(module, log, role)

            label =
              if holder,
                do:
                  Map.get(
                    vector["realmByPubkey"],
                    Base.encode64(holder),
                    Identity.fingerprint(holder)
                  )

            Map.put(acc, Atom.to_string(role), label)
          else
            acc
          end
        end)

      assert state == vector["expectAtFullFrontier"]["state"]

      reasons =
        Authority.analyze(module, log).reasons
        |> Enum.map(fn {id, reason} -> [id, Atom.to_string(reason)] end)
        |> Enum.sort()

      assert reasons == vector["expectAtFullFrontier"]["authorityQuarantine"]
    end
  end
end
