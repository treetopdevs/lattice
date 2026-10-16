defmodule Lattice.WireVocabularyTest do
  # Plan 190, Step 1: the closed wire vocabulary must cover every atom name a legitimate
  # carrier op can carry. Declarations and committed frames are checked here; the exporter
  # raises for any name it emits that is not listed (`carrier_frame/1`).
  use ExUnit.Case, async: true

  alias Lattice.Authority
  alias Lattice.Authority.Delegation
  alias Lattice.Carrier.Wire
  alias Lattice.Carrier.WireVocabulary
  alias Lattice.{Identity, Log, Op, Sync}

  @vectors Path.expand("../../../../clients/lattice-client/test/vectors", __DIR__)

  defp assert_listed(label, names) do
    missing =
      names
      |> Enum.uniq()
      |> Enum.reject(&WireVocabulary.known?/1)
      |> Enum.sort()

    assert missing == [],
           "#{label} names missing from WireVocabulary.names/0: #{inspect(missing)}"
  end

  # `Mix.Project.apps_paths/0` is nil inside a recursed umbrella child and in a standalone
  # `cd apps/lattice_core && mix test`, and so is the parent umbrella file. The umbrella root is
  # always two levels above this app's directory, so discover `apps/*/mix.exs` from there.
  defp umbrella_apps do
    case Mix.Project.apps_paths() do
      paths when is_map(paths) ->
        Map.keys(paths)

      _ ->
        Path.expand("../../../../apps/*/mix.exs", __DIR__)
        |> Path.wildcard()
        |> Enum.map(&(&1 |> Path.dirname() |> Path.basename() |> String.to_atom()))
    end
  end

  defp replica_modules do
    for app <- umbrella_apps(),
        _ = Application.load(app),
        module <- Application.spec(app, :modules) || [],
        Code.ensure_loaded?(module),
        function_exported?(module, :__lattice_commands__, 0),
        do: module
  end

  defp declared_names(module) do
    fields = module.__lattice_fields__()

    commands = for {name, _arity, _args} <- module.__lattice_commands__(), do: name
    field_names = for {name, _spec} <- fields, do: name
    roles = for {_name, %{kind: :authority, role: role}} <- fields, do: role
    succession = Map.keys(module.__lattice_succession__())

    Enum.map(commands ++ field_names ++ roles ++ succession, &Atom.to_string/1)
  end

  # Every carrier-frame object (a map with `body` and `cap`), wherever it sits.
  defp frames(%{"body" => _, "cap" => _} = frame), do: [frame | frames(Map.values(frame))]
  defp frames(%{} = map), do: map |> Map.values() |> frames()
  defp frames(list) when is_list(list), do: Enum.flat_map(list, &frames/1)
  defp frames(_), do: []

  defp term_names(["atom", name]) when is_binary(name), do: [name]

  defp term_names(["delegation", %{} = delegation]) do
    Map.get(delegation, "ops", []) ++ Map.get(delegation, "roles", [])
  end

  defp term_names(list) when is_list(list), do: Enum.flat_map(list, &term_names/1)
  defp term_names(%{} = map), do: map |> Map.values() |> term_names()
  defp term_names(_), do: []

  describe "list shape" do
    test "names/0 is sorted and unique, and known?/1 agrees with it" do
      names = WireVocabulary.names()

      assert Enum.all?(names, &is_binary/1)
      assert names == names |> Enum.uniq() |> Enum.sort()
      assert Enum.all?(names, &WireVocabulary.known?/1)
      refute WireVocabulary.known?("definitely_not_an_existing_atom")
      refute WireVocabulary.known?(:post)
    end

    test "reasons/0 is the explicit Log.accept/2 report reason set" do
      assert Enum.sort(WireVocabulary.reasons()) ==
               [:already_quarantined, :bad_signature, :wrong_replica]
    end
  end

  describe "(a) declarations" do
    test "op kinds are listed" do
      assert_listed("op kind", Enum.map(Wire.op_kinds(), &Atom.to_string/1))
    end

    test "every replica declaration in every umbrella app is listed" do
      modules = replica_modules()

      # Guard against the walk silently finding nothing (an unloaded app).
      assert Lattice.Demo.Thread in modules
      assert Township.Matter in modules

      for module <- modules do
        assert_listed(inspect(module), declared_names(module))
      end
    end
  end

  describe "cutoff vocabulary" do
    test "every Treehouse.CatalogCutoff atom is listed" do
      atoms = Treehouse.CatalogCutoff.cutoff_atoms()

      assert length(atoms) > 100
      assert_listed("cutoff", Enum.map(atoms, &Atom.to_string/1))
    end
  end

  describe "(b) committed frames" do
    test "every atom and delegation name in every committed frame is listed" do
      files = Path.wildcard(Path.join(@vectors, "**/*.json"))
      assert files != []

      names =
        for file <- files,
            frame <- file |> File.read!() |> Jason.decode!() |> frames(),
            name <- term_names(frame["body"]) ++ term_names(frame["cap"]),
            do: name

      assert length(Enum.uniq(names)) > 100
      assert_listed("committed frame", names)
    end
  end

  describe "(d) report reasons" do
    test "the reasons Log.accept/2 and Sync.deliver/2 put in a report are exactly reasons/0" do
      root = Identity.generate("root")
      replica = Authority.bind_replica("wire-vocabulary", root.pub)
      other_replica = Authority.bind_replica("wire-vocabulary-other", root.pub)

      genesis_delegation = Delegation.genesis(root, replica, ops: [:post], roles: [])
      genesis = Op.new(root, replica, [], :authority, {:genesis, genesis_delegation, %{}})
      valid = Op.new(root, replica, [genesis.id], :command, {:post, ["hello"]})

      forged = %{valid | sig: :binary.copy(<<1>>, 64)}
      missing_dep = Op.new(root, replica, ["no-such-op"], :command, {:post, ["orphan"]})

      foreign_genesis =
        Op.new(
          root,
          other_replica,
          [],
          :authority,
          {:genesis, Delegation.genesis(root, other_replica, ops: [:post], roles: []), %{}}
        )

      {_log, report} =
        Sync.deliver(Log.new(replica), [
          forged,
          forged,
          genesis,
          valid,
          missing_dep,
          foreign_genesis
        ])

      assert report.accepted == [genesis.id, valid.id]
      assert report.pending == [missing_dep.id]

      reasons =
        (report.quarantined ++ report.rejected)
        |> Enum.map(fn {_id, reason} -> reason end)

      assert Enum.sort(Enum.uniq(reasons)) == Enum.sort(WireVocabulary.reasons())
    end
  end
end
