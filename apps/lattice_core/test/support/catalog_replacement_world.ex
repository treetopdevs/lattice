defmodule Treehouse.CatalogReplacementWorld do
  @moduledoc """
  Plan 316 row 316 fixtures for `Treehouse.CatalogReplacementTrust`: the PR 4a bounded Space
  (`Treehouse.CatalogBindingGraphFixtures.base/0`), its revision-0 catalog C0, a replacement R1
  authored through the real `Treehouse.Space` authoring path by the leased admin with a NEW
  catalog key, service key and origin (K1 is signed by the new key only), and a replacement Rn
  signed by a non-admin. Disposable seeded keys only; nothing here is installed trust.
  """

  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Authority.Delegation
  alias Treehouse.CatalogBindingGraphFixtures, as: F

  alias Treehouse.{
    CatalogCutoff,
    CatalogReplacementTrust,
    CatalogTrustVectors,
    Space,
    TransportCatalog
  }

  @expected %{trust_revision: 0, history_generation: 0}
  def expected, do: @expected

  def build do
    base = F.base()
    c0 = F.c0(base)
    new_catalog = Identity.from_seed("catalog", "r316-demo-new-catalog")
    new_service = Identity.from_seed("service", "r316-demo-new-service")
    service_id = F.id("demo-service")
    entries = F.entries(base, "r1", service_id, new_service.pub)

    request = %{
      author: base.admin.pub,
      nonce: F.id("demo-nonce"),
      parents: [base.boot.id],
      prior_catalogs: [%{binding: base.boot.id, catalog: F.cid(c0)}],
      generation: 1,
      new_catalog_key: new_catalog.pub,
      new_service_id: service_id,
      new_service_key: new_service.pub,
      new_origin: "wss://r1-relay.invalid",
      entries: entries,
      replica_logs: %{},
      rotations: [],
      catalogs: [c0]
    }

    {:ok, attempt} = Space.prepare_replace_catalog(base.log, request, %{})

    possession = %{
      catalog: Identity.sign(new_catalog, attempt.catalog_possession_bytes),
      service: Identity.sign(new_service, attempt.service_possession_bytes)
    }

    {:ok, authored} = Space.author_replace_catalog(base.admin, base.log, attempt, possession)
    k1 = F.catalog(base, authored.binding_id, 0, nil, new_catalog, entries)
    {:ok, %{cutoff: cutoff}} = CatalogCutoff.derive(base.log)
    h0 = CatalogTrustVectors.raw_history(base.log)

    rn =
      F.replacement(base, base.log, "rn",
        author: base.nominee,
        claim: %{author: base.nominee.pub}
      )

    %{
      base: base,
      c0: c0,
      r1: authored.op,
      k1: k1,
      rn: rn,
      new_catalog: new_catalog,
      proof: %{cutoff: cutoff, history: h0},
      h0: h0,
      review: %{
        version: 1,
        product: :treehouse,
        space: base.replica,
        space_root: base.root.pub,
        bootstrap_id: base.boot.id,
        observed_bootstrap_ids: [base.boot.id],
        disposition: :pin_exact_observed_bootstrap
      },
      labels: %{
        base.boot.id => "B",
        F.cid(c0) => "C0",
        authored.binding_id => "R1",
        F.cid(k1) => "K1",
        rn.id => "Rn"
      }
    }
  end

  @doc """
  Rows 526 and 527: a signed rotation of `parent` (`%{id, generation}`) over the `prior` catalog
  envelope, signed by `old` (the parent's catalog key) and by a new key seeded from `label`. Its
  cutoffs are the real Space cutoff `w.proof` proves (C0 and K1 hold only the Space entry), so the
  rotation's recovery is complete once `w.proof` is retained. Returns `%{id, envelope, key, json}`.
  """
  def rotation(w, parent, prior, old, label) do
    new = Identity.from_seed("catalog", "r526-rotation-" <> label)

    rotation = %{
      version: 1,
      product: :treehouse,
      space: w.base.replica,
      bootstrap: w.base.boot.id,
      parent: parent.id,
      prior_catalog: F.cid(prior),
      generation: parent.generation + 1,
      new_catalog_key: new.pub,
      nonce: F.id("r526-rotation-" <> label),
      inventory_digest: TransportCatalog.inventory_id(prior.catalog.entries),
      cutoffs: [w.proof.cutoff]
    }

    envelope = %{
      rotation: rotation,
      old_signature: Identity.sign(old, TransportCatalog.rotation_bytes(rotation)),
      new_signature: Identity.sign(new, TransportCatalog.rotation_possession_bytes(rotation))
    }

    %{
      id: TransportCatalog.rotation_id(envelope),
      envelope: envelope,
      key: new,
      json: CatalogTrustVectors.artifact_json(envelope)
    }
  end

  @doc "A page in `CatalogTrust`'s shape; `history` is a Space `Log`, `rotations` envelopes."
  def page(opts \\ []) do
    %{
      catalogs: Enum.map(Keyword.get(opts, :catalogs, []), &CatalogTrustVectors.artifact_json/1),
      rotations:
        Enum.map(Keyword.get(opts, :rotations, []), &CatalogTrustVectors.artifact_json/1),
      histories: Enum.map(Keyword.get(opts, :logs, []), &CatalogTrustVectors.raw_history/1),
      cutoff_proofs: Keyword.get(opts, :proofs, [])
    }
  end

  def install(w) do
    %{kind: :propose, next: installed} =
      CatalogReplacementTrust.prepare_installation(%{
        review: w.review,
        history: w.h0,
        store: %{kind: :verified_fresh, expected: @expected}
      })

    installed
  end

  def evaluate(installed, page),
    do:
      CatalogReplacementTrust.evaluate(%{
        installed: installed,
        expected: @expected,
        incoming: page
      })

  @doc "The state to persist after a decision: a reject keeps the installed state."
  def persist(_installed, %{next: next}), do: next
  def persist(installed, _reject), do: installed

  def with_ops(base, ops), do: Enum.reduce(ops, base.log, &Log.append!(&2, &1))

  @doc """
  The Thread log of a `CatalogTrustVectors.fixture/1` Thread with a concurrent moderator transfer
  that reclassifies its creation: delivering it makes `CatalogTrust` block as `authority_changed`.
  """
  def thread_transfer_log(thread) do
    Enum.find_value(1..200, fn index ->
      successor = Identity.from_seed("thread-successor", "r316-wrap-successor-#{index}")

      delegation =
        Delegation.new(thread.root, thread.replica, successor.pub,
          parent_id: thread.delegation.id,
          ops: MapSet.to_list(thread.delegation.ops),
          roles: [:moderator]
        )

      transfer =
        Op.new(
          thread.root,
          thread.replica,
          [thread.genesis.id],
          :authority,
          {:transfer, :moderator, delegation, 0}
        )

      log = Log.append!(thread.log, transfer)

      if Map.has_key?(Authority.analyze(Treehouse.Thread, log).reasons, thread.creation.id),
        do: log
    end) || raise "no deterministic Thread transfer"
  end

  @doc """
  The Space log with one malformed replacement command: an outsider-signed
  `{:replace_catalog_v1, []}` with no capability. It is neither a replacement node nor refusal
  evidence, so it must never widen what is served.
  """
  def with_malformed_replace(space_log, replica) do
    outsider = Identity.from_seed("outsider", "r316-outsider")

    op =
      Op.new(
        outsider,
        replica,
        Log.frontier(space_log),
        :command,
        {:replace_catalog_v1, []},
        cap: nil
      )

    Log.append!(space_log, op)
  end

  @doc "The page JSON shape of `TreehouseCatalogEvidencePage`."
  def page_json(page) do
    %{
      "catalogs" => page.catalogs,
      "rotations" => page.rotations,
      "histories" => page.histories,
      "cutoffProofs" =>
        Enum.map(page.cutoff_proofs, fn %{cutoff: c, history: h} ->
          %{
            "cutoff" => %{
              "replica" => c.replica,
              "frontier" => c.frontier,
              "logDigest" => c.log_digest
            },
            "history" => h
          }
        end)
    }
  end

  # --- the shared view and narration (the TS consumer prints the same lines) ----------------

  @doc "The runtime-neutral view of one decision; BEAM and TS must produce the same map."
  def view(result, labels, catalog_key) do
    label = &Map.get(labels, &1, "?" <> &1)
    next = result.next
    accepted = next.binding.accepted

    %{
      "kind" => to_string(result.kind),
      "reason" => result.reason && to_string(result.reason),
      "refused" => result.refused |> Map.values() |> Enum.map(&to_string/1) |> Enum.sort(),
      "accepted" => accepted && label.(accepted.binding) <> "/" <> label.(accepted.catalog),
      "origin" => result.served_origin,
      "routes" => length(result.routes),
      "urls" => result.routes |> Enum.map(& &1.url) |> Enum.sort(),
      "frozen" => next.binding.frozen,
      "sidecar" => length(next.extra.catalogs),
      "sidecar_rotations" => length(Map.get(next.extra, :rotations, [])),
      "old_key_used" => Enum.any?(next.extra.catalogs, &signed_by?(&1, catalog_key))
    }
  end

  defp signed_by?(json, key) do
    {:ok, envelope} = TransportCatalog.decode_catalog_json(json)
    TransportCatalog.verify_catalog(envelope, key) == :ok
  end

  @doc "One narrated line; the TS consumer builds the same text."
  def line(title, v) do
    head = String.pad_trailing(title, 19)

    if v["refused"] != [] do
      "#{head}refused #{Enum.join(v["refused"], ",")}  kept #{v["accepted"]}  " <>
        "origin #{v["origin"]}  frozen #{v["frozen"]}"
    else
      note =
        if v["sidecar"] > 0, do: "  old catalog key used: #{yes_no(v["old_key_used"])}", else: ""

      head <>
        "accepted #{String.pad_trailing(v["accepted"], 7)} " <>
        "origin #{String.pad_trailing(v["origin"], 26)} routes #{v["routes"]}" <> note
    end
  end

  defp yes_no(true), do: "yes"
  defp yes_no(false), do: "no"
end
