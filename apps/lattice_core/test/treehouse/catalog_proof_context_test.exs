defmodule Treehouse.CatalogProofContextTest do
  use ExUnit.Case, async: true
  alias Lattice.Carrier.Wire
  alias Lattice.{Log, Op}
  alias Treehouse.{CatalogCutoff, CatalogTrust, CatalogTrustVectors}
  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @expected %{trust_revision: 0, history_generation: 0}

  test "fresh TypeScript complete proofs agree with BEAM without becoming incremental fetches" do
    {json, 0} =
      System.cmd("node", ["--import", "tsx", "test/support/catalog_proof_context_peer.ts"],
        cd: @client
      )

    check_bundle(Jason.decode!(json))
  end

  test "fresh BEAM complete proofs agree with the actual TypeScript owner" do
    directory =
      Path.join(System.tmp_dir!(), "catalog-proof-context-#{System.unique_integer([:positive])}")

    File.mkdir_p!(directory)
    on_exit(fn -> File.rm_rf!(directory) end)
    path = Path.join(directory, "beam.json")
    File.write!(path, Jason.encode!(beam_bundle()))

    {json, 0} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/catalog_proof_context_peer.ts", "consume", path],
        cd: @client
      )

    check_bundle(Jason.decode!(json))
  end

  defp check_bundle(raw) do
    b = raw["bundle"]
    assert_raise ArgumentError, fn -> String.to_existing_atom(b["unknownName"]) end
    r = b["review"]

    review = %{
      version: 1,
      product: :treehouse,
      space: r["space"],
      space_root: Base.decode64!(r["spaceRoot"]),
      bootstrap_id: r["bootstrapId"],
      observed_bootstrap_ids: r["observedBootstrapIds"],
      disposition: :pin_exact_observed_bootstrap
    }

    histories = Enum.map(b["histories"], &history/1)

    prepared =
      CatalogTrust.prepare_installation(%{
        review: review,
        history: hd(histories),
        store: %{kind: :verified_fresh, expected: @expected}
      })

    assert prepared.kind == :propose
    base = evaluate(prepared.next, %{page() | catalogs: [b["catalogJson"]], histories: histories})
    assert base.kind == :propose
    assert base.next.accepted.revision == 0
    assert length(base.routes) == 2

    proofs =
      Enum.map(b["proofs"], &%{cutoff: cutoff(&1["cutoff"]), history: history(&1["history"])})

    with_proofs = evaluate(base.next, %{page() | cutoff_proofs: proofs})
    assert with_proofs.kind == :propose
    assert length(with_proofs.next.cutoff_proofs) == 2
    [first | _] = with_proofs.next.cutoff_proofs

    for broken <- [Enum.reverse(with_proofs.next.cutoff_proofs), [first, first]] do
      d = evaluate(%{with_proofs.next | cutoff_proofs: broken}, %{page() | cutoff_proofs: proofs})
      assert d.kind == :reject
      assert d.reason == :trust_recovery_required
      assert d.detail.ids == []
    end

    cutoff = cutoff(b["cutoff"])
    wrong_digest = b["wrongDigest"]
    valid = %{cutoff: cutoff, history: hd(histories)}

    cases =
      Enum.map(
        b["cases"],
        &{&1["name"],
         %{
           cutoff: if(&1["cutoff"], do: cutoff(&1["cutoff"]), else: cutoff),
           history: history(&1["history"])
         }}
      ) ++
        [
          {"malformed-proof", Map.put(valid, :extra, true)},
          {"malformed-cutoff", %{valid | cutoff: Map.put(cutoff, :extra, true)}},
          {"wrong-cutoff", %{valid | cutoff: %{cutoff | log_digest: wrong_digest}}}
        ]

    for {name, proof} <- cases do
      d = evaluate(base.next, %{page() | cutoff_proofs: [proof]})
      peer = Enum.find(raw["results"], &(&1["name"] == name))
      assert Atom.to_string(d.kind) == peer["kind"]
      assert (d.reason && Atom.to_string(d.reason)) == peer["reason"]
      assert d.detail.ids == peer["ids"]

      if name in ["valid", "valid-prefix"] do
        assert d.kind == :propose
        assert d.reason == nil
        assert length(d.routes) == 2
        assert d.next.accepted == base.next.accepted
        assert length(d.next.cutoff_proofs) == 1
        reopened = evaluate(d.next, page())
        assert reopened.kind == :unchanged
        assert reopened.next == d.next

        if name == "valid", do: assert_saved_corruption(d.next, proof, wrong_digest, b["cases"])
      else
        assert d.kind == :reject

        assert d.detail.ids ==
                 if(name in ["absent-member", "wrong-cutoff"],
                   do: [proof.cutoff.log_digest],
                   else: []
                 )

        assert d.reason ==
                 if(name in ["malformed-proof", "malformed-cutoff"],
                   do: :malformed_catalog,
                   else: :recovery_incomplete
                 )
      end
    end

    assert_raise ArgumentError, fn -> String.to_existing_atom(b["unknownName"]) end
  end

  defp assert_saved_corruption(state, proof, wrong_digest, cases) do
    broken = %{
      state
      | cutoff_proofs: [%{proof | cutoff: %{proof.cutoff | log_digest: wrong_digest}}]
    }

    recovered = evaluate(broken, %{page() | cutoff_proofs: [proof]})
    assert recovered.kind == :reject
    assert recovered.reason == :trust_recovery_required
    assert recovered.detail.ids == []

    for defect <- Enum.reject(cases, &(&1["name"] in ["valid", "valid-prefix", "absent-member"])) do
      broken = %{state | cutoff_proofs: [%{proof | history: history(defect["history"])}]}
      recovered = evaluate(broken, %{page() | cutoff_proofs: [proof]})
      assert recovered.kind == :reject
      assert recovered.reason == :trust_recovery_required
      assert recovered.detail.ids == []
    end
  end

  defp beam_bundle do
    f = CatalogTrustVectors.fixture(1)
    h = hd(f.histories)

    unknown_name = "proof_future_#{System.unique_integer([:positive])}"

    unknown =
      Op.new(f.space.root, f.space.replica, [], :command, %Lattice.Canonical.Atom{
        name: unknown_name
      })
      |> Wire.encode_op()

    partial =
      Op.new(
        f.space.root,
        f.space.replica,
        [CatalogTrustVectors.id("proof-missing")],
        :command,
        :post
      )
      |> Wire.encode_op()

    proof = Enum.find(f.cutoff_proofs, &(&1.cutoff.replica == f.space.replica))
    prefix = CatalogTrustVectors.raw_history(f.space.log)

    absent_log =
      Log.append!(f.space_log, Op.new(f.space.root, f.space.replica, [], :command, nil))

    absent = CatalogTrustVectors.raw_history(absent_log)
    {:ok, prefix_proof} = CatalogCutoff.derive(f.space.log)
    {:ok, absent_proof} = CatalogCutoff.derive(absent_log)
    r = f.review

    %{
      review: %{
        version: 1,
        product: "treehouse",
        space: r.space,
        spaceRoot: Base.encode64(r.space_root),
        bootstrapId: r.bootstrap_id,
        observedBootstrapIds: r.observed_bootstrap_ids,
        disposition: "pin_exact_observed_bootstrap"
      },
      histories: f.histories,
      catalogJson: f.catalog_json,
      unknownName: unknown_name,
      proofs:
        Enum.map(f.cutoff_proofs, &%{cutoff: public_cutoff(&1.cutoff), history: &1.history}),
      wrongDigest: CatalogTrustVectors.id("proof-wrong-digest"),
      cutoff: %{
        replica: proof.cutoff.replica,
        frontier: proof.cutoff.frontier,
        logDigest: proof.cutoff.log_digest
      },
      cases: [
        %{name: "valid", history: h},
        %{name: "valid-prefix", history: prefix, cutoff: public_cutoff(prefix_proof.cutoff)},
        %{name: "absent-member", history: absent, cutoff: public_cutoff(absent_proof.cutoff)},
        %{name: "unsupported", history: %{h | frames: h.frames ++ [unknown]}},
        %{
          name: "forged",
          history: %{h | frames: h.frames ++ [Map.put(unknown, "sig", Base.encode64(<<0::512>>))]}
        },
        %{name: "partial", history: %{h | frames: [partial]}},
        %{name: "malformed-history", history: Map.delete(h, :rejected)},
        %{
          name: "malformed-rejected",
          history: %{h | rejected: [%{frame: unknown, reason: "invented"}]}
        }
      ]
    }
  end

  defp history(h) do
    Map.new(h, fn {k, v} ->
      key = %{"replica" => :replica, "frames" => :frames, "rejected" => :rejected}[k] || k

      value =
        if k == "rejected",
          do:
            Enum.map(v, fn r ->
              %{
                frame: r["frame"],
                reason: if(r["reason"] == "bad_signature", do: :bad_signature, else: r["reason"])
              }
            end),
          else: v

      {key, value}
    end)
  end

  defp public_cutoff(c), do: %{replica: c.replica, frontier: c.frontier, logDigest: c.log_digest}

  defp cutoff(c),
    do: %{replica: c["replica"], frontier: c["frontier"], log_digest: c["logDigest"]}

  defp page, do: %{catalogs: [], rotations: [], histories: [], cutoff_proofs: []}

  defp evaluate(state, incoming),
    do: CatalogTrust.evaluate(%{installed: state, expected: @expected, incoming: incoming})
end
