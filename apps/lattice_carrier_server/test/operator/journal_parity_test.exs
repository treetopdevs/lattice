defmodule LatticeCarrierServer.Operator.JournalParityTest do
  # The BEAM validator and the mutation owner's record() are two copies of one
  # contract; this table feeds both the same bytes and requires the same verdict.
  use ExUnit.Case, async: true
  alias LatticeCarrierServer.Operator.Journal

  @helper Path.expand("../../../../scripts/treehouse_operator_mutation.py", __DIR__)

  @script """
  import importlib.util, json, sys
  spec = importlib.util.spec_from_file_location("mutation", sys.argv[1])
  owner = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(owner)
  out = []
  for raw in json.load(sys.stdin):
      try:
          owner.record(raw)
          out.append(True)
      except owner.Refusal:
          out.append(False)
  print(json.dumps(out))
  """

  defp base do
    %{
      "version" => 1,
      "phase" => "carrier_pending",
      "attempt" => Base.url_encode64(:crypto.hash(:sha256, "attempt"), padding: false),
      "generation" => 0,
      "catalog_head" => nil,
      "manifest_digest" => Journal.digest("manifest"),
      "artifacts" => [
        %{
          "path" => "/operator/attempt/manifest",
          "sha256" => Journal.digest("artifact"),
          "kind" => "manifest",
          "replica" => nil,
          "op_id" => nil,
          "review" => nil
        }
      ],
      "service" => %{
        "identity_file" => "/srv/lattice/child-service.identity",
        "realm" => "child-service",
        "pub" => Base.encode64(:crypto.hash(:sha256, "pub")),
        "sha256" => Journal.digest("identity")
      }
    }
  end

  defp table do
    phase = fn p -> Journal.encode(%{base() | "phase" => p}) end

    [
      {"carrier_pending", phase.("carrier_pending"), true},
      {"activated", phase.("activated"), true},
      {"ready", phase.("ready"), true},
      {"catalogued", phase.("catalogued"), false},
      {"listed", phase.("listed"), false},
      {"wrong case", phase.("Ready"), false},
      {"null phase", phase.(nil), false},
      {"missing service", Journal.encode(Map.delete(base(), "service")), false},
      {"missing phase", Journal.encode(Map.delete(base(), "phase")), false},
      {"extra field", Jason.encode!(Map.put(base(), "extra", 1)), false},
      {"not json", "not json", false}
    ]
  end

  test "both validators accept and refuse the same record bytes" do
    python = System.find_executable("python3")

    if python == nil do
      IO.puts("skipping validator parity: python3 is absent")
    else
      rows = table()
      payload = Jason.encode!(Enum.map(rows, fn {_, raw, _} -> raw end))
      path = Path.join(System.tmp_dir!(), "parity-#{System.unique_integer([:positive])}.json")
      File.write!(path, payload)
      on_exit(fn -> File.rm(path) end)

      {out, 0} =
        System.cmd("sh", [
          "-c",
          ~s(exec "$0" -B -c "$1" "$2" < "$3"),
          python,
          @script,
          @helper,
          path
        ])

      python_verdicts = Jason.decode!(out)

      for {{name, raw, expected}, py} <- Enum.zip(rows, python_verdicts) do
        beam = match?({:ok, _}, Journal.decode(raw))
        assert beam == expected, "BEAM verdict for #{name}"
        assert py == expected, "Python verdict for #{name}"
      end
    end
  end
end
