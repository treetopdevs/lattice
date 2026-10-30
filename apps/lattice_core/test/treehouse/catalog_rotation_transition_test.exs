defmodule Treehouse.CatalogRotationTransitionTest do
  use ExUnit.Case, async: true
  alias Treehouse.{CatalogTrust, CatalogTrustVectors, TransportCatalog}
  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @expected %{trust_revision: 0, history_generation: 0}

  @tag timeout: 120_000
  test "fresh TS no-op and distinct-key decisions match the actual BEAM owner" do
    check(peer([]))
  end

  @tag timeout: 120_000
  test "fresh BEAM no-op and distinct-key decisions match the actual TS owner" do
    f = CatalogTrustVectors.fixture()
    path = temporary()
    bundle = CatalogTrustVectors.write_public_fixture!(path)
    rotation_id = TransportCatalog.rotation_id(f.rotation_envelope)
    c1 = %{f.catalog | binding: rotation_id}

    c1json =
      CatalogTrustVectors.artifact_json(CatalogTrustVectors.sign_catalog(c1, f.next_catalog))

    noops =
      for hop <- [0, 1], mode <- [:genuine, :old_forged, :possession_forged] do
        signer = if hop == 0, do: f.space.catalog, else: f.next_catalog

        record = %{
          f.rotation
          | parent: if(hop == 0, do: f.space.bootstrap.id, else: rotation_id),
            prior_catalog:
              if(hop == 0,
                do: TransportCatalog.catalog_id(f.catalog),
                else: TransportCatalog.catalog_id(c1)
              ),
            generation: hop + 1,
            new_catalog_key: signer.pub
        }

        envelope = record |> CatalogTrustVectors.sign_rotation(signer, signer) |> corrupt(mode)
        catalog = %{f.catalog | binding: TransportCatalog.rotation_id(envelope)}

        json =
          CatalogTrustVectors.artifact_json(CatalogTrustVectors.sign_catalog(catalog, signer))

        %{
          name: "noop-hop#{hop}-#{mode}",
          catalogs:
            if(hop == 0, do: [f.catalog_json, json], else: [f.catalog_json, c1json, json]),
          rotations:
            if(hop == 0,
              do: [CatalogTrustVectors.artifact_json(envelope)],
              else: [f.rotation_json, CatalogTrustVectors.artifact_json(envelope)]
            ),
          reason: "invalid_catalog_transition"
        }
      end

    controls =
      for mode <- [:genuine, :old_forged, :possession_forged] do
        envelope = corrupt(f.rotation_envelope, mode)
        catalog = %{f.catalog | binding: TransportCatalog.rotation_id(envelope)}

        json =
          CatalogTrustVectors.artifact_json(
            CatalogTrustVectors.sign_catalog(catalog, f.next_catalog)
          )

        reason =
          case mode do
            :genuine -> nil
            :old_forged -> "invalid_catalog_signature"
            :possession_forged -> "invalid_possession"
          end

        %{
          name: "distinct-#{mode}",
          catalogs: [f.catalog_json, json],
          rotations: [CatalogTrustVectors.artifact_json(envelope)],
          reason: reason
        }
      end

    back = %{
      f.rotation
      | parent: rotation_id,
        prior_catalog: TransportCatalog.catalog_id(c1),
        generation: 2,
        new_catalog_key: f.space.catalog.pub
    }

    envelope = CatalogTrustVectors.sign_rotation(back, f.next_catalog, f.space.catalog)
    catalog = %{f.catalog | binding: TransportCatalog.rotation_id(envelope)}

    back_case = %{
      name: "authorized-ancestor-key-return",
      catalogs: [
        f.catalog_json,
        c1json,
        CatalogTrustVectors.artifact_json(
          CatalogTrustVectors.sign_catalog(catalog, f.space.catalog)
        )
      ],
      rotations: [f.rotation_json, CatalogTrustVectors.artifact_json(envelope)],
      reason: nil,
      generation: 2
    }

    rotation_only = %{hd(noops) | name: "noop-rotation-only", catalogs: [f.catalog_json]}

    File.write!(
      path,
      Jason.encode!(Map.put(bundle, :cases, noops ++ controls ++ [back_case, rotation_only]))
    )

    check(peer(["consume", path]))
  end

  defp peer(args) do
    {output, status} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/catalog_rotation_transition_peer.ts" | args],
        cd: @client,
        stderr_to_stdout: true
      )

    assert status == 0, output
    Jason.decode!(output)
  end

  defp corrupt(envelope, :genuine), do: envelope
  defp corrupt(envelope, :old_forged), do: %{envelope | old_signature: <<0::512>>}
  defp corrupt(envelope, :possession_forged), do: %{envelope | new_signature: <<0::512>>}

  defp check(raw) do
    path = temporary()
    File.write!(path, Jason.encode!(raw["bundle"]))
    b = CatalogTrustVectors.read_ts_fixture!(path)

    %{kind: :propose, next: initial} =
      CatalogTrust.prepare_installation(%{
        review: b.review,
        history: hd(b.histories),
        store: %{kind: :verified_fresh, expected: @expected}
      })

    base = run(initial, [b.catalog_json], [], b)
    assert base.kind == :propose
    assert normalize(base) == raw["base"]
    repair = run(base.next, [b.catalog_json, b.rotated_catalog_json], [b.rotation_json], b)
    assert repair.kind == :propose
    assert repair.next.accepted.generation == 1
    assert length(repair.routes) == 2
    assert normalize(repair) == raw["repair"]
    cases = raw["bundle"]["cases"]
    assert length(raw["results"]) == 11
    assert Enum.all?(raw["results"], &(length(&1["decisions"]) == 2))
    assert length(cases) == 11
    assert length(Enum.uniq_by(cases, & &1["name"])) == 11

    for {c, peer} <- Enum.zip(cases, raw["results"]) do
      assert peer["name"] == c["name"]

      for {state, decision} <- Enum.zip([initial, base.next], peer["decisions"]) do
        result = run(state, c["catalogs"], c["rotations"], b)
        assert normalize(result) == decision

        if c["reason"] == nil do
          assert result.kind == :propose
          assert result.next.accepted.generation == Map.get(c, "generation", 1)
          assert length(result.routes) == 2
        else
          assert result.kind == :reject
          assert Atom.to_string(result.reason) == c["reason"]
        end
      end

      if c["reason"] != nil do
        catalogs =
          Enum.map(c["catalogs"], fn json ->
            {:ok, envelope} = TransportCatalog.decode_catalog_json(json)
            %{id: TransportCatalog.catalog_id(envelope.catalog), json: json}
          end)
          |> Enum.sort_by(& &1.id)

        rotations =
          Enum.map(c["rotations"], fn json ->
            {:ok, value} = json |> Jason.decode!() |> Lattice.Carrier.Wire.decode_value()
            %{id: TransportCatalog.rotation_id(value), json: json}
          end)
          |> Enum.sort_by(& &1.id)

        broken = %{base.next | catalogs: catalogs, rotations: rotations}
        result = run(broken, [b.catalog_json, b.rotated_catalog_json], [b.rotation_json], b)
        assert result.kind == :reject
        assert result.reason == :trust_recovery_required
        assert normalize(result) == peer["saved"]
      end
    end
  end

  defp run(installed, catalogs, rotations, b),
    do:
      CatalogTrust.evaluate(%{
        installed: installed,
        expected: @expected,
        incoming: %{
          catalogs: catalogs,
          rotations: rotations,
          histories: b.histories,
          cutoff_proofs: b.cutoff_proofs
        }
      })

  # Normalize only known DTO metadata, preserving raw frame string values exactly.
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
      Path.join(
        System.tmp_dir!(),
        "catalog-rotation-transition-#{System.unique_integer([:positive])}.json"
      )

    on_exit(fn -> File.rm(path) end)
    path
  end
end
