defmodule Lattice.Flagship.Claims do
  @moduledoc """
  Code-owned claims table for the flagship artifact.

  The browser UI, HTTP API, verification script, and documentation all point at
  this data so the implemented, simulated, and future-work boundary has one
  executable source of truth.
  """

  @claims [
    %{
      id: "capability_wallet_edge",
      claim: "Caveated capability authorizes the wallet edge",
      status: "implemented",
      evidence: "Lattice.CapStore + Lattice.Cap.Caveat + flagship tests",
      evidence_refs: [
        "apps/lattice_core/lib/lattice/flagship.ex",
        "apps/lattice_core/test/lattice_flagship_test.exs"
      ],
      artifact: "output/flagship/flagship-snapshot.json"
    },
    %{
      id: "denied_overreach_no_delivery",
      claim: "Denied overreach does not reach the wallet process",
      status: "implemented",
      evidence: "Wallet delivery count remains unchanged after each deny",
      evidence_refs: [
        "apps/lattice_core/lib/lattice/flagship/wallet.ex",
        "apps/lattice_core/test/lattice_flagship_test.exs"
      ],
      artifact: "output/flagship/flagship-snapshot.json"
    },
    %{
      id: "graph_is_trust_graph",
      claim: "Process graph is the trust graph",
      status: "implemented",
      evidence: "Lattice.Graph.Snapshot powers the UI, JSON, Mermaid, and DOT",
      evidence_refs: [
        "apps/lattice_core/lib/lattice/graph/snapshot.ex",
        "apps/lattice_core/lib/lattice/graph/export.ex"
      ],
      artifact: "output/flagship/flagship-graph.json"
    },
    %{
      id: "browser_worker_realms",
      claim: "Browser Web Worker realms participate in mediated Lattice bridges",
      status: "implemented",
      evidence:
        "Dedicated browser Worker client connects over WebSocket and proves direct-deny plus explicit bridge delivery",
      evidence_refs: [
        "apps/lattice_core/lib/lattice/demo/federated_workers.ex",
        "examples/browser_demo/worker-client.js",
        "scripts/lattice_browser_worker_e2e.mjs"
      ],
      artifact: "output/playwright/browser-worker-demo.json"
    },
    %{
      id: "formal_authority_preservation",
      claim: "Formal verification of authority preservation",
      status: "future work",
      evidence: "Operational model and executable tests exist, mechanized proof does not",
      evidence_refs: [
        "docs/research/operational_model.md",
        "apps/lattice_core/test/lattice_flagship_test.exs"
      ],
      artifact: "docs/research/operational_model.md"
    },
    %{
      id: "capability_attested_causality",
      claim: "Capability-attested causality overlays the graph",
      status: "simulated",
      evidence:
        "Executable hash-chain prototype and tests exist; not integrated into the flagship graph overlay",
      evidence_refs: [
        "apps/lattice_core/lib/lattice/causality.ex",
        "apps/lattice_core/test/lattice_research_test.exs",
        "docs/research/architecture.md",
        "docs/flagship_demo.md"
      ],
      artifact: "output/flagship/claims.json"
    }
  ]

  def all, do: @claims

  def validate(root \\ File.cwd!(), opts \\ []) do
    generated_artifacts? = Keyword.get(opts, :generated_artifacts?, false)
    missing = Enum.flat_map(@claims, &missing_paths(&1, root, generated_artifacts?))

    if missing == [] do
      :ok
    else
      {:error, missing}
    end
  end

  def validate!(root \\ File.cwd!(), opts \\ []) do
    case validate(root, opts) do
      :ok ->
        :ok

      {:error, missing} ->
        raise ArgumentError, "flagship claims reference missing paths: #{inspect(missing)}"
    end
  end

  defp missing_paths(claim, root, generated_artifacts?) do
    evidence =
      claim.evidence_refs
      |> Enum.reject(&exists?(root, &1))
      |> Enum.map(&{claim.id, :evidence_ref, &1})

    artifact =
      if generated_artifacts? or not String.starts_with?(claim.artifact, "output/") do
        if exists?(root, claim.artifact), do: [], else: [{claim.id, :artifact, claim.artifact}]
      else
        []
      end

    evidence ++ artifact
  end

  defp exists?(root, path), do: File.exists?(Path.join(root, path))
end
