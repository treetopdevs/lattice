defmodule Treehouse.CatalogArtifactIntegerTest do
  use ExUnit.Case, async: true
  alias Treehouse.{CatalogTrust, CatalogTrustVectors}
  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @expected %{trust_revision: 0, history_generation: 0}

  @tag timeout: 120_000
  test "fresh TypeScript raw artifact spellings agree with BEAM" do
    {json, 0} =
      System.cmd("node", ["--import", "tsx", "test/support/catalog_artifact_integer_peer.ts"],
        cd: @client
      )

    check(Jason.decode!(json))
  end

  @tag timeout: 120_000
  test "fresh BEAM raw artifact spellings agree with actual TypeScript" do
    path = temporary()
    CatalogTrustVectors.write_public_fixture!(path)

    {json, 0} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/catalog_artifact_integer_peer.ts", "consume", path],
        cd: @client
      )

    check(Jason.decode!(json))
  end

  defp check(raw) do
    path = temporary()
    File.write!(path, Jason.encode!(raw["bundle"]))
    b = CatalogTrustVectors.read_ts_fixture!(path)

    prepared =
      CatalogTrust.prepare_installation(%{
        review: b.review,
        history: hd(b.histories),
        store: %{kind: :verified_fresh, expected: @expected}
      })

    assert prepared.kind == :propose
    base = run(prepared.next, %{catalogs: [b.catalog_json], histories: b.histories})
    assert base.kind == :propose

    rotated =
      run(base.next, %{
        catalogs: [b.rotated_catalog_json],
        rotations: [b.rotation_json],
        cutoff_proofs: b.cutoff_proofs
      })

    assert rotated.kind == :propose
    assert rotated.next.accepted.generation == 1
    assert_same(normalize(base), raw["base"])
    assert_same(normalize(rotated), raw["rotated"])

    for c <- raw["controls"] do
      state = if c["rotation"], do: base.next, else: prepared.next

      incoming =
        if c["rotation"],
          do: %{
            rotations: [c["json"]],
            catalogs: [b.rotated_catalog_json],
            cutoff_proofs: b.cutoff_proofs
          },
          else: %{catalogs: [c["json"]], histories: b.histories}

      d = run(state, incoming)
      assert d.kind == :propose
      assert_same(normalize(d), c["result"])

      oversized =
        if c["rotation"],
          do: %{rotations: [c["json"] <> " "]},
          else: %{catalogs: [c["json"] <> " "]}

      assert_same(normalize(run(state, oversized)), c["over"])
    end

    for c <- raw["cases"] do
      states = if c["rotation"], do: [base.next, rotated.next], else: [prepared.next, base.next]

      incoming =
        if c["rotation"],
          do: %{
            rotations: [c["json"]],
            catalogs: [b.rotated_catalog_json],
            cutoff_proofs: b.cutoff_proofs
          },
          else: %{catalogs: [c["json"]], histories: b.histories}

      for {state, peer} <- Enum.zip(states, c["results"]) do
        d = run(state, incoming)
        assert d.kind == :reject
        assert d.reason == :malformed_catalog
        assert_same(normalize(d), peer)
      end

      broken =
        if c["rotation"] do
          [row | rest] = rotated.next.rotations
          %{rotated.next | rotations: [%{row | json: c["json"]} | rest]}
        else
          [row | rest] = base.next.catalogs
          %{base.next | catalogs: [%{row | json: c["json"]} | rest]}
        end

      saved =
        run(broken, %{
          catalogs: [b.catalog_json, b.rotated_catalog_json],
          rotations: [b.rotation_json],
          histories: b.histories,
          cutoff_proofs: b.cutoff_proofs
        })

      assert saved.kind == :reject
      assert saved.reason == :trust_recovery_required
      assert_same(normalize(saved), c["saved"])
    end
  end

  defp assert_same(left, right) do
    assert differences(left, right, []) == []
  end

  defp differences(a, a, _path), do: []

  defp differences(a, b, path) when is_map(a) and is_map(b) do
    (Map.keys(a) ++ Map.keys(b))
    |> Enum.uniq()
    |> Enum.flat_map(fn k ->
      differences(Map.get(a, k, :missing), Map.get(b, k, :missing), path ++ [k])
    end)
  end

  defp differences(a, b, path) when is_list(a) and is_list(b) and length(a) == length(b),
    do:
      Enum.zip(a, b)
      |> Enum.with_index()
      |> Enum.flat_map(fn {{x, y}, i} -> differences(x, y, path ++ [i]) end)

  defp differences(a, b, path), do: [{path, a, b}]

  # Convert only known DTO metadata atoms. Raw frame string keys/values stay exact.
  defp normalize(value) when is_map(value),
    do:
      Map.new(value, fn {k, v} ->
        {key(k),
         if(k in [:space_root, :root, :service_key, :catalog_key, :new_key] and is_binary(v),
           do: Base.encode64(v),
           else: normalize(v)
         )}
      end)

  defp normalize(value) when is_list(value), do: Enum.map(value, &normalize/1)
  defp normalize(value) when value in [nil, true, false], do: value
  defp normalize(value) when is_atom(value), do: Atom.to_string(value)
  defp normalize(value), do: value

  defp key(value) when is_atom(value),
    do:
      value
      |> Atom.to_string()
      |> then(fn s -> Regex.replace(~r/_([a-z])/, s, fn _, c -> String.upcase(c) end) end)

  defp key(value), do: value

  defp temporary do
    path =
      Path.join(System.tmp_dir!(), "catalog-integer-#{System.unique_integer([:positive])}.json")

    on_exit(fn -> File.rm(path) end)
    path
  end

  defp run(installed, incoming),
    do:
      CatalogTrust.evaluate(%{
        installed: installed,
        expected: @expected,
        incoming:
          Map.merge(%{catalogs: [], rotations: [], histories: [], cutoff_proofs: []}, incoming)
      })
end
