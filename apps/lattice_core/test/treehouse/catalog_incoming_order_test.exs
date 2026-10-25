defmodule Treehouse.CatalogIncomingOrderTest do
  use ExUnit.Case, async: true

  alias Treehouse.CatalogTrust

  @client Path.expand("../../../../clients/lattice-client", __DIR__)

  test "incoming signatures precede missing ancestors and unsupported vocabulary" do
    {json, 0} =
      System.cmd("node", ["--import", "tsx", "test/support/catalog_incoming_order_probe.ts"],
        cd: @client
      )

    raw = Jason.decode!(json)
    r = raw["review"]

    review = %{
      version: 1,
      product: :treehouse,
      space: r["space"],
      space_root: Base.decode64!(r["spaceRoot"]),
      bootstrap_id: r["bootstrapId"],
      observed_bootstrap_ids: r["observedBootstrapIds"],
      disposition: :pin_exact_observed_bootstrap
    }

    baseline = raw["baselineHistory"]

    %{kind: :propose, next: installed} =
      CatalogTrust.prepare_installation(%{
        review: review,
        history: %{replica: baseline["replica"], frames: baseline["frames"], rejected: []},
        store: %{kind: :verified_fresh, expected: %{trust_revision: 0, history_generation: 0}}
      })

    for c <- raw["cases"],
        frames <- [c["history"]["frames"], Enum.reverse(c["history"]["frames"])],
        raw_rejected <- [c["history"]["rejected"], Enum.reverse(c["history"]["rejected"])] do
      if c["name"] in [
           "extra-header-and-missing",
           "wrong-version-and-missing",
           "missing-version-and-missing"
         ] do
        assert c["ts"]["reason"] == "invalid_verified_history"
        assert c["ts"]["detail"]["ids"] == []
      end

      expected = %{
        "unknown-kind-complete" => {"reject", "unsupported_cutoff"},
        "unknown-kind-partial" => {"reject", "trust_pending"},
        "push-64000-complete" => {"propose", nil},
        "push-64001-complete" => {"reject", "unsupported_cutoff"},
        "push-64000-partial" => {"reject", "trust_pending"},
        "push-64001-partial" => {"reject", "trust_pending"},
        "map-65-delegation-leaf-complete" => {"reject", "unsupported_cutoff"},
        "map-65-delegation-leaf-partial" => {"reject", "trust_pending"},
        "map-64-delegation-leaf-complete" => {"propose", nil},
        "map-64-delegation-leaf-partial" => {"reject", "trust_pending"},
        "map-depth-64-complete" => {"propose", nil},
        "map-depth-65-complete" => {"reject", "unsupported_cutoff"},
        "map-depth-66-complete" => {"reject", "invalid_verified_history"},
        "map-depth-65-partial" => {"reject", "trust_pending"},
        "map-depth-66-partial" => {"reject", "invalid_verified_history"},
        "depth-64-complete" => {"propose", nil},
        "depth-65-complete" => {"reject", "unsupported_cutoff"},
        "depth-66-complete" => {"reject", "invalid_verified_history"},
        "depth-65-partial" => {"reject", "trust_pending"},
        "depth-66-partial" => {"reject", "invalid_verified_history"},
        "genuine-unknown-mislabeled-rejected" => {"reject", "invalid_verified_history"},
        "forged-unknown-rejected" => {"reject", "unsupported_cutoff"},
        "empty-id-rejected" => {"reject", "unsupported_cutoff"},
        "forged-same-id-rejected" => {"propose", nil},
        "partial-with-genuine-rejected" => {"reject", "invalid_verified_history"},
        "extra-rejected-record-field" => {"reject", "invalid_verified_history"},
        "mixed-rejected-integrity" => {"reject", "invalid_verified_history"}
      }

      if Map.has_key?(expected, c["name"]),
        do: assert({c["ts"]["kind"], c["ts"]["reason"]} == expected[c["name"]])

      if String.starts_with?(c["name"], "forged-depth-") or
           String.starts_with?(c["name"], "forged-unknown-kind-") do
        assert c["ts"]["reason"] == "invalid_verified_history"
        assert c["ts"]["detail"]["ids"] == []
      end

      if c["name"] == "map-64-delegation-leaf-complete" do
        [frame] = Enum.filter(frames, fn f -> match?(["map", _], f["body"]) end)
        assert {:ok, _} = Lattice.Carrier.Wire.decode_op(frame)
      end

      if c["name"] == "depth-65-complete" do
        # The producer adds exactly one nested domain term to the valid baseline.
        [frame] = Enum.filter(frames, fn f -> match?(["list", _], f["body"]) end)
        assert {:ok, _} = Lattice.Carrier.Wire.authenticate_observation(frame)
        assert {:error, :malformed_op} = Lattice.Carrier.Wire.decode_op(frame)
      end

      rejected = Enum.map(raw_rejected, &decode_rejected/1)
      history = %{replica: c["history"]["replica"], frames: frames, rejected: rejected}

      actual =
        CatalogTrust.prepare_installation(%{
          review: review,
          history: history,
          store: %{kind: :verified_fresh, expected: %{trust_revision: 0, history_generation: 0}}
        })

      assert Atom.to_string(actual.kind) == c["ts"]["kind"], c["name"]
      assert if(actual.reason, do: Atom.to_string(actual.reason)) == c["ts"]["reason"], c["name"]
      assert actual.detail.ids == c["ts"]["detail"]["ids"], c["name"]

      evaluated =
        CatalogTrust.evaluate(%{
          installed: installed,
          expected: %{trust_revision: 0, history_generation: 0},
          incoming: %{catalogs: [], rotations: [], histories: [history], cutoff_proofs: []}
        })

      assert Atom.to_string(evaluated.kind) == c["tsEvaluation"]["kind"],
             "evaluation #{c["name"]}"

      assert if(evaluated.reason, do: Atom.to_string(evaluated.reason)) ==
               c["tsEvaluation"]["reason"],
             "evaluation #{c["name"]}"

      assert evaluated.detail.ids == c["tsEvaluation"]["detail"]["ids"], "evaluation #{c["name"]}"
    end
  end

  @tag timeout: 180_000
  test "raw observation resource budgets are exact at their actual maxima" do
    {output, status} =
      System.cmd("node", ["--import", "tsx", "--test", "test/treehouse_catalog_raw_bounds.ts"],
        cd: @client
      )

    assert status == 0, output
  end

  @tag :tmp_dir
  test "fresh BEAM unknown-name frames match the actual TS owner without atom interning", %{
    tmp_dir: dir
  } do
    alias Lattice.{Canonical, Op}
    alias Lattice.Carrier.Wire
    alias Treehouse.CatalogTrustVectors
    f = CatalogTrustVectors.fixture(0)
    name = "incoming_unknown_#{System.unique_integer([:positive])}"
    assert_raise ArgumentError, fn -> String.to_existing_atom(name) end
    missing = CatalogTrustVectors.id("incoming-missing")
    op = Op.new(f.space.root, f.space.replica, [missing], :command, %Canonical.Atom{name: name})
    frame = Wire.encode_op(op)
    {:ok, proof} = Wire.authenticate_observation(frame)
    assert proof == %{id: op.id, replica: op.replica, deps: [missing]}
    assert {:error, :malformed_op} = Wire.decode_op(frame)
    assert_raise ArgumentError, fn -> String.to_existing_atom(name) end
    r = f.review

    review = %{
      version: 1,
      product: "treehouse",
      space: r.space,
      spaceRoot: Base.encode64(r.space_root),
      bootstrapId: r.bootstrap_id,
      observedBootstrapIds: r.observed_bootstrap_ids,
      disposition: "pin_exact_observed_bootstrap"
    }

    empty_dep =
      Op.new(f.space.root, f.space.replica, [""], :command, %Canonical.Atom{name: name})
      |> Wire.encode_op()

    assert {:ok, %{deps: [""]}} = Wire.authenticate_observation(empty_dep)

    cases =
      Enum.map(
        [
          {"signed", frame},
          {"forged", Map.put(frame, "sig", Base.encode64(<<0::512>>))},
          {"empty-dependency", empty_dep}
        ],
        fn {name, value} ->
          %{name: name, history: %{replica: f.space.replica, frames: [value], rejected: []}}
        end
      )

    baseline_history = CatalogTrustVectors.raw_history(f.space_log)

    cases =
      cases ++
        [
          %{
            name: "beam-genuine-rejected",
            history: %{
              baseline_history
              | rejected: [%{"frame" => frame, "reason" => "bad_signature"}]
            }
          },
          %{
            name: "beam-forged-rejected",
            history: %{
              baseline_history
              | rejected: [
                  %{
                    "frame" => Map.put(frame, "sig", Base.encode64(<<0::512>>)),
                    "reason" => "bad_signature"
                  }
                ]
            }
          },
          %{
            name: "beam-good-and-rejected-same-id",
            history: %{
              baseline_history
              | rejected: [
                  %{
                    "frame" =>
                      Map.put(hd(baseline_history.frames), "sig", Base.encode64(<<0::512>>)),
                    "reason" => "bad_signature"
                  }
                ]
            }
          }
        ]

    %{kind: :propose, next: installed} =
      CatalogTrust.prepare_installation(%{
        review: r,
        history: baseline_history,
        store: %{kind: :verified_fresh, expected: %{trust_revision: 0, history_generation: 0}}
      })

    path = Path.join(dir, "fresh-beam.json")

    File.write!(
      path,
      Jason.encode!(%{
        review: review,
        baselineHistory: CatalogTrustVectors.raw_history(f.space_log),
        cases: cases
      })
    )

    {json, 0} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/catalog_incoming_order_probe.ts", "--consume", path],
        cd: @client
      )

    results = Jason.decode!(json)["cases"]

    for {input, result} <- Enum.zip(cases, results) do
      history = %{input.history | rejected: Enum.map(input.history.rejected, &decode_rejected/1)}

      actual =
        CatalogTrust.prepare_installation(%{
          review: r,
          history: history,
          store: %{kind: :verified_fresh, expected: %{trust_revision: 0, history_generation: 0}}
        })

      assert if(actual.reason, do: Atom.to_string(actual.reason)) == result["ts"]["reason"]
      assert actual.detail.ids == result["ts"]["detail"]["ids"]

      evaluated =
        CatalogTrust.evaluate(%{
          installed: installed,
          expected: %{trust_revision: 0, history_generation: 0},
          incoming: %{catalogs: [], rotations: [], histories: [history], cutoff_proofs: []}
        })

      assert Atom.to_string(evaluated.kind) == result["tsEvaluation"]["kind"]

      assert if(evaluated.reason, do: Atom.to_string(evaluated.reason)) ==
               result["tsEvaluation"]["reason"]

      assert evaluated.detail.ids == result["tsEvaluation"]["detail"]["ids"]
    end
  end

  defp decode_rejected(record) when is_map(record) do
    Map.new(record, fn
      {"frame", value} -> {:frame, value}
      {"reason", "bad_signature"} -> {:reason, :bad_signature}
      {"reason", _} -> {:reason, :invalid_reason}
      pair -> pair
    end)
  end

  defp decode_rejected(record), do: record
end
