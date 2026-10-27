defmodule Treehouse.CatalogRetainedIndexOrderTest do
  use ExUnit.Case, async: false
  alias Lattice.Identity
  alias Treehouse.{CatalogTrust, CatalogTrustVectors, TransportCatalog}
  Code.require_file("../../../../scripts/support/catalog_resolver_json.exs", __DIR__)
  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @expected %{trust_revision: 0, history_generation: 0}

  @tag timeout: 300_000
  test "fresh TypeScript full decisions match BEAM across retained row order" do
    table = peer([])
    assert length(table["cases"]) == 11

    for item <- table["cases"], {order, index} <- Enum.with_index(item["orders"]) do
      decision = order["input"] |> NativeCatalogResolverPeer.input() |> CatalogTrust.evaluate()

      assert NativeCatalogResolverPeer.output(decision) == order["decision"],
             "#{item["name"]} order=#{index}"
    end
  end

  @tag timeout: 300_000
  test "independent BEAM states preserve unique set indexes and canonical proof refusals" do
    f = CatalogTrustVectors.fixture(2)

    prepared =
      CatalogTrust.prepare_installation(%{
        review: f.review,
        history: hd(f.histories),
        store: %{kind: :verified_fresh, expected: @expected}
      })

    assert prepared.kind == :propose
    accepted = run(prepared.next, %{empty() | catalogs: [f.catalog_json], histories: f.histories})
    assert accepted.kind == :propose
    first = rotate(f, accepted.next, f.space.catalog, f.next_catalog, 1)
    third = Identity.from_seed("retained-index-third", "retained-index-third-key")
    second = rotate(f, first.next, f.next_catalog, third, 2)
    state = second.next
    assert length(state.rotations) == 2
    assert length(state.catalogs) == 3
    assert length(state.histories) == 3

    blocked = fork(f, state)
    assert length(blocked.blocked.catalogs) >= 2

    cases =
      permutations(state, "accepted", nil) ++ permutations(blocked, "blocked", :catalog_fork)

    duplicates =
      Enum.map([:histories, :catalogs, :rotations], fn field ->
        %{
          name: "duplicate-#{field}",
          input: %{
            installed: Map.update!(state, field, &(&1 ++ [hd(&1)])),
            expected: @expected,
            incoming: empty()
          },
          reason: :trust_recovery_required
        }
      end)

    corrupt =
      update_in(state.histories, fn [history | rest] ->
        [
          Map.update!(history, :frames, fn [frame | frames] ->
            [Map.put(frame, "sig", Base.encode64(<<0::512>>)) | frames]
          end)
          | rest
        ]
      end)

    negative = [
      %{
        name: "proof-index-order",
        input: %{
          installed: %{state | cutoff_proofs: Enum.reverse(state.cutoff_proofs)},
          expected: @expected,
          incoming: empty()
        },
        reason: :trust_recovery_required
      },
      %{
        name: "corrupt-before-repair",
        input: %{
          installed: corrupt,
          expected: @expected,
          incoming: %{empty() | histories: f.histories, catalogs: [f.catalog_json]}
        },
        reason: :trust_recovery_required
      },
      %{
        name: "missing-accepted-support",
        input: %{
          installed: %{
            state
            | catalogs: Enum.reject(state.catalogs, &(&1.id == state.accepted.catalog))
          },
          expected: @expected,
          incoming: empty()
        },
        reason: :trust_recovery_required
      },
      %{
        name: "malformed-history",
        input: %{
          installed: %{state | histories: state.histories ++ [nil]},
          expected: @expected,
          incoming: empty()
        },
        reason: :trust_recovery_required
      }
    ]

    negative =
      negative ++
        [
          %{
            name: "blocked-proof-index-order",
            input: %{
              installed: %{blocked | cutoff_proofs: Enum.reverse(blocked.cutoff_proofs)},
              expected: @expected,
              incoming: empty()
            },
            reason: :trust_recovery_required
          },
          %{
            name: "blocked-witness-index-order",
            input: %{
              installed: put_in(blocked.blocked.catalogs, Enum.reverse(blocked.blocked.catalogs)),
              expected: @expected,
              incoming: empty()
            },
            reason: :trust_recovery_required
          }
        ]

    cases = cases ++ duplicates ++ negative

    path =
      Path.join(
        System.tmp_dir!(),
        "catalog-index-order-#{System.unique_integer([:positive])}.json"
      )

    on_exit(fn -> File.rm(path) end)

    File.write!(
      path,
      Jason.encode!(%{
        cases:
          Enum.map(cases, &%{name: &1.name, input: NativeCatalogResolverPeer.output(&1.input)})
      })
    )

    actual = peer(["consume", path])["results"]
    assert length(actual) == length(cases)

    for {item, expected} <- Enum.zip(cases, actual) do
      decision = CatalogTrust.evaluate(item.input)
      assert decision.reason == item.reason, item.name

      check_decision(decision, item.reason, state.accepted)
      assert NativeCatalogResolverPeer.output(decision) == expected["decision"], item.name
    end
  end

  @tag timeout: 300_000
  test "unadmitted overflow and triggered reopen retain original artifact order in both owners" do
    f = CatalogTrustVectors.fixture(0)

    prepared =
      CatalogTrust.prepare_installation(%{
        review: f.review,
        history: hd(f.histories),
        store: %{kind: :verified_fresh, expected: @expected}
      })

    assert prepared.kind == :propose

    {records, accepted} =
      Enum.reduce(0..1022, {[], nil}, fn revision, {records, previous} ->
        catalog = %{f.catalog | revision: revision, previous: previous && previous.catalog}
        id = TransportCatalog.catalog_id(catalog)
        record = %{id: id, json: artifact_json(catalog, f.space.catalog)}

        {[record | records],
         %{binding: f.space.bootstrap.id, generation: 0, catalog: id, revision: revision}}
      end)

    records = records |> Enum.sort_by(& &1.id) |> Enum.reverse()
    state = %{prepared.next | catalogs: records, accepted: accepted}
    assert records != Enum.sort_by(records, & &1.id)
    first = %{f.catalog | revision: 1023, previous: accepted.catalog}
    second = %{f.catalog | revision: 1024, previous: TransportCatalog.catalog_id(first)}

    input = %{
      installed: state,
      expected: @expected,
      incoming: %{
        empty()
        | catalogs: [
            artifact_json(first, f.space.catalog),
            artifact_json(second, f.space.catalog)
          ]
      }
    }

    overflow = CatalogTrust.evaluate(input)
    assert overflow.kind == :retain_blocked
    assert overflow.reason == :control_history_limit
    assert length(overflow.next.blocked.triggers) == 2
    assert overflow.next.catalogs == records
    assert overflow.routes == []
    reopen = %{installed: overflow.next, expected: @expected, incoming: empty()}
    reopened = CatalogTrust.evaluate(reopen)
    assert reopened.kind == :retain_blocked
    assert reopened.next.catalogs == records
    assert reopened.next.blocked == overflow.next.blocked

    path =
      Path.join(
        System.tmp_dir!(),
        "catalog-index-overflow-#{System.unique_integer([:positive])}.json"
      )

    on_exit(fn -> File.rm(path) end)

    File.write!(
      path,
      Jason.encode!(%{
        cases:
          Enum.map([{"overflow", input}, {"triggered-reopen", reopen}], fn {name, request} ->
            %{name: name, input: NativeCatalogResolverPeer.output(request)}
          end)
      })
    )

    expected = peer(["consume", path])["results"]
    assert length(expected) == 2
    assert NativeCatalogResolverPeer.output(overflow) == Enum.at(expected, 0)["decision"]
    assert NativeCatalogResolverPeer.output(reopened) == Enum.at(expected, 1)["decision"]
  end

  defp artifact_json(catalog, signer),
    do: catalog |> CatalogTrustVectors.sign_catalog(signer) |> CatalogTrustVectors.artifact_json()

  defp permutations(state, prefix, reason) do
    Enum.map([:histories, :catalogs, :rotations], fn field ->
      %{
        name: "#{prefix}-reordered-#{field}",
        input: %{
          installed: Map.update!(state, field, &Enum.reverse/1),
          expected: @expected,
          incoming: empty()
        },
        reason: reason
      }
    end)
  end

  defp fork(f, state) do
    catalog = %{f.catalog | revision: 1, previous: TransportCatalog.catalog_id(f.catalog)}

    json =
      catalog
      |> CatalogTrustVectors.sign_catalog(f.space.catalog)
      |> CatalogTrustVectors.artifact_json()

    result = run(state, %{empty() | catalogs: [json]})
    assert result.kind == :retain_blocked
    assert result.reason == :catalog_fork
    result.next
  end

  defp check_decision(decision, nil, accepted) do
    assert decision.kind == :propose
    assert decision.next.accepted == accepted
    assert length(decision.routes) == 3
  end

  defp check_decision(decision, :catalog_fork, accepted) do
    assert decision.kind == :retain_blocked
    assert decision.next.accepted == accepted
    assert decision.routes == []
  end

  defp check_decision(decision, _refusal, _accepted), do: assert(decision.kind == :reject)

  defp rotate(f, state, old, next, generation) do
    prior = Enum.find(state.catalogs, &(&1.id == state.accepted.catalog))
    {:ok, envelope} = TransportCatalog.decode_catalog_json(prior.json)

    rotation = %{
      f.rotation
      | parent: state.accepted.binding,
        prior_catalog: prior.id,
        generation: generation,
        new_catalog_key: next.pub,
        nonce: CatalogTrustVectors.id("index-order-rotation-#{generation}")
    }

    signed = CatalogTrustVectors.sign_rotation(rotation, old, next)

    catalog = %{
      envelope.catalog
      | binding: TransportCatalog.rotation_id(signed),
        revision: 0,
        previous: nil
    }

    json =
      catalog |> CatalogTrustVectors.sign_catalog(next) |> CatalogTrustVectors.artifact_json()

    result =
      run(state, %{
        empty()
        | catalogs: [json],
          rotations: [CatalogTrustVectors.artifact_json(signed)],
          cutoff_proofs: f.cutoff_proofs
      })

    assert result.kind == :propose
    assert result.next.accepted.generation == generation
    result
  end

  defp empty, do: %{catalogs: [], rotations: [], histories: [], cutoff_proofs: []}

  defp run(state, incoming),
    do: CatalogTrust.evaluate(%{installed: state, expected: @expected, incoming: incoming})

  defp peer(args) do
    {output, status} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/native_catalog_resolver_peer.ts" | args],
        cd: @client,
        stderr_to_stdout: true
      )

    assert status == 0, output
    Jason.decode!(output)
  end
end
