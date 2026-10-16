defmodule LatticeBrowser.VocabularyTest do
  # Plan 190: browser replicas live in this project, so the umbrella declaration check cannot
  # see them. Every command, field, role and succession name they declare must be on the
  # closed wire vocabulary, which `scripts/shared.mjs` copies in from lattice_core.
  use ExUnit.Case, async: true

  alias Lattice.Carrier.WireVocabulary

  defp replica_modules do
    for module <- Application.spec(:lattice_browser, :modules) || [],
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

  test "every browser replica declaration is on the wire vocabulary" do
    modules = replica_modules()
    assert LatticeBrowser.Notes in modules

    for module <- modules do
      missing = module |> declared_names() |> Enum.uniq() |> Enum.reject(&WireVocabulary.known?/1)

      assert missing == [],
             "#{inspect(module)} names missing from WireVocabulary.names/0: #{inspect(missing)}"
    end
  end
end
