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

  defp catalog_artifact(tag \\ "one") do
    sha = Journal.digest("envelope-" <> tag)

    %{
      "path" => "/operator/catalog/#{sha}.json",
      "sha256" => sha,
      "kind" => "catalog",
      "replica" => "replica:treehouse:space",
      "op_id" => Base.url_encode64(:crypto.hash(:sha256, "catalog-" <> tag), padding: false),
      "review" => nil
    }
  end

  defp with_catalog(phase, artifacts, head) do
    record = base()

    Journal.encode(%{
      record
      | "phase" => phase,
        "catalog_head" => head,
        "artifacts" => record["artifacts"] ++ artifacts
    })
  end

  defp table do
    phase = fn p -> Journal.encode(%{base() | "phase" => p}) end
    one = catalog_artifact()
    two = catalog_artifact("two")
    op = one["op_id"]
    manifest = hd(base()["artifacts"])
    staged = fn n -> for i <- 1..n, do: %{manifest | "path" => "/operator/attempt/m#{i}"} end

    reference = %{
      one
      | "kind" => "reference",
        "path" => "/operator/attempt/reference",
        "review" => %{"mode" => "initial_existing"}
    }

    initial = fn phase ->
      artifacts = if phase in ["catalogued", "listed"], do: [reference, one], else: [reference]
      with_catalog(phase, artifacts, if(phase in ["catalogued", "listed"], do: op, else: nil))
    end

    review = %{"creation" => op, "grants" => [], "profile_genesis" => op, "profile_id" => op}

    [
      {"carrier_pending", phase.("carrier_pending"), true},
      {"initial pending", initial.("carrier_pending"), true},
      {"initial activated", initial.("activated"), true},
      {"initial ready", initial.("ready"), true},
      {"initial catalogued", initial.("catalogued"), true},
      {"initial listing gated", initial.("listed"), false},
      {"unknown reference mode",
       with_catalog("ready", [%{reference | "review" => %{"mode" => "unknown"}}], nil), false},
      {"reference mode extra field",
       Jason.encode!(%{
         base()
         | "artifacts" => [
             %{reference | "review" => %{"mode" => "initial_existing", "extra" => true}}
           ]
       }), false},
      {"activated", phase.("activated"), true},
      {"ready", phase.("ready"), true},
      {"catalogued bare", phase.("catalogued"), false},
      {"listed bare", phase.("listed"), false},
      {"catalogued with one catalog", with_catalog("catalogued", [one], one["op_id"]), true},
      {"listed with one catalog", with_catalog("listed", [one], one["op_id"]), true},
      {"catalogued without catalog", with_catalog("catalogued", [], nil), false},
      {"catalogued head only", with_catalog("catalogued", [], one["op_id"]), false},
      {"listed without catalog", with_catalog("listed", [], nil), false},
      {"two catalogs", with_catalog("catalogued", [one, two], one["op_id"]), false},
      {"catalog in ready", with_catalog("ready", [one], one["op_id"]), false},
      {"catalog in activated", with_catalog("activated", [one], nil), false},
      {"head differs from artifact", with_catalog("catalogued", [one], two["op_id"]), false},
      {"head nil in catalogued", with_catalog("catalogued", [one], nil), false},
      {"ready with head only", with_catalog("ready", [], one["op_id"]), true},
      {"catalog with review",
       with_catalog("catalogued", [%{one | "review" => review}], one["op_id"]), false},
      {"catalog with null op_id", with_catalog("catalogued", [%{one | "op_id" => nil}], nil),
       false},
      {"catalog with null replica",
       with_catalog("catalogued", [%{one | "replica" => nil}], one["op_id"]), false},
      {"catalog with empty replica",
       with_catalog("catalogued", [%{one | "replica" => ""}], one["op_id"]), false},
      {"128 staged plus the catalog", with_catalog("catalogued", staged.(127) ++ [one], op),
       true},
      {"129 staged plus the catalog", with_catalog("catalogued", staged.(128) ++ [one], op),
       false},
      {"129 staged", with_catalog("ready", staged.(128), nil), false},
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

  @canonical_script """
  import importlib.util, json, sys
  spec = importlib.util.spec_from_file_location("mutation", sys.argv[1])
  owner = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(owner)
  print(json.dumps([owner.canonical(owner.record(raw)) == raw for raw in json.load(sys.stdin)]))
  """

  # The owner refuses to commit any record that is not byte for byte what
  # Journal.encode/1 writes, so its canonical encoder must reproduce Jason's
  # escaping for every string a record can hold.
  test "the owner's canonical bytes equal Journal.encode for awkward strings" do
    python = System.find_executable("python3")

    if python == nil do
      IO.puts("skipping canonical parity: python3 is absent")
    else
      realms =
        Enum.map(1..0x7F, &<<&1::utf8>>) ++
          ["  ", "café", "\\u00ab", "\\\\u000b", "\"quoted\"", "/slash"]

      raws =
        for realm <- realms,
            do: Journal.encode(put_in(base(), ["service", "realm"], "r" <> realm))

      path = Path.join(System.tmp_dir!(), "canonical-#{System.unique_integer([:positive])}.json")
      File.write!(path, Jason.encode!(raws))
      on_exit(fn -> File.rm(path) end)

      {out, 0} =
        System.cmd("sh", [
          "-c",
          ~s(exec "$0" -B -c "$1" "$2" < "$3"),
          python,
          @canonical_script,
          @helper,
          path
        ])

      for {realm, same} <- Enum.zip(realms, Jason.decode!(out)) do
        assert same, "canonical bytes differ for realm #{inspect(realm)}"
      end
    end
  end
end
