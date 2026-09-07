defmodule Treehouse.CatalogCutoffReciprocalTest do
  use ExUnit.Case, async: true

  alias Lattice.{Log, Op}
  alias Lattice.Carrier.Wire
  alias Treehouse.{CatalogCutoff, CatalogVectors}

  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @exporter "test/support/export_treehouse_catalog_cutoff.ts"

  setup do
    directory =
      Path.join(System.tmp_dir!(), "treehouse_cutoff_#{System.unique_integer([:positive])}")

    File.mkdir_p!(directory)
    on_exit(fn -> File.rm_rf!(directory) end)
    Code.ensure_loaded!(CatalogCutoff)
    {:ok, directory: directory}
  end

  test "fresh TS signatures and rejected evidence produce exact BEAM cutoff records", context do
    path = Path.join(context.directory, "ts.json")
    run_ts!(["--out", path])
    %{"version" => 1, "vectors" => vectors} = path |> File.read!() |> Jason.decode!()
    assert length(vectors) == 2

    baseline =
      File.read!(
        Path.join(@client, "test/vectors/catalog/cutoff_default_pre_member_continuity.json")
      )

    assert Base.encode16(:crypto.hash(:sha256, baseline), case: :lower) ==
             "21d0167dcbee9ac72216af7e1af4ab9d34ac559fd09347046671c25dcf00c0bc"

    assert File.read!(path) == baseline

    verify_ts_vectors(vectors)
  end

  test "fresh TS continuity supplement and union retain rejected same-ID evidence", context do
    path = Path.join(context.directory, "ts-continuity.json")
    run_ts!(["--with-member-continuity", "--out", path])
    %{"version" => 1, "vectors" => vectors} = path |> File.read!() |> Jason.decode!()

    assert Enum.map(vectors, & &1["name"]) == [
             "member-continuity-9-names",
             "member-continuity-139-names"
           ]

    verify_ts_vectors(vectors)
  end

  defp verify_ts_vectors(vectors) do
    for vector <- vectors do
      log =
        Enum.reduce(vector["rejected"], Log.new(vector["replica"]), fn rejected, log ->
          assert rejected["reason"] == "bad_signature"
          assert {:ok, op} = Wire.decode_op(rejected["frame"])
          assert {:quarantined, retained, :bad_signature} = Log.accept(log, op)
          retained
        end)

      assert {:ok, ops} = Wire.decode_ops(vector["frames"])
      assert Enum.all?(ops, &Op.valid?/1)
      accepted = Enum.reduce(ops, log, &Log.append!(&2, &1))
      assert result(accepted) == vector["result"], vector["name"]

      # Authenticating rejected evidence must not erase a genuine op with its ID.
      assert map_size(accepted.ops) == length(ops)
      assert length(Log.quarantine(accepted)) == length(vector["rejected"])
    end
  end

  test "fresh BEAM signatures and exact uint64/atom evidence verify in TS in both orders",
       context do
    fixture = CatalogVectors.bootstrap_history()

    vectors =
      Enum.flat_map(
        [
          "cutoff_atoms_v1.json",
          "cutoff_atoms_member_continuity_v1.json",
          "cutoff_atoms_with_member_continuity_v1.json"
        ],
        fn file ->
          names =
            @client
            |> Path.join("test/vectors/catalog/" <> file)
            |> File.read!()
            |> Jason.decode!()

          # Only the committed closed vocabulary; no imported atom is ever interned.
          atoms = Enum.map(names, &String.to_existing_atom/1)

          vocabulary =
            Op.new(
              fixture.root,
              fixture.replica,
              Log.frontier(fixture.log),
              :command,
              {:create_space, [atoms]},
              cap: fixture.delegation.id
            )

          high =
            Op.new(
              fixture.root,
              fixture.replica,
              [vocabulary.id],
              :authority,
              {:beacon, 18_446_744_073_709_551_615}
            )

          first = fixture.log |> Log.append!(vocabulary) |> Log.append!(high)

          genuine =
            Op.new(
              fixture.root,
              fixture.replica,
              [high.id],
              :command,
              {:create_space, ["Retained after rejected signature"]},
              cap: fixture.delegation.id
            )

          assert {:quarantined, second, :bad_signature} =
                   Log.accept(first, %{genuine | sig: <<0::512>>})

          assert {:quarantined, second, :bad_signature} =
                   Log.accept(second, %{
                     genuine
                     | id: "untrusted supplied id",
                       deps: ["withheld rejected-only dependency"],
                       sig: <<>>
                   })

          second = Log.append!(second, genuine)

          for {name, log} <- [
                {"beam-all-fixed-atoms-and-exact-high-legacy", first},
                {"beam-rejected-and-genuine-same-id", second}
              ] do
            %{
              "name" => name,
              "replica" => log.replica,
              "frames" => Enum.map(Log.topo_ops(log), &Wire.encode_op/1),
              "rejected" =>
                Enum.map(Log.quarantine(log), fn rejected ->
                  %{"frame" => Wire.encode_op(rejected.op), "reason" => "bad_signature"}
                end),
              "result" => result(log)
            }
          end
        end
      )

    path = Path.join(context.directory, "beam.json")
    File.write!(path, Jason.encode!(%{"version" => 1, "vectors" => vectors}))
    output = run_ts!(["--verify-beam", path])
    assert length(Regex.scan(~r/PASS BEAM→TS exact cutoff/, output)) == 6
  end

  defp result(log) do
    assert {:ok, value} = CatalogCutoff.derive(log)

    %{
      "ok" => true,
      "cutoff" => %{
        "replica" => value.cutoff.replica,
        "frontier" => value.cutoff.frontier,
        "logDigest" => value.cutoff.log_digest
      },
      "canonicalBytes" => Base.encode64(value.canonical_bytes),
      "ops" => Enum.map(value.ops, &record/1),
      "rejected" => Enum.map(value.rejected, &Map.put(record(&1), "reason", "bad_signature"))
    }
  end

  defp record(record) do
    %{
      "id" => record.id,
      "bytes" => Base.encode64(record.bytes),
      "sig" => Base.encode64(record.sig)
    }
  end

  defp run_ts!(arguments) do
    {output, status} =
      System.cmd(Path.join(@client, "node_modules/.bin/tsx"), [@exporter | arguments],
        cd: @client,
        stderr_to_stdout: true
      )

    assert status == 0, output
    output
  end
end
