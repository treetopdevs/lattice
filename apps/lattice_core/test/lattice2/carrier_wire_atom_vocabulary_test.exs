defmodule Lattice.CarrierWireAtomVocabularyTest do
  # Row 190: frame admission must be a pure function of the frame bytes, not of which
  # atoms the decoding VM happens to hold.
  use ExUnit.Case, async: true

  alias Lattice.Authority.Delegation
  alias Lattice.{Canonical, Carrier.Wire, Identity, Op}
  alias Lattice.Canonical.Atom, as: CanonicalAtom

  @vectors Path.expand("../../../../clients/lattice-client/test/vectors", __DIR__)

  # Each named scenario carries a signed frame with an atom that only the vector
  # exporter's source spells as a literal (the plan 185 decision record).
  @cold_vectors %{
    "township_authority_unattenuated_transfer" => "seize_records",
    "township_authority_undeclared_role_tick" => "ghost",
    "township_beacon_witnessed_certificate_metadata" => "nested",
    "township_beacon_witnessed_policy_metadata" => "nested",
    "township_policy_target_reason_taxonomy" => "malformed"
  }

  defp absent_name(prefix) do
    name = "#{prefix}_row190_absent_#{System.unique_integer([:positive])}"
    assert_raise ArgumentError, fn -> String.to_existing_atom(name) end
    name
  end

  test "a signed term naming an atom this VM lacks is admitted with its exact bytes" do
    identity = Identity.from_seed("alice", "wire-atom-vocabulary")
    name = absent_name("zz")
    op = Op.new(identity, "replica:wire", [], :command, {:post, %CanonicalAtom{name: name}})
    frame = Wire.encode_op(op)

    assert frame["body"] == ["tuple", [["atom", "post"], ["atom", name]]]
    assert {:ok, decoded} = frame |> Jason.encode!() |> Jason.decode!() |> Wire.decode_op()
    assert decoded == op
    assert Op.valid?(decoded)
    assert_raise ArgumentError, fn -> String.to_existing_atom(name) end
  end

  test "delegation bytes order unknown and known names by name, as a VM holding both would" do
    issuer = Identity.from_seed("issuer", "wire-atom-vocabulary")
    unknown = %CanonicalAtom{name: absent_name("aa")}

    d =
      Delegation.new(issuer, "replica:wire", issuer.pub,
        ops: [:post, unknown],
        roles: [:clerk],
        live: false
      )

    # A VM that holds the atom sorts by name, so "aa_..." precedes :post.
    expected =
      Canonical.term([
        "lattice-delegation-v2",
        "replica:wire",
        issuer.pub,
        issuer.pub,
        nil,
        [unknown, :post],
        [:clerk],
        false
      ])

    assert Canonical.delegation_payload(d) == expected
    assert Delegation.valid_sig?(d)

    op = Op.new(issuer, "replica:wire", [], :authority, {:genesis, d, %{}})

    assert {:ok, decoded} =
             op |> Wire.encode_op() |> Jason.encode!() |> Jason.decode!() |> Wire.decode_op()

    assert decoded == op
    assert Op.valid?(decoded)
  end

  test "the five plan 185 vectors decode and judge equally in a VM without the exporter's atoms" do
    script = Path.join(System.tmp_dir!(), "row190-cold-#{System.unique_integer([:positive])}.exs")
    on_exit(fn -> File.rm(script) end)
    File.write!(script, cold_script())

    paths =
      :code.get_path()
      |> Enum.map(&List.to_string/1)
      |> Enum.filter(&String.contains?(&1, "/_build/"))
      |> Enum.flat_map(&["-pa", &1])

    direct = Path.expand("~/.asdf/installs/elixir/1.19.5-otp-28/bin/elixir")
    executable = if File.exists?(direct), do: direct, else: "elixir"
    args = paths ++ [script, @vectors | Enum.flat_map(@cold_vectors, fn {v, a} -> [v, a] end)]
    {output, status} = System.cmd(executable, args, stderr_to_stdout: true)

    assert status == 0, output
    results = output |> String.split("\n") |> Enum.filter(&String.starts_with?(&1, "ROW190 "))
    assert length(results) == map_size(@cold_vectors), output

    for line <- results do
      assert line =~ ~r/ :ok$/, output
    end
  end

  defp cold_script do
    ~S'''
    [dir | pairs] = System.argv()
    {:ok, modules} = :application.get_key(:lattice_core, :modules) |> then(fn
      :undefined -> Application.load(:lattice_core); :application.get_key(:lattice_core, :modules)
      other -> other
    end)

    # Load every lattice_core module except the exporter task itself (its source is the
    # only place the scenario atoms are literals); its nested fixtures are schemas.
    for m <- modules, m != Mix.Tasks.Lattice.ExportVectors, do: Code.ensure_loaded(m)

    schemas = %{
      "Township.Matter" => Township.Matter,
      "PolicyFixture" => Mix.Tasks.Lattice.ExportVectors.PolicyFixture
    }

    pairs
    |> Enum.chunk_every(2)
    |> Enum.each(fn [name, atom_name] ->
      cold? =
        try do
          String.to_existing_atom(atom_name)
          false
        rescue
          ArgumentError -> true
        end

      vector = Path.join(dir, name <> ".json") |> File.read!() |> Jason.decode!()
      module = Map.fetch!(schemas, vector["schema"]["name"] || vector["schema"])
      expected = vector["expectAtFullFrontier"]

      verdict =
        with true <- cold? || :not_cold,
             {:ok, [first | _] = ops} <- Lattice.Carrier.Wire.decode_ops(vector["oracleCarrierOps"]),
             true <- Enum.all?(ops, &Lattice.Op.valid?/1) || :invalid_op do
          {log, _report} = Lattice.Sync.deliver(Lattice.Log.new(first.replica), ops)
          analysis = Lattice.Authority.analyze(module, log)

          reasons =
            analysis.reasons
            |> Enum.map(fn {id, r} -> [id, Atom.to_string(r)] end)
            |> Enum.sort()

          cond do
            Lattice.Log.size(log) != length(ops) -> {:op_count, Lattice.Log.size(log)}
            reasons != Enum.sort(expected["authorityQuarantine"]) -> {:reasons, reasons}
            true -> :ok
          end
        end

      IO.puts("ROW190 #{name} #{inspect(verdict)}")
    end)
    '''
  end
end
