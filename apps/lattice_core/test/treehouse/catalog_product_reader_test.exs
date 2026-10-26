defmodule Treehouse.CatalogProductReaderTest do
  use ExUnit.Case, async: true
  alias Lattice.{Identity, Log, Op}
  alias Lattice.Authority.Delegation
  alias Treehouse.{CatalogTrust, CatalogTrustVectors}

  test "public raw incoming reader distinguishes strict scalars from beacon metadata" do
    f = CatalogTrustVectors.fixture()
    [thread] = f.threads
    expected = %{trust_revision: 0, history_generation: 0}

    %{kind: :propose, next: installed} =
      CatalogTrust.prepare_installation(%{
        review: f.review,
        history: CatalogTrustVectors.raw_history(f.space_log),
        store: %{kind: :verified_fresh, expected: expected}
      })

    foreign = Identity.from_seed("foreign", "product-reader-foreign")
    high = 9_007_199_254_740_992
    neutral = Delegation.genesis(foreign, thread.replica, ops: [], roles: [], live: false)

    for {name, kind, body, cap, reason} <- [
          {:safe, :command, high - 1, nil, nil},
          {:unsafe_body, :command, high, nil, :unsupported_cutoff},
          {:unsafe_cap, :command, nil, high, :unsupported_cutoff},
          {:beacon, :authority, {:beacon, high}, nil, nil},
          {:policy_metadata, :authority,
           {:genesis, neutral, %{__beacon__: %{max_epoch_step: high}}}, nil, nil}
        ] do
      op = Op.new(foreign, thread.replica, [], kind, body, cap: cap)
      log = Log.append!(thread.log, op)

      for frames <- [Log.topo_ops(log), Enum.reverse(Log.topo_ops(log))] do
        raw =
          CatalogTrustVectors.raw_history(
            Log.from_ops(thread.replica, Map.new(frames, &{&1.id, &1}))
          )

        decision =
          CatalogTrust.evaluate(%{
            installed: installed,
            expected: expected,
            incoming: %{
              catalogs: [f.catalog_json],
              rotations: [],
              cutoff_proofs: [],
              histories: [CatalogTrustVectors.raw_history(f.space_log), raw]
            }
          })

        assert decision.reason == reason, inspect(name)
        assert decision.kind == if(reason, do: :reject, else: :propose)
      end
    end
  end
end
