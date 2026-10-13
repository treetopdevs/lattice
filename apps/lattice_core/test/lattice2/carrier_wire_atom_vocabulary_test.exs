defmodule Lattice.CarrierWireAtomVocabularyTest do
  # Row 190: frame admission must be a pure function of the frame bytes, not of which
  # atoms the decoding VM happens to hold.
  use ExUnit.Case, async: true

  alias Lattice.Authority.{Delegation, SuccessionCertificate}
  alias Lattice.{Authority, Canonical, Carrier.Wire, Identity, Op, Sim}
  alias Township.Matter
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

  test "an unknown name renders and serializes as the atom it names" do
    unknown = %CanonicalAtom{name: "post"}
    assert to_string(unknown) == to_string(:post)
    assert Enum.join([unknown, :clerk], ",") == "post,clerk"
    assert Jason.encode!(%{"ops" => [unknown]}) == Jason.encode!(%{"ops" => [:post]})
  end

  test "an audit bundle renders an unknown name as the atom it names" do
    name = absent_name("bundle")
    dir = Path.join(System.tmp_dir!(), "row190-bundle-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(dir) end)
    sim = Sim.new(Matter, "replica:matter:row190-bundle", ["clerk"], seed: "row190-bundle")
    {sim, _} = Sim.create_replica(sim, "clerk")
    {sim, _} = Sim.command(sim, "clerk", :set_title, [%CanonicalAtom{name: name}])
    assert {:ok, _} = Township.AuditBundle.write(dir, Sim.log(sim, "clerk"))
    state = dir |> Path.join("state.json") |> File.read!()
    assert state =~ ~s("#{name}")
    refute state =~ ~s("name":)
  end

  test "a genesis whose policy term is an unknown name is inert, as a warm non-map atom is" do
    for policies <- [:ok, %CanonicalAtom{name: absent_name("policy")}] do
      sim = Sim.new(Matter, "replica:matter:row190-policy-term", ["clerk"], seed: "row190")
      {sim, genesis} = Sim.create_replica(sim, "clerk")
      clerk = Sim.identity(sim, "clerk")

      # An empty, non-live root genesis is the shape the continuation pin scan reads.
      pin = Delegation.genesis(clerk, Sim.replica(sim), ops: [], roles: [], live: false)
      {sim, _} = Sim.append(sim, "clerk", :authority, {:genesis, pin, policies})
      analysis = Authority.analyze(Matter, Sim.log(sim, "clerk"))
      assert analysis.reasons == %{}, inspect(policies)
      assert analysis.holder_epochs[:clerk].op_id == genesis.id
    end
  end

  test "a certificate naming an unknown role fails the claim comparison, not its shape" do
    [w1, w2] = Enum.map(["w1", "w2"], &Identity.from_seed(&1, "row190-certificate-" <> &1))
    holder = Identity.from_seed("holder", "row190-certificate-holder")
    successor = Identity.from_seed("successor", "row190-certificate-successor")
    policy = %{mode: :witnessed, version: 1, witnesses: [w1.pub, w2.pub], threshold: 2}

    {:ok, expected} =
      SuccessionCertificate.claim(
        "replica:row190",
        :clerk,
        holder.pub,
        "epoch",
        successor.pub,
        policy
      )

    verdict = fn role ->
      %{expected | role: role}
      |> SuccessionCertificate.new([w1, w2])
      |> SuccessionCertificate.verify(expected, policy)
    end

    warm = verdict.(:post)
    assert {:error, reason} = warm
    refute reason == :malformed_recovery_certificate
    assert verdict.(%CanonicalAtom{name: absent_name("role")}) == warm
  end

  for mode <- ["preloaded", "unloaded"] do
    # "preloaded" loads every lattice_core module except the exporter task before
    # decoding; "unloaded" decodes first, so Wire must load the schema vocabulary itself.
    test "the five plan 185 vectors decode and judge equally in a #{mode} VM without the exporter's atoms" do
      run_cold_vm(unquote(mode))
    end
  end

  defp run_cold_vm(mode) do
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
    pairs = Enum.flat_map(@cold_vectors, fn {v, a} -> [v, a] end)
    args = paths ++ [script, mode, @vectors | pairs]
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
    [mode, dir | pairs] = System.argv()
    # "unloaded" leaves even the lattice_core application metadata unloaded before the
    # first decode, so Wire must load it before scanning.
    if mode == "preloaded" do
      :ok = Application.load(:lattice_core)
      {:ok, modules} = :application.get_key(:lattice_core, :modules)
      for m <- modules, m != Mix.Tasks.Lattice.ExportVectors, do: Code.ensure_loaded(m)
    end

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

          state = Lattice.Reduce.reduce(module, log, quarantine: analysis.quarantine)

          state =
            case vector["schema"]["name"] do
              "PolicyFixture" ->
                %{"events" => state.events}

              _ ->
                clerk = analysis.holders[:clerk]

                %{
                  "title" => state.title,
                  "summary" => state.summary,
                  "posts" => state.posts,
                  "members" => state.members,
                  "clerk" => clerk && vector["realmByPubkey"][Base.encode64(clerk)],
                  "clerk_locked" => state.clerk_locked?
                }
            end

          state = state |> Jason.encode!() |> Jason.decode!()

          cond do
            Lattice.Log.size(log) != length(ops) -> {:op_count, Lattice.Log.size(log)}
            reasons != Enum.sort(expected["authorityQuarantine"]) -> {:reasons, reasons}
            state != expected["state"] -> {:state, state}
            true -> :ok
          end
        end

      IO.puts("ROW190 #{name} #{inspect(verdict)}")
    end)
    '''
  end
end
