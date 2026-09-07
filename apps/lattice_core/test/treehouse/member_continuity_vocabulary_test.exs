defmodule Treehouse.MemberContinuityVocabularyTest do
  use ExUnit.Case, async: true

  alias Lattice.{Log, Op}
  alias Treehouse.MemberContinuityVectors, as: Vectors

  @vectors Path.expand(
             "../../../../clients/lattice-client/test/vectors/member_continuity",
             __DIR__
           )

  test "selected Space alone interns the supplement and four existing shared claim literals" do
    names =
      Path.expand(
        "../../../../clients/lattice-client/test/vectors/catalog/cutoff_atoms_member_continuity_v1.json",
        __DIR__
      )

    script =
      prelude() <>
        """
        names = System.argv() |> hd() |> File.read!() |> Jason.decode!()
        expected = Enum.sort(names ++ ["epoch_basis", "nonce", "parents", "treehouse"])
        true = Enum.map(Treehouse.Space.known_continuity_wire_atoms(), &Atom.to_string/1) == expected
        false = :code.is_loaded(Treehouse.MemberContinuityCertificate)
        IO.puts("SELECTED_SPACE_LITERAL_OK")
        """

    assert run!(script, [names]) =~ "SELECTED_SPACE_LITERAL_OK"
  end

  test "first real signed frame decodes after only selected Space loading and remains unknown" do
    script =
      prelude() <>
        """
        for path <- System.argv() do
          vector = path |> File.read!() |> Jason.decode!() |> Map.fetch!("unknown_command")
          frame = Enum.find(vector["frames"], &(&1["id"] == vector["op_id"]))
          {:ok, first} = Lattice.Carrier.Wire.decode_op(frame)
          true = Lattice.Op.valid?(first)
          {:ok, ops} = Lattice.Carrier.Wire.decode_ops(vector["frames"])
          {log, %{pending: []}} = Lattice.Sync.deliver(Lattice.Log.new(vector["replica"]), Enum.reverse(ops))
          :ok = Lattice.Log.verify_authenticity(log)
          :operation_not_granted = Map.fetch!(Lattice.Authority.analyze(Treehouse.Space, log).reasons, first.id)
          baseline = Enum.reduce(Enum.reject(ops, &(&1.id == first.id)), Lattice.Log.new(first.replica), &Lattice.Log.append!(&2, &1))
          true = Lattice.state(Treehouse.Space, log) == Lattice.state(Treehouse.Space, baseline)
          true = Lattice.Log.ops(log)[first.id] == first
        end
        IO.puts("SELECTED_SPACE_FIRST_FRAME_OK")
        """

    assert run!(script, Enum.map(["beam_codec.json", "ts_codec.json"], &Path.join(@vectors, &1))) =~
             "SELECTED_SPACE_FIRST_FRAME_OK"
  end

  @tag :tmp_dir
  test "separate cold verified restore retains authentic bytes and refuses forged or unsafe dumps",
       %{tmp_dir: dir} do
    fixture = Vectors.fixture()
    source = Vectors.unknown_command(fixture)
    genuine = Path.join(dir, "genuine.dump")
    forged = Path.join(dir, "forged.dump")
    unsafe = Path.join(dir, "unsafe.dump")
    assert :ok = Log.dump(source.log, genuine)

    assert :ok =
             Log.dump(
               %{
                 source.log
                 | ops: Map.put(source.log.ops, source.op.id, %{source.op | sig: <<0::512>>})
               },
               forged
             )

    unknown =
      Op.new(
        fixture.root,
        source.op.replica,
        [source.op.id],
        :command,
        :member_continuity_unknown_dump_v99
      )

    assert :ok = source.log |> Log.append!(unknown) |> Log.dump(unsafe)

    script =
      prelude() <>
        """
        [genuine, forged, unsafe, fixture] = System.argv()
        vector = fixture |> File.read!() |> Jason.decode!() |> Map.fetch!("unknown_command")
        {:ok, %{log: log, sha256: hash}} = Lattice.Log.restore_verified(genuine)
        true = hash == (:crypto.hash(:sha256, File.read!(genuine)) |> Base.encode16(case: :lower))
        :ok = Lattice.Log.verify_authenticity(log)
        :operation_not_granted = Map.fetch!(Lattice.Authority.analyze(Treehouse.Space, log).reasons, vector["op_id"])
        {:ok, expected} = Lattice.Carrier.Wire.decode_ops(vector["frames"])
        true = Enum.sort_by(Map.values(Lattice.Log.ops(log)), & &1.id) == Enum.sort_by(expected, & &1.id)
        {:error, _} = Lattice.Log.restore_verified(forged)
        {:error, :unsafe_dump} = Lattice.Log.restore_verified(unsafe)
        IO.puts("SELECTED_SPACE_VERIFIED_RESTORE_OK")
        """

    assert run!(script, [genuine, forged, unsafe, Path.join(@vectors, "beam_codec.json")]) =~
             "SELECTED_SPACE_VERIFIED_RESTORE_OK"
  end

  defp prelude do
    """
    false = :code.is_loaded(Treehouse.MemberContinuityCertificate)
    false = :code.is_loaded(Treehouse.CatalogCutoff)
    false = :code.is_loaded(Treehouse.CatalogTrust)
    Code.ensure_loaded!(Treehouse.Space)
    Code.ensure_loaded!(Lattice.Authority)
    Code.ensure_loaded!(Lattice.Authority.Delegation)
    false = :code.is_loaded(Treehouse.MemberContinuityCertificate)
    false = :code.is_loaded(Treehouse.CatalogCutoff)
    false = :code.is_loaded(Treehouse.CatalogTrust)
    """
  end

  defp run!(script, args) do
    {output, status} =
      System.cmd(
        System.find_executable("elixir"),
        [
          "-pa",
          Application.app_dir(:lattice_core, "ebin"),
          "-pa",
          Application.app_dir(:jason, "ebin"),
          "-e",
          script | args
        ],
        env: [{"ERL_FLAGS", "+S 4:4"}],
        stderr_to_stdout: true
      )

    assert status == 0, output
    output
  end
end
