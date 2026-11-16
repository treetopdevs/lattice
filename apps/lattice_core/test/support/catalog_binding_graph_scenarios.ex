defmodule Treehouse.CatalogBindingGraphScenarios do
  @moduledoc """
  Plan 316 PR 4a scenario table for `Treehouse.CatalogBindingGraph`, shared by the ExUnit
  tests and the `binding_graph_v1.json` reciprocal vectors (finding 8).

  Each scenario is a list of deliveries. A delivery carries the full retained evidence (Space
  log, rotations, catalogs, proven cutoffs) and a hand-written expectation in label terms:
  heads, closed set, closed-out children, nodes, refused nodes, raw evidence, retained
  refusals, nodes with pending cutoffs, fork kinds, the decision (with its `freeze` and
  `serving`) and the state `advance/2` returns (`after`: `frozen` and the routes served). The
  accepted watermark (with its cumulative routes) and the `frozen` bit persist between
  deliveries (`CatalogBindingGraphFixtures.deliver/3`);
  multi-delivery scenarios are listed once per delivery order. Disposable seeded keys only.
  """

  alias Lattice.Carrier.Wire
  alias Lattice.{Log, Op}
  alias Treehouse.CatalogBindingGraphFixtures, as: F
  alias Treehouse.CatalogCutoff

  # --- expectation helpers -----------------------------------------------------

  @doc """
  A successful expectation; omitted fields mean empty / no decision. The decision's `serving`
  defaults to its catalog when it accepts (else nil) and `freeze` to false; `after:` is the
  state `CatalogBindingGraph.advance/2` persists (`frozen`, default the decision's `freeze`,
  and the routes it serves, default nil when frozen and otherwise the decision's `serving`).
  """
  def ok(heads, opts \\ []) do
    closed = Keyword.get(opts, :closed, [])
    d = Keyword.get(opts, :decision, [])
    accepted? = Keyword.get(d, :accepted, false)
    serving = Keyword.get(d, :serving, if(accepted?, do: Keyword.get(d, :catalog)))
    a = Keyword.get(opts, :after, [])
    frozen = Keyword.get(a, :frozen, Keyword.get(d, :freeze, false))

    %{
      "after" => %{
        "frozen" => frozen,
        "serving" => Keyword.get(a, :serving, if(frozen, do: nil, else: serving))
      },
      "heads" => Enum.sort(heads),
      "closed" => Enum.sort(closed),
      "closed_out" => Enum.sort(Keyword.get(opts, :closed_out, [])),
      "nodes" => Enum.sort(Keyword.get(opts, :nodes, Enum.uniq(heads ++ closed))),
      "refused" => Enum.sort(Keyword.get(opts, :refused, [])),
      "raw" => Map.new(Keyword.get(opts, :raw, %{})),
      "refusals" => Map.new(Keyword.get(opts, :refusals, %{})),
      "pending" => Enum.sort(Keyword.get(opts, :pending, [])),
      "forks" => Enum.sort(Keyword.get(opts, :forks, [])),
      "decision" => %{
        "accepted" => accepted?,
        "reason" => Keyword.get(d, :reason),
        "block" => Keyword.get(d, :block),
        "freeze" => Keyword.get(d, :freeze, false),
        "head" => Keyword.get(d, :head),
        "catalog" => Keyword.get(d, :catalog),
        "clears" => Keyword.get(d, :clears, false),
        "serving" => serving
      }
    }
  end

  @doc """
  A resolve error. `advance/2` keeps the state on every error and serves nothing, except that
  `trust_pending` (row 386, repair (a)) carries the complete part's `freeze` (default false,
  ORed into `frozen`) and the watermark's `serving` (a label, default nil), served unless
  frozen. `frozen:` is the state after (default `freeze`).
  """
  def err(reason, opts \\ []) do
    freeze = Keyword.get(opts, :freeze, false)
    frozen = Keyword.get(opts, :frozen, freeze)
    serving = Keyword.get(opts, :serving)
    pending? = reason == "trust_pending"

    base = %{
      "error" => reason,
      "after" => %{
        "frozen" => frozen,
        "serving" => if(pending? and not frozen, do: serving)
      }
    }

    if pending?, do: Map.merge(base, %{"freeze" => freeze, "serving" => serving}), else: base
  end

  defp accept(head, catalog, opts \\ []),
    do: [accepted: true, head: head, catalog: catalog] ++ opts

  # --- evidence ------------------------------------------------------------------

  defp ev(log, opts \\ []) do
    rotations = Keyword.get(opts, :rotations, [])
    catalogs = Keyword.get(opts, :catalogs, [])
    unproven = Keyword.get(opts, :unproven, [])

    proven =
      for {_id, %Op{body: {:replace_catalog_v1, [claim | _]}} = op} <- Log.ops(log),
          op.id not in unproven,
          is_map(claim),
          cutoff <- List.wrap(Map.get(claim, :cutoffs)),
          is_map(cutoff),
          uniq: true,
          do: Map.take(cutoff, [:replica, :frontier, :log_digest])

    # A rotation owes its own declared cutoffs too (review round 3, finding 3); `unproven`
    # takes rotation ids as well.
    rotation_proven =
      for rot <- rotations,
          rot.id not in unproven,
          cutoff <- rot.envelope.rotation.cutoffs,
          do: Map.take(cutoff, [:replica, :frontier, :log_digest])

    # `proven:` replaces the derived proofs (a proof for a different cutoff than the claim's).
    proven = Keyword.get(opts, :proven, Enum.uniq(proven ++ rotation_proven))

    %{
      space: log,
      rotations: Map.new(rotations, &{&1.id, &1.envelope}),
      catalogs: Map.new(catalogs, &{F.cid(&1), &1}),
      proven: Enum.sort_by(proven, &{&1.replica, &1.log_digest})
    }
  end

  defp step(evidence, expect, state \\ nil),
    do: %{evidence: evidence, expect: expect, state: state}

  defp add(log, ops), do: F.append(log, Enum.map(ops, &op_of/1))
  defp op_of(%Op{} = op), do: op
  defp op_of(%{op: %Op{} = op}), do: op

  defp node(id, generation), do: %{id: id, generation: generation}

  # --- the table -------------------------------------------------------------------

  @doc "Every scenario: `%{name, labels, steps}`."
  def all(base \\ F.base()) do
    base
    |> builders()
    |> Enum.flat_map(fn builder -> List.wrap(builder.(base)) end)
  end

  defp builders(_base) do
    [
      &bootstrap_alone/1,
      &honored_replacement/1,
      &rotation_inherits/1,
      &raw_scope_and_malformed/1,
      &dangling/1,
      &unknown_rotation_parent/1,
      &ineligible_parent/1,
      &declared_graph_errors/1,
      &unheld_prior/1,
      &union_refused/1,
      &under_refused/1,
      &od17/1,
      &bad_first_catalog/1,
      &precedence/1,
      &siblings/1,
      &nonce_reuse/1,
      &catalog_fork/1,
      &cutoffs/1,
      &head_limit/1,
      &closing_rule/1,
      &ancestry/1,
      &nil_prior/1,
      &refused_closes/1,
      &ordinary_success/1,
      &refused_beside_sibling/1,
      &c13/1,
      &idempotent_and_rollback/1,
      &revoked_in_prefix/1,
      &late_first_catalog/1,
      &route_reservation/1,
      &pending_parent/1,
      &possession_each/1,
      &incomplete_control/1,
      &rotation_recovery/1,
      &refused_catalog_citation/1,
      &sequential_nonce/1,
      &missing_accepted/1,
      &rotation_refused_prior/1,
      &uncited_pending/1,
      &closed_rotation_withheld_prior/1,
      &replacement_cutoff_coverage/1,
      &refused_parent_sibling/1,
      &invalid_old_key_catalog/1,
      &cutoff_frontier/1,
      &same_service_inherits/1,
      &scope_before_signature/1,
      &s1_rotation_trigger/1,
      &s2_withheld_first/1,
      &s3_nil_floor/1,
      &s4_route_reuse/1,
      &s6_invalid_prior_rotations/1,
      &s7_missing_clears/1,
      &s8_closed_out_rotation_watermark/1,
      &s9_inventory_continuity/1,
      &s10_rotation_fork/1,
      &s11_head_limit/1,
      &s12_cumulative_routes/1,
      &s13_missing_watermark/1,
      &s14_same_page_trade/1,
      &s15_seen_only/1,
      &s16_pending_freeze/1,
      &s16b_withheld_prior/1,
      &s16c_pending_alone/1,
      &s16d_closing_beside_pending/1,
      &s16i_refused_pending_chain/1,
      &s17_reserved_routes/1,
      &s17b_revoked_conflict/1,
      &b1_bad_chain_under_refused/1,
      &b3_rotation_precedence/1,
      &f1_stale_bootstrap_prefix/1,
      &f2_pending_under_rotated_ancestor/1,
      &f3_floor_lattice/1,
      &s17e_first_prior_reserved/1,
      &r390_contradicting_sibling/1,
      &r390_history_valid_variants/1
    ]
  end

  defp both(name, labels, ab, ba),
    do: [
      %{name: name <> "/ab", labels: labels, steps: ab},
      %{name: name <> "/ba", labels: labels, steps: ba}
    ]

  defp one(name, labels, steps), do: %{name: name, labels: labels, steps: steps}

  defp base_labels(base, c0), do: %{"B" => base.boot.id, "C0" => F.cid(c0)}

  defp bootstrap_alone(base) do
    c0 = F.c0(base)

    one("bootstrap alone is the only node and head", base_labels(base, c0), [
      step(ev(base.log), ok(["B"], decision: [head: "B"])),
      step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0")))
    ])
  end

  defp honored_replacement(base) do
    c0 = F.c0(base)
    r1 = F.replacement(base, base.log, "r1")
    k1 = F.first(base, r1)
    labels = Map.merge(base_labels(base, c0), %{"R1" => r1.id, "K1" => F.cid(k1)})

    one("honored leased-admin replacement is an eligible node", labels, [
      step(
        ev(add(base.log, [r1]), catalogs: [k1]),
        ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))
      )
    ])
  end

  defp rotation(base, parent, prior, old, label) do
    F.rotation(base, parent, prior, old, F.identity("rot-" <> label), label)
  end

  defp rotation_inherits(base) do
    c0 = F.c0(base)
    t = rotation(base, node(base.boot.id, 0), c0, base.catalog, "t")
    ct = F.catalog(base, t.id, 0, nil, F.identity("rot-t"), F.base_entries(base))

    labels = Map.merge(base_labels(base, c0), %{"T" => t.id, "CT" => F.cid(ct)})

    one("rotation inherits service and origin from its parent", labels, [
      # Without proofs of T's own cutoffs, T/CT is recovery_incomplete (finding 3).
      step(
        ev(base.log, rotations: [t], catalogs: [c0, ct], unproven: [t.id]),
        ok(["T"],
          nodes: ["B", "T"],
          pending: ["T"],
          decision: [head: "T", reason: "recovery_incomplete", block: "recovery_incomplete"]
        )
      ),
      step(
        ev(base.log, rotations: [t], catalogs: [c0, ct]),
        ok(["T"], nodes: ["B", "T"], decision: accept("T", "CT"))
      )
    ])
  end

  defp raw_scope_and_malformed(base) do
    c0 = F.c0(base)
    rs = F.replacement(base, base.log, "rs", claim: %{profile_id: F.id("other-profile")})
    rg = F.replacement(base, base.log, "rg", claim: %{profile_genesis: F.id("other-genesis")})
    good = F.replacement(base, base.log, "rm")
    [claim, cp, _sp] = elem(good.op.body, 1)

    rm =
      Op.new(
        base.admin,
        base.replica,
        Log.frontier(base.log),
        :command,
        {:replace_catalog_v1, [claim, cp]},
        cap: base.delegation.id
      )

    re =
      Op.new(
        base.admin,
        base.replica,
        Log.frontier(base.log),
        :command,
        {:replace_catalog_v1, [Map.put(claim, :extra, 1), cp, cp]},
        cap: base.delegation.id
      )

    labels =
      Map.merge(base_labels(base, c0), %{
        "Rs" => rs.id,
        "Rg" => rg.id,
        "Rm" => rm.id,
        "Re" => re.id
      })

    one("malformed claim and wrong scope are raw evidence", labels, [
      step(
        ev(add(base.log, [rs, rg, rm, re]), catalogs: [c0]),
        ok(["B"],
          raw: %{
            "Rs" => "wrong_catalog_scope",
            "Rg" => "wrong_catalog_scope",
            "Rm" => "malformed_catalog",
            "Re" => "malformed_catalog"
          },
          decision: accept("B", "C0")
        )
      )
    ])
  end

  # Dangling deps: a Space union whose closure is incomplete (`Log.from_ops`).
  defp dangling(base) do
    c0 = F.c0(base)
    missing = F.id("missing-dep")
    deps = [missing | Log.frontier(base.log)]
    rd = F.replacement(base, base.log, "rd", deps: deps)

    rn =
      F.replacement(base, base.log, "rn",
        deps: deps,
        author: base.nominee,
        claim: %{author: base.nominee.pub}
      )

    r1 =
      F.replacement(base, base.log, "r1",
        prior_catalogs: [%{binding: base.boot.id, catalog: F.cid(c0)}]
      )

    k1 = F.first(base, r1)

    loose = fn ops ->
      Log.from_ops(base.replica, Map.merge(Log.ops(base.log), Map.new(ops, &{&1.id, &1})))
    end

    labels =
      Map.merge(base_labels(base, c0), %{
        "Rd" => rd.id,
        "Rn" => rn.id,
        "R1" => r1.id,
        "K1" => F.cid(k1),
        "missing" => missing
      })

    [
      one("authorized-looking dangling-dep candidate holds trust_pending", labels, [
        step(ev(loose.([rd.op, r1.op]), catalogs: [c0, k1]), err("trust_pending"))
      ]),
      one("unauthorized dangling-dep candidate beside a valid sole head promotes", labels, [
        step(
          ev(loose.([rn.op, r1.op]), catalogs: [c0, k1]),
          ok(["R1"],
            closed: ["B"],
            raw: %{"Rn" => "catalog_authority_refused"},
            decision: accept("R1", "K1")
          )
        )
      ])
    ]
  end

  defp unknown_rotation_parent(base) do
    c0 = F.c0(base)
    t = rotation(base, node(base.boot.id, 0), c0, base.catalog, "t")
    r = F.replacement(base, base.log, "r", parents: [t.id], generation: 2)
    kr = F.first(base, r)
    labels = Map.merge(base_labels(base, c0), %{"T" => t.id, "R" => r.id, "KR" => F.cid(kr)})
    log = add(base.log, [r])
    done = ok(["R"], closed: ["B", "T"], decision: accept("R", "KR"))

    both(
      "unknown rotation parent is pending and becomes a node when it arrives",
      labels,
      [
        step(ev(log, catalogs: [c0, kr]), err("trust_pending")),
        step(ev(log, rotations: [t], catalogs: [c0, kr]), done)
      ],
      [
        step(
          ev(base.log, rotations: [t], catalogs: [c0]),
          ok(["T"], nodes: ["B", "T"], decision: [head: "T"])
        ),
        step(ev(log, rotations: [t], catalogs: [c0, kr]), done)
      ]
    )
  end

  defp ineligible_parent(base) do
    c0 = F.c0(base)
    rs = F.replacement(base, base.log, "rs", claim: %{profile_id: F.id("other-profile")})
    l1 = add(base.log, [rs])
    r2 = F.replacement(base, l1, "r2", parents: [rs.id], generation: 2)
    labels = Map.merge(base_labels(base, c0), %{"Rs" => rs.id, "R2" => r2.id})

    one("parent that is an ineligible replacement is invalid_catalog_transition", labels, [
      step(
        ev(add(l1, [r2]), catalogs: [c0]),
        ok(["B"],
          raw: %{"Rs" => "wrong_catalog_scope", "R2" => "invalid_catalog_transition"},
          decision: accept("B", "C0")
        )
      )
    ])
  end

  defp declared_graph_errors(base) do
    c0 = F.c0(base)
    gen = F.replacement(base, base.log, "gen", generation: 2)
    svc = F.replacement(base, base.log, "svc", service_id: base.record.service_id)
    r1 = F.replacement(base, base.log, "r1")
    # Cites R1 but its deps do not include it.
    nodeps = F.replacement(base, base.log, "nodeps", parents: [r1.id], generation: 2)
    k1 = F.first(base, r1)

    # Cites a catalog held under another binding.
    other =
      F.replacement(base, base.log, "other",
        prior_catalogs: [%{binding: base.boot.id, catalog: F.cid(k1)}]
      )

    labels =
      Map.merge(base_labels(base, c0), %{
        "Rgen" => gen.id,
        "Rsvc" => svc.id,
        "R1" => r1.id,
        "K1" => F.cid(k1),
        "Rnodeps" => nodeps.id,
        "Rother" => other.id
      })

    one("declared-graph failures are raw invalid_catalog_transition", labels, [
      step(
        ev(add(base.log, [gen, svc, r1, nodeps, other]), catalogs: [c0, k1]),
        ok(["R1"],
          closed: ["B"],
          closed_out: ["C0"],
          raw: %{
            "Rgen" => "invalid_catalog_transition",
            "Rsvc" => "invalid_catalog_transition",
            "Rnodeps" => "invalid_catalog_transition",
            "Rother" => "invalid_catalog_transition"
          },
          decision: accept("R1", "K1")
        )
      )
    ])
  end

  defp unheld_prior(base) do
    c0 = F.c0(base)

    r =
      F.replacement(base, base.log, "r",
        prior_catalogs: [%{binding: base.boot.id, catalog: F.cid(c0)}]
      )

    kr = F.first(base, r)
    labels = Map.merge(base_labels(base, c0), %{"R" => r.id, "KR" => F.cid(kr)})
    log = add(base.log, [r])

    one("unheld prior catalog is pending", labels, [
      step(ev(log, catalogs: [kr]), err("trust_pending")),
      step(ev(log, catalogs: [c0, kr]), ok(["R"], closed: ["B"], decision: accept("R", "KR")))
    ])
  end

  defp cite_c0(base, c0, name, opts \\ []) do
    F.replacement(
      base,
      Keyword.get(opts, :log, base.log),
      name,
      [prior_catalogs: [%{binding: base.boot.id, catalog: F.cid(c0)}]] ++ opts
    )
  end

  defp union_refused(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "r1")
    k1 = F.first(base, r1)
    rv = F.revoke(base, Log.frontier(base.log), base.delegation.id)
    labels = Map.merge(base_labels(base, c0), %{"R1" => r1.id, "K1" => F.cid(k1), "Rv" => rv.id})

    refused =
      ok(["R1"],
        closed: ["B"],
        refused: ["R1"],
        refusals: %{"K1" => "catalog_authority_refused"},
        decision: [
          head: "R1",
          reason: "catalog_authority_refused",
          block: "catalog_authority_refused"
        ]
      )

    both(
      "union-refused eligible node is refused in both orders",
      labels,
      [
        step(
          ev(add(base.log, [r1]), catalogs: [c0, k1]),
          ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))
        ),
        step(
          ev(add(base.log, [r1, rv]), catalogs: [c0, k1]),
          ok(["R1"],
            closed: ["B"],
            refused: ["R1"],
            refusals: %{"K1" => "catalog_authority_refused"},
            decision: [
              head: "R1",
              reason: "authority_changed",
              block: "authority_changed",
              freeze: true
            ]
          )
        )
      ],
      [
        step(ev(add(base.log, [rv]), catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
        step(ev(add(base.log, [rv, r1]), catalogs: [c0, k1]), refused)
      ]
    )
  end

  defp under_refused(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "r1")
    k1 = F.first(base, r1)
    rv = F.revoke(base, Log.frontier(base.log), base.delegation.id)
    tr = rotation(base, node(r1.id, 1), k1, r1.catalog_key, "tr")
    labels = Map.merge(base_labels(base, c0), %{"R1" => r1.id, "K1" => F.cid(k1), "TR" => tr.id})

    one("rotation or catalog under a refused node is refused", labels, [
      step(
        ev(add(base.log, [r1, rv]), rotations: [tr], catalogs: [c0, k1]),
        ok(["TR"],
          closed: ["B"],
          nodes: ["B", "R1", "TR"],
          refused: ["R1", "TR"],
          refusals: %{"K1" => "catalog_authority_refused", "TR" => "catalog_authority_refused"},
          decision: [
            head: "TR",
            reason: "catalog_authority_refused",
            block: "catalog_authority_refused"
          ]
        )
      )
    ])
    |> Map.update!(:labels, &Map.put(&1, "Rv", rv.id))
  end

  defp od17(base) do
    c0 = F.c0(base)
    rx = F.replacement(base, base.log, "rx", generation: 2)
    rv = F.revoke(base, Log.frontier(base.log), base.delegation.id)
    labels = Map.merge(base_labels(base, c0), %{"Rx" => rx.id, "Rv" => rv.id})

    one("union-refused node failing an intrinsic check is raw and closes nothing", labels, [
      step(
        ev(add(base.log, [rx, rv]), catalogs: [c0]),
        ok(["B"], raw: %{"Rx" => "invalid_catalog_transition"}, decision: accept("B", "C0"))
      )
    ])
  end

  defp bad_first_catalog(base) do
    c0 = F.c0(base)
    r1 = F.replacement(base, base.log, "r1")

    bad =
      F.first(base, r1,
        entries: F.entries(base, "other-route", r1.service_id, r1.service_key.pub)
      )

    labels = Map.merge(base_labels(base, c0), %{"R1" => r1.id, "Kbad" => F.cid(bad)})

    one(
      "replacement before its revision-0 catalog is a node; a bad first catalog is refused",
      labels,
      [
        step(ev(add(base.log, [r1])), ok(["R1"], closed: ["B"], decision: [head: "R1"])),
        step(
          ev(add(base.log, [r1]), catalogs: [bad]),
          ok(["R1"],
            closed: ["B"],
            refusals: %{"Kbad" => "invalid_catalog_transition"},
            decision: [head: "R1"]
          )
        )
      ]
    )
  end

  defp precedence(base) do
    c0 = F.c0(base)

    rp =
      F.replacement(base, base.log, "rp",
        claim: %{profile_id: F.id("other-profile")},
        bad_possession: true
      )

    rq = F.replacement(base, base.log, "rq", generation: 2, bad_possession: true)

    rn =
      F.replacement(base, base.log, "rn",
        generation: 2,
        author: base.nominee,
        claim: %{author: base.nominee.pub}
      )

    labels = Map.merge(base_labels(base, c0), %{"Rp" => rp.id, "Rq" => rq.id, "Rn" => rn.id})

    one("section-3 precedence picks the highest-ranking failure", labels, [
      step(
        ev(add(base.log, [rp, rq, rn]), catalogs: [c0]),
        ok(["B"],
          raw: %{
            "Rp" => "wrong_catalog_scope",
            "Rq" => "invalid_possession",
            "Rn" => "catalog_authority_refused"
          },
          decision: accept("B", "C0")
        )
      )
    ])
  end

  defp siblings(base) do
    c0 = F.c0(base)
    a = cite_c0(base, c0, "a")
    b = cite_c0(base, c0, "b")
    ka = F.first(base, a)
    kb = F.first(base, b)
    lab = add(base.log, [a, b])

    res =
      F.replacement(base, lab, "res",
        parents: Enum.sort([a.id, b.id]),
        prior_catalogs:
          Enum.sort([%{binding: a.id, catalog: F.cid(ka)}, %{binding: b.id, catalog: F.cid(kb)}]),
        generation: 2
      )

    kres = F.first(base, res)

    nodeps =
      F.replacement(base, add(base.log, [a]), "nodeps",
        parents: Enum.sort([a.id, b.id]),
        prior_catalogs:
          Enum.sort([%{binding: a.id, catalog: F.cid(ka)}, %{binding: b.id, catalog: F.cid(kb)}]),
        generation: 2
      )

    onlya =
      F.replacement(base, lab, "onlya",
        parents: [a.id],
        prior_catalogs: [%{binding: a.id, catalog: F.cid(ka)}],
        generation: 2
      )

    tb = rotation(base, node(base.boot.id, 0), c0, base.catalog, "tb")

    labels =
      Map.merge(base_labels(base, c0), %{
        "A" => a.id,
        "Bs" => b.id,
        "KA" => F.cid(ka),
        "KB" => F.cid(kb),
        "Res" => res.id,
        "KRes" => F.cid(kres),
        "Nodeps" => nodeps.id,
        "OnlyA" => onlya.id,
        "TB" => tb.id
      })

    fork = fn opts ->
      ok(
        ["A", "Bs"],
        [
          closed: ["B"],
          forks: ["heads"],
          decision: [reason: "catalog_fork", block: "catalog_fork"]
        ] ++ opts
      )
    end

    all = [c0, ka, kb]
    l_onlya = add(lab, [onlya])
    l_res = add(l_onlya, [res])

    res2 =
      F.replacement(base, l_res, "res2",
        parents: Enum.sort([onlya.id, res.id]),
        prior_catalogs:
          Enum.sort([
            %{binding: onlya.id, catalog: nil},
            %{binding: res.id, catalog: F.cid(kres)}
          ]),
        generation: 3
      )

    kres2 = F.first(base, res2)
    labels = Map.merge(labels, %{"Res2" => res2.id, "KRes2" => F.cid(kres2)})

    # PR #221 CodeRabbit thread (scenarios :712): a retained-history variant in which OnlyA stays
    # held beside Res. Res does not cite OnlyA, so the two fork until Res2 cites both.
    retained =
      one("sibling replacements with OnlyA retained beside the resolution", labels, [
        step(
          ev(l_onlya, catalogs: all),
          ok(["Bs", "OnlyA"],
            closed: ["A", "B"],
            forks: ["heads"],
            decision: [reason: "catalog_fork", block: "catalog_fork"]
          )
        ),
        step(
          ev(l_res, catalogs: all ++ [kres]),
          ok(["OnlyA", "Res"],
            closed: ["A", "B", "Bs"],
            forks: ["heads"],
            decision: [reason: "catalog_fork", block: "catalog_fork"]
          )
        ),
        step(
          ev(add(l_res, [res2]), catalogs: all ++ [kres, kres2]),
          ok(["Res2"],
            closed: ["A", "B", "Bs", "OnlyA", "Res"],
            decision: accept("Res2", "KRes2")
          )
        )
      ])

    [
      retained
      | both(
          "sibling replacements are two heads (catalog_fork), resolution covers both",
          labels,
          [
            step(
              ev(add(base.log, [a]), catalogs: [c0, ka]),
              ok(["A"], closed: ["B"], decision: accept("A", "KA"))
            ),
            step(ev(lab, catalogs: all), fork.([])),
            step(
              ev(add(lab, [nodeps]), rotations: [tb], catalogs: all),
              fork.(closed_out: ["TB"], raw: %{"Nodeps" => "invalid_catalog_transition"})
            ),
            step(
              ev(add(lab, [onlya]), catalogs: all),
              ok(["Bs", "OnlyA"],
                closed: ["A", "B"],
                forks: ["heads"],
                decision: [reason: "catalog_fork", block: "catalog_fork"]
              )
            ),
            step(
              ev(add(lab, [res]), catalogs: all ++ [kres]),
              ok(["Res"], closed: ["A", "B", "Bs"], decision: accept("Res", "KRes", clears: true))
            )
          ],
          [
            step(
              ev(add(base.log, [b]), catalogs: [c0, kb]),
              ok(["Bs"], closed: ["B"], decision: accept("Bs", "KB"))
            ),
            step(ev(lab, catalogs: all), fork.([])),
            step(
              ev(add(lab, [res]), catalogs: all ++ [kres]),
              ok(["Res"], closed: ["A", "B", "Bs"], decision: accept("Res", "KRes", clears: true))
            )
          ]
        )
    ]
  end

  defp nonce_reuse(base) do
    c0 = F.c0(base)
    a = cite_c0(base, c0, "na", claim: %{nonce: F.id("shared-nonce")})
    b = cite_c0(base, c0, "nb", claim: %{nonce: F.id("shared-nonce")})
    labels = Map.merge(base_labels(base, c0), %{"A" => a.id, "Bn" => b.id})

    one("nonce reuse among heads is catalog_fork", labels, [
      step(
        ev(add(base.log, [a, b]), catalogs: [c0]),
        ok(["A", "Bn"],
          closed: ["B"],
          forks: ["heads", "nonce"],
          decision: [reason: "catalog_fork", block: "catalog_fork"]
        )
      )
    ])
  end

  defp catalog_fork(base) do
    c0 = F.c0(base)
    c0b = F.c0(base, "base-b")

    both_prior =
      Enum.sort([
        %{binding: base.boot.id, catalog: F.cid(c0)},
        %{binding: base.boot.id, catalog: F.cid(c0b)}
      ])

    r = F.replacement(base, base.log, "r", prior_catalogs: both_prior)
    kr = F.first(base, r)
    one_sided = cite_c0(base, c0, "one")
    ko = F.first(base, one_sided)

    labels =
      Map.merge(base_labels(base, c0), %{
        "C0b" => F.cid(c0b),
        "R" => r.id,
        "KR" => F.cid(kr),
        "One" => one_sided.id,
        "KO" => F.cid(ko)
      })

    one("one binding's catalog fork is resolved by citing both catalogs", labels, [
      step(
        ev(base.log, catalogs: [c0, c0b]),
        ok(["B"], forks: ["catalog"], decision: [reason: "catalog_fork", block: "catalog_fork"])
      ),
      step(
        ev(add(base.log, [r]), catalogs: [c0, c0b, kr]),
        ok(["R"], closed: ["B"], decision: accept("R", "KR"))
      ),
      step(
        ev(add(base.log, [one_sided]), catalogs: [c0, c0b, ko]),
        ok(["One"],
          closed: ["B"],
          forks: ["catalog"],
          decision: [reason: "catalog_fork", block: "catalog_fork"]
        )
      )
    ])
  end

  defp cutoffs(base) do
    c0 = F.c0(base)
    a = cite_c0(base, c0, "a")
    # A distinct Space cutoff for B: its prefix holds one more (concurrent) beacon.
    e2 = F.beacon(base, Log.frontier(base.log), 2)
    b = cite_c0(base, c0, "b", log: add(base.log, [e2]))
    ka = F.first(base, a)
    kb = F.first(base, b)
    lab = add(base.log, [e2, a, b])

    labels =
      Map.merge(base_labels(base, c0), %{
        "A" => a.id,
        "Bs" => b.id,
        "E2" => e2.id,
        "KA" => F.cid(ka),
        "KB" => F.cid(kb)
      })

    all = [c0, ka, kb]

    fork = fn pending ->
      ok(["A", "Bs"],
        closed: ["B"],
        pending: pending,
        forks: ["heads"],
        decision: [reason: "catalog_fork", block: "catalog_fork"]
      )
    end

    ab = [
      step(
        ev(add(base.log, [a]), catalogs: [c0, ka]),
        ok(["A"], closed: ["B"], decision: accept("A", "KA"))
      ),
      step(ev(lab, catalogs: all, unproven: [b.id]), fork.(["Bs"])),
      step(ev(lab, catalogs: all), fork.([]))
    ]

    ba = [
      step(
        ev(add(base.log, [e2, b]), catalogs: [c0, kb], unproven: [b.id]),
        ok(["Bs"],
          closed: ["B"],
          pending: ["Bs"],
          decision: [head: "Bs", reason: "recovery_incomplete", block: "recovery_incomplete"]
        )
      ),
      step(ev(lab, catalogs: all, unproven: [a.id, b.id]), fork.(["A", "Bs"])),
      step(ev(lab, catalogs: all), fork.([]))
    ]

    both(
      "sibling without its cutoff proof still forks; sole head is recovery_incomplete",
      labels,
      ab,
      ba
    )
  end

  defp head_limit(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "r1")
    r2 = cite_c0(base, c0, "r2")
    r3 = cite_c0(base, c0, "r3")
    k1 = F.first(base, r1)
    tr = rotation(base, node(r1.id, 1), k1, r1.catalog_key, "tr")

    labels =
      Map.merge(base_labels(base, c0), %{
        "R1" => r1.id,
        "R2" => r2.id,
        "R3" => r3.id,
        "K1" => F.cid(k1),
        "TR" => tr.id
      })

    [
      one("a third head is control_history_limit", labels, [
        step(ev(add(base.log, [r1, r2, r3]), catalogs: [c0]), err("control_history_limit"))
      ]),
      one("rotation and replacement heads count together", labels, [
        step(
          ev(add(base.log, [r1, r2]), rotations: [tr], catalogs: [c0, k1]),
          ok(["R2", "TR"],
            closed: ["B"],
            nodes: ["B", "R1", "R2", "TR"],
            forks: ["heads"],
            decision: [reason: "catalog_fork", block: "catalog_fork"]
          )
        ),
        step(
          ev(add(base.log, [r1, r2, r3]), rotations: [tr], catalogs: [c0, k1]),
          err("control_history_limit")
        )
      ])
    ]
  end

  defp closing_rule(base) do
    c0 = F.c0(base)
    r = cite_c0(base, c0, "r")
    kr = F.first(base, r)
    t = rotation(base, node(base.boot.id, 0), c0, base.catalog, "t")
    ct = F.catalog(base, t.id, 0, nil, F.identity("rot-t"), F.base_entries(base))
    t2 = rotation(base, node(base.boot.id, 0), c0, base.catalog, "t2")
    lr = add(base.log, [r])

    r2 =
      F.replacement(base, lr, "r2",
        parents: [r.id],
        prior_catalogs: [%{binding: r.id, catalog: F.cid(kr)}],
        generation: 2
      )

    k2 = F.first(base, r2)

    labels =
      Map.merge(base_labels(base, c0), %{
        "R" => r.id,
        "KR" => F.cid(kr),
        "T" => t.id,
        "CT" => F.cid(ct),
        "T2" => t2.id,
        "R2" => r2.id,
        "K2" => F.cid(k2)
      })

    accepted_r = fn closed_out ->
      ok(["R"], closed: ["B"], closed_out: closed_out, decision: accept("R", "KR"))
    end

    both(
      "closing rule: an old-key rotation of a cited binding is closed out",
      labels,
      [
        step(ev(lr, catalogs: [c0, kr]), accepted_r.([])),
        step(ev(lr, rotations: [t], catalogs: [c0, kr]), accepted_r.(["T"])),
        step(ev(lr, rotations: [t], catalogs: [c0, kr, ct]), accepted_r.(["CT", "T"])),
        step(ev(lr, rotations: [t, t2], catalogs: [c0, kr, ct]), accepted_r.(["CT", "T", "T2"]))
      ],
      [
        step(
          ev(base.log, rotations: [t], catalogs: [c0, ct]),
          ok(["T"], nodes: ["B", "T"], decision: accept("T", "CT"))
        ),
        step(
          ev(lr, rotations: [t], catalogs: [c0, ct, kr]),
          ok(["R"],
            closed: ["B"],
            closed_out: ["CT", "T"],
            decision: [
              head: "R",
              reason: "authority_changed",
              block: "authority_changed",
              freeze: true
            ]
          )
        ),
        step(
          ev(add(lr, [r2]), rotations: [t, t2], catalogs: [c0, ct, kr, k2]),
          ok(["R2"],
            closed: ["B", "R"],
            closed_out: ["CT", "T", "T2"],
            decision: accept("R2", "K2", clears: true)
          )
        )
      ]
    )
  end

  defp ancestry(base) do
    c0 = F.c0(base)
    tkey = F.identity("rot-t")
    t = rotation(base, node(base.boot.id, 0), c0, base.catalog, "t")
    ct = F.catalog(base, t.id, 0, nil, tkey, F.base_entries(base))
    z = rotation(base, node(base.boot.id, 0), c0, base.catalog, "z")
    z2 = rotation(base, node(t.id, 1), ct, tkey, "z2")

    r =
      F.replacement(base, base.log, "r",
        parents: [t.id],
        prior_catalogs: [%{binding: t.id, catalog: F.cid(ct)}],
        generation: 2
      )

    kr = F.first(base, r)
    rv = F.revoke(base, Log.frontier(base.log), base.delegation.id)
    lr = add(base.log, [r])

    labels =
      Map.merge(base_labels(base, c0), %{
        "T" => t.id,
        "CT" => F.cid(ct),
        "Z" => z.id,
        "Z2" => z2.id,
        "R" => r.id,
        "KR" => F.cid(kr),
        "Rv" => rv.id
      })

    cats = [c0, ct, kr]
    out = ["Z", "Z2"]

    both(
      "ancestry: B->Z is closed out, and stays so after R is reclassified",
      labels,
      [
        step(
          ev(lr, rotations: [t], catalogs: cats),
          ok(["R"], closed: ["B", "T"], decision: accept("R", "KR"))
        ),
        step(
          ev(lr, rotations: [t, z, z2], catalogs: cats),
          ok(["R"], closed: ["B", "T"], closed_out: out, decision: accept("R", "KR"))
        ),
        step(
          ev(add(lr, [rv]), rotations: [t, z, z2], catalogs: cats),
          ok(["R"],
            closed: ["B", "T"],
            closed_out: out,
            refused: ["R"],
            refusals: %{"KR" => "catalog_authority_refused"},
            decision: [
              head: "R",
              reason: "authority_changed",
              block: "authority_changed",
              freeze: true
            ]
          )
        )
      ],
      [
        step(
          ev(base.log, rotations: [t, z, z2], catalogs: [c0, ct]),
          ok(["Z", "Z2"],
            nodes: ["B", "T", "Z", "Z2"],
            forks: ["heads"],
            decision: [reason: "catalog_fork", block: "catalog_fork"]
          )
        ),
        step(
          ev(lr, rotations: [t, z, z2], catalogs: cats),
          ok(["R"], closed: ["B", "T"], closed_out: out, decision: accept("R", "KR"))
        )
      ]
    )
  end

  defp nil_prior(base) do
    c0 = F.c0(base)
    r = F.replacement(base, base.log, "r")
    kr = F.first(base, r)
    lr = add(base.log, [r])
    labels = Map.merge(base_labels(base, c0), %{"R" => r.id, "KR" => F.cid(kr)})

    both(
      "R citing {P, nil} survives a later C0; C0 first gives authority_changed",
      labels,
      [
        step(ev(lr, catalogs: [kr]), ok(["R"], closed: ["B"], decision: accept("R", "KR"))),
        step(
          ev(lr, catalogs: [kr, c0]),
          ok(["R"], closed: ["B"], closed_out: ["C0"], decision: accept("R", "KR"))
        )
      ],
      [
        step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
        step(
          ev(lr, catalogs: [c0, kr]),
          ok(["R"],
            closed: ["B"],
            closed_out: ["C0"],
            decision: [
              head: "R",
              reason: "authority_changed",
              block: "authority_changed",
              freeze: true
            ]
          )
        )
      ]
    )
  end

  defp refused_closes(base) do
    c0 = F.c0(base)
    r = cite_c0(base, c0, "r")
    rv = F.revoke(base, Log.frontier(base.log), base.delegation.id)
    t = rotation(base, node(base.boot.id, 0), c0, base.catalog, "t")
    l = add(base.log, [r, rv])
    labels = Map.merge(base_labels(base, c0), %{"R" => r.id, "Rv" => rv.id, "T" => t.id})

    done =
      ok(["R"],
        closed: ["B"],
        closed_out: ["T"],
        refused: ["R"],
        decision: [
          head: "R",
          reason: "catalog_authority_refused",
          block: "catalog_authority_refused"
        ]
      )

    both(
      "union-refused eligible R' citing P closes P",
      labels,
      [
        step(
          ev(l, catalogs: [c0]),
          ok(["R"],
            closed: ["B"],
            refused: ["R"],
            decision: [
              head: "R",
              reason: "catalog_authority_refused",
              block: "catalog_authority_refused"
            ]
          )
        ),
        step(ev(l, rotations: [t], catalogs: [c0]), done)
      ],
      [
        step(
          ev(base.log, rotations: [t], catalogs: [c0]),
          ok(["T"], nodes: ["B", "T"], decision: [head: "T"])
        ),
        step(ev(l, rotations: [t], catalogs: [c0]), done)
      ]
    )
  end

  defp ordinary_success(base) do
    c0 = F.c0(base)
    r2 = cite_c0(base, c0, "r2")
    k2 = F.first(base, r2)
    lr = add(base.log, [r2])
    labels = Map.merge(base_labels(base, c0), %{"R2" => r2.id, "K2" => F.cid(k2)})

    [
      one("ordinary success: honored resolution of the accepted catalog advances", labels, [
        step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
        step(
          ev(lr, catalogs: [c0, k2]),
          ok(["R2"], closed: ["B"], decision: accept("R2", "K2", clears: true))
        )
      ]),
      one("ordinary success without a ready first catalog holds without a block", labels, [
        step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
        step(ev(lr, catalogs: [c0]), ok(["R2"], closed: ["B"], decision: [head: "R2"]))
      ])
    ]
  end

  # A concurrent holder change (C13 row g): the leased admin transfers `:admin` to the nominee
  # on `deps`. Core refuses every concurrent admin command as `stale_holder`; the nominee's
  # later commands are honored. (A root re-transfer after a revoke is `revoked_capability`.)
  defp regrant(base, log, deps) do
    t2 =
      F.transfer(base, deps, base.nominee.pub, issuer: base.admin, parent_id: base.delegation.id)

    {t2.op, t2, add(log, [t2.op])}
  end

  defp refused_beside_sibling(base) do
    c0 = F.c0(base)
    bx = cite_c0(base, c0, "bx")
    {_tn, t2, l} = regrant(base, base.log, Log.frontier(base.log))

    a =
      cite_c0(base, c0, "a",
        log: l,
        author: base.nominee,
        claim: %{author: base.nominee.pub},
        cap: t2.delegation.id,
        holder_epoch: t2.op.id
      )

    labels =
      Map.merge(base_labels(base, c0), %{
        "A" => a.id,
        "Bx" => bx.id,
        "T2" => t2.op.id
      })

    one("refused uncovered head beside an honored sibling is catalog_fork", labels, [
      step(
        ev(add(l, [a, bx]), catalogs: [c0]),
        ok(["A", "Bx"],
          closed: ["B"],
          refused: ["Bx"],
          forks: ["heads"],
          decision: [reason: "catalog_fork", block: "catalog_fork"]
        )
      )
    ])
  end

  defp c13(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "r1")
    k1 = F.first(base, r1)
    l1 = add(base.log, [r1])
    {tn, t2, l2} = regrant(base, l1, Log.frontier(base.log))

    r2 =
      F.replacement(base, l2, "r2",
        parents: [r1.id],
        prior_catalogs: [%{binding: r1.id, catalog: F.cid(k1)}],
        generation: 2,
        author: base.nominee,
        claim: %{author: base.nominee.pub},
        cap: t2.delegation.id,
        holder_epoch: t2.op.id
      )

    k2 = F.first(base, r2)
    l3 = add(l2, [r2])
    rv_only = add(base.log, [tn])

    labels =
      Map.merge(base_labels(base, c0), %{
        "R1" => r1.id,
        "K1" => F.cid(k1),
        "T2" => t2.op.id,
        "R2" => r2.id,
        "K2" => F.cid(k2)
      })

    cats = [c0, k1, k2]

    resolved = fn clears ->
      ok(["R2"],
        closed: ["B", "R1"],
        refused: ["R1"],
        refusals: %{"K1" => "catalog_authority_refused"},
        decision: accept("R2", "K2", clears: clears)
      )
    end

    refused_r1 =
      ok(["R1"],
        closed: ["B"],
        refused: ["R1"],
        refusals: %{"K1" => "catalog_authority_refused"},
        decision: [
          head: "R1",
          reason: "authority_changed",
          block: "authority_changed",
          freeze: true
        ]
      )

    [
      one("C13: concurrent revoke after accepting R1, then a fresh resolution clears", labels, [
        step(ev(l1, catalogs: [c0, k1]), ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))),
        step(ev(add(l1, [tn]), catalogs: [c0, k1]), refused_r1),
        step(ev(l3, catalogs: cats), resolved.(true))
      ]),
      one("C13: revoke and resolution delivered together after accepting R1", labels, [
        step(ev(l1, catalogs: [c0, k1]), ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))),
        step(ev(l3, catalogs: cats), resolved.(true)),
        step(ev(l3, catalogs: cats), resolved.(false))
      ]),
      one("C13: a revoke-first client holds R1 as a refused node", labels, [
        step(ev(rv_only, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
        step(
          ev(add(rv_only, [r1]), catalogs: [c0, k1]),
          ok(["R1"],
            closed: ["B"],
            refused: ["R1"],
            refusals: %{"K1" => "catalog_authority_refused"},
            decision: [
              head: "R1",
              reason: "catalog_authority_refused",
              block: "catalog_authority_refused"
            ]
          )
        ),
        step(ev(l3, catalogs: cats), resolved.(true))
      ])
    ]
  end

  defp idempotent_and_rollback(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "r1")
    k1 = F.first(base, r1)
    l1 = add(base.log, [r1])
    labels = Map.merge(base_labels(base, c0), %{"R1" => r1.id, "K1" => F.cid(k1)})
    done = ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))

    routes = Map.new(k1.catalog.entries, &{&1.route, &1.replica})

    high = %{
      accepted: %{binding: r1.id, generation: 5, catalog: F.cid(k1), revision: 0, routes: routes},
      frozen: false
    }

    revised = %{
      accepted: %{binding: r1.id, generation: 1, catalog: F.cid(k1), revision: 3, routes: routes},
      frozen: false
    }

    [
      one("same bytes are idempotent", labels, [
        step(ev(l1, catalogs: [c0, k1]), done),
        step(ev(l1, catalogs: [c0, k1]), done)
      ]),
      # The design's Covers drops the generation rollback clause: under the watermark's own
      # binding only the catalog chain and revision are compared, so a higher stored generation
      # is informational.
      one("a higher stored generation under the same binding is informational", labels, [
        step(ev(l1, catalogs: [c0, k1]), done, high)
      ]),
      one("lower catalog revision than the watermark is catalog_rollback", labels, [
        step(
          ev(l1, catalogs: [c0, k1]),
          ok(["R1"],
            closed: ["B"],
            decision: [head: "R1", reason: "catalog_rollback", serving: "K1"]
          ),
          revised
        )
      ])
    ]
  end

  # Row 390: a real pool Thread (entry facts are judged against its history).
  defp thread_of(base, space, name),
    do: F.pool_thread(base, %{space | route: "/r/" <> F.id("route-thread-" <> name)}, "thread")

  # Review round 4, finding 1: accepted R1/K1 has two valid revision-1 siblings, Ka (Space) and
  # Kb (Space + Thread). A concurrent holder change refuses R1. R2 citing only {R1, Ka} with a
  # Space-only K2 omits Kb: Kb is a refused-node catalog but still a citable head, so it is an
  # uncovered catalog head (catalog_fork), as authoring coverage reads it. R2b citing both
  # siblings and carrying the Thread forward is accepted.
  defp refused_parent_sibling(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "r1")
    k1 = F.first(base, r1)
    l1 = add(base.log, [r1])
    [space] = r1.entries
    ka = F.catalog(base, r1.id, 1, F.cid(k1), r1.catalog_key, [space])

    kb =
      F.catalog(base, r1.id, 1, F.cid(k1), r1.catalog_key, [space, thread_of(base, space, "r1")])

    {_tn, t2, l2} = regrant(base, l1, Log.frontier(base.log))

    nominee = [
      parents: [r1.id],
      generation: 2,
      author: base.nominee,
      cap: t2.delegation.id,
      holder_epoch: t2.op.id
    ]

    r2 =
      F.replacement(
        base,
        l2,
        "r2",
        nominee ++
          [
            prior_catalogs: [%{binding: r1.id, catalog: F.cid(ka)}],
            claim: %{author: base.nominee.pub}
          ]
      )

    k2 = F.first(base, r2)

    sid = F.id("service-id-r2b")
    skey = F.identity("service-r2b")
    [space2] = F.entries(base, "r2b", sid, skey.pub)
    thread2 = thread_of(base, space2, "r2b")

    thread_cut = %{
      replica: thread2.replica,
      frontier: [F.id("f-thread-r2b")],
      log_digest: F.id("d-thread-r2b")
    }

    [space_cut] = r2.claim.cutoffs

    r2b =
      F.replacement(
        base,
        l2,
        "r2b",
        nominee ++
          [
            prior_catalogs:
              Enum.sort_by(
                [%{binding: r1.id, catalog: F.cid(ka)}, %{binding: r1.id, catalog: F.cid(kb)}],
                & &1.catalog
              ),
            service_id: sid,
            service_key: skey,
            entries: [space2, thread2],
            claim: %{
              author: base.nominee.pub,
              cutoffs: Enum.sort_by([space_cut, thread_cut], & &1.replica)
            }
          ]
      )

    k2b = F.first(base, r2b)

    labels =
      Map.merge(base_labels(base, c0), %{
        "R1" => r1.id,
        "K1" => F.cid(k1),
        "Ka" => F.cid(ka),
        "Kb" => F.cid(kb),
        "T2" => t2.op.id,
        "R2" => r2.id,
        "K2" => F.cid(k2),
        "R2b" => r2b.id,
        "K2b" => F.cid(k2b)
      })

    accepted = ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))

    refused = %{
      "K1" => "catalog_authority_refused",
      "Ka" => "catalog_authority_refused",
      "Kb" => "catalog_authority_refused"
    }

    [
      one("a resolution omitting a sibling catalog under a refused parent forks", labels, [
        step(ev(l1, catalogs: [c0, k1]), accepted),
        step(
          ev(add(l2, [r2]), catalogs: [c0, k1, ka, kb, k2]),
          ok(["R2"],
            closed: ["B", "R1"],
            refused: ["R1"],
            refusals: refused,
            forks: ["catalog"],
            decision: [reason: "catalog_fork", block: "catalog_fork", freeze: true]
          )
        )
      ]),
      one("a resolution citing both siblings under a refused parent is accepted", labels, [
        step(ev(l1, catalogs: [c0, k1]), accepted),
        step(
          ev(add(l2, [r2b]), catalogs: [c0, k1, ka, kb, k2b]),
          ok(["R2b"],
            closed: ["B", "R1"],
            refused: ["R1"],
            refusals: refused,
            decision: accept("R2b", "K2b", clears: true)
          )
        )
      ])
    ]
  end

  # Review round 4, finding 2: accepted R/KR closes B citing C0. A B-signed X (revision 1,
  # `previous` KR, which is bound to R) fails its own chain, so it is refused and never an
  # omitted catalog head. An uncited X2 whose `previous` Y is not yet held is closed-out evidence,
  # and stays closed out when Y (a descendant of the cited C0) arrives.
  defp invalid_old_key_catalog(base) do
    c0 = F.c0(base)
    r = cite_c0(base, c0, "r")
    kr = F.first(base, r)
    lr = add(base.log, [r])
    x = F.catalog(base, base.boot.id, 1, F.cid(kr), base.catalog, F.base_entries(base))
    y = F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, F.base_entries(base))
    x2 = F.catalog(base, base.boot.id, 2, F.cid(y), base.catalog, F.base_entries(base))

    labels =
      Map.merge(base_labels(base, c0), %{
        "R" => r.id,
        "KR" => F.cid(kr),
        "X" => F.cid(x),
        "Y" => F.cid(y),
        "X2" => F.cid(x2)
      })

    held = fn opts -> ok(["R"], [closed: ["B"], decision: accept("R", "KR")] ++ opts) end

    one("an old-key catalog failing its own chain cannot fork a closed binding", labels, [
      step(ev(lr, catalogs: [c0, kr]), held.([])),
      step(
        ev(lr, catalogs: [c0, kr, x]),
        held.(refusals: %{"X" => "invalid_catalog_transition"})
      ),
      step(ev(lr, catalogs: [c0, kr, x2]), held.(closed_out: ["X2"])),
      step(ev(lr, catalogs: [c0, kr, x2, y]), held.(closed_out: ["X2", "Y"]))
    ])
  end

  # Review round 4, finding 5: a proof matches a cutoff only on the whole
  # `{replica, frontier, log_digest}`. A replacement and a rotation each claiming a different
  # frontier than the proven one stay recovery_incomplete.
  defp cutoff_frontier(base) do
    c0 = F.c0(base)
    genuine = hd(cite_c0(base, c0, "rq-genuine").claim.cutoffs)
    forged = %{genuine | frontier: [F.id("forged-frontier")]}
    r = cite_c0(base, c0, "rq", claim: %{cutoffs: [forged]})
    kr = F.first(base, r)
    t = rotation(base, node(base.boot.id, 0), c0, base.catalog, "tq")
    ct = F.catalog(base, t.id, 0, nil, F.identity("rot-tq"), F.base_entries(base))
    [tcut] = t.envelope.rotation.cutoffs
    tproof = %{tcut | frontier: [F.id("forged-rotation-frontier")]}

    labels =
      Map.merge(base_labels(base, c0), %{
        "R" => r.id,
        "KR" => F.cid(kr),
        "T" => t.id,
        "CT" => F.cid(ct)
      })

    [
      one("a replacement cutoff proof must match the claimed frontier", labels, [
        step(
          ev(add(base.log, [r.op]), catalogs: [c0, kr], proven: [genuine]),
          ok(["R"],
            closed: ["B"],
            pending: ["R"],
            decision: [head: "R", reason: "recovery_incomplete", block: "recovery_incomplete"]
          )
        ),
        step(
          ev(add(base.log, [r.op]), catalogs: [c0, kr], proven: [forged]),
          ok(["R"], closed: ["B"], decision: accept("R", "KR"))
        )
      ]),
      one("a rotation cutoff proof must match the claimed frontier", labels, [
        step(
          ev(base.log, rotations: [t], catalogs: [c0, ct], proven: [tproof]),
          ok(["T"],
            nodes: ["B", "T"],
            pending: ["T"],
            decision: [head: "T", reason: "recovery_incomplete", block: "recovery_incomplete"]
          )
        ),
        step(
          ev(base.log, rotations: [t], catalogs: [c0, ct], proven: [tcut]),
          ok(["T"], nodes: ["B", "T"], decision: accept("T", "CT"))
        )
      ])
    ]
  end

  # --- running and viewing ---------------------------------------------------------

  @doc "Run one scenario; returns `[%{label_view, expect, view, input, state_in}]` per step."
  def run(base, scenario) do
    scenario.steps
    |> Enum.map_reduce(F.empty_state(), fn s, state ->
      state = s.state || state
      {result, next} = F.deliver(base, state, s.evidence)

      {%{
         label_view: label_view(result, scenario.labels, next),
         expect: s.expect,
         view: F.view(result, next),
         evidence: s.evidence,
         state_in: state
       }, F.persisted(next)}
    end)
    |> elem(0)
  end

  @doc "The label-space view of one delivery and the state `advance/2` returns for it."
  def label_view(result, labels, next) do
    l = label_fun(labels)

    # A non-id serving value (none in this runtime) shows as its string, so a red run against
    # an earlier revision reports it instead of crashing.
    serving =
      if is_binary(next.serving),
        do: l.(next.serving),
        else: next.serving && to_string(next.serving)

    result
    |> label_view(labels)
    |> Map.put("after", %{"frozen" => next.frozen, "serving" => serving})
  end

  def label_view({:error, :trust_pending, %{freeze: freeze, serving: serving}}, labels) do
    l = label_fun(labels)
    %{"error" => "trust_pending", "freeze" => freeze, "serving" => serving && l.(serving)}
  end

  def label_view({:error, reason, _}, _labels), do: %{"error" => to_string(reason)}

  def label_view({:ok, g}, labels) do
    l = label_fun(labels)
    d = g.decision

    %{
      "heads" => sorted(g.heads, l),
      "closed" => sorted(g.closed, l),
      "closed_out" => sorted(Map.keys(g.closed_out), l),
      "nodes" => sorted(Map.keys(g.nodes), l),
      "refused" => sorted(for({id, %{refused?: true}} <- g.nodes, do: id), l),
      "raw" => Map.new(g.raw_evidence, fn {id, r} -> {l.(id), to_string(r)} end),
      "refusals" => Map.new(g.refusals, fn {id, r} -> {l.(id), to_string(r.reason)} end),
      "pending" => sorted(g.pending, l),
      "forks" => g.forks |> Enum.map(&to_string(&1.kind)) |> Enum.uniq() |> Enum.sort(),
      "decision" => %{
        "accepted" => d.accepted,
        "reason" => d.reason && to_string(d.reason),
        "block" => d.block && to_string(d.block.reason),
        "freeze" => (d.block && d.block.freeze) || false,
        "head" => d.head && l.(d.head),
        "catalog" => d.catalog && l.(d.catalog),
        "clears" => d.clears_authority_changed,
        "serving" => d.serving && l.(d.serving)
      }
    }
  end

  defp label_fun(labels) do
    reverse = Map.new(labels, fn {k, v} -> {v, k} end)
    &Map.get(reverse, &1, "?" <> &1)
  end

  defp sorted(ids, l), do: ids |> Enum.map(l) |> Enum.sort()

  # --- vectors -----------------------------------------------------------------------

  @doc """
  The JSON vector: inputs (frames and artifacts deduplicated by id), hand-written
  expectations and BEAM incidental outputs.
  """
  def vector(base \\ F.base()) do
    runs = Enum.map(all(base), &{&1, run(base, &1)})
    evidences = for {_s, rs} <- runs, r <- rs, do: r.evidence

    frames =
      for e <- evidences, {id, op} <- Log.ops(e.space), into: %{}, do: {id, Wire.encode_op(op)}

    artifacts =
      for e <- evidences,
          {id, env} <- Map.to_list(e.rotations) ++ Map.to_list(e.catalogs),
          into: %{},
          do: {id, artifact(env)}

    %{
      "version" => 1,
      "bootstrap" => %{"id" => base.boot.id, "record" => Wire.encode_value(base.boot.record)},
      "space" => base.replica,
      "generation_cases" => generation_cases(),
      "frames" => frames,
      # Row 390: the pool Thread histories every step's entry facts are judged against.
      "histories" =>
        Map.new(F.histories(base), fn {replica, log} ->
          {replica, log |> Log.topo_ops() |> Enum.map(&Wire.encode_op/1)}
        end),
      "artifacts" => artifacts,
      "scenarios" =>
        Enum.map(runs, fn {s, rs} ->
          %{
            "name" => s.name,
            "labels" => s.labels,
            "steps" =>
              Enum.map(rs, fn r ->
                %{
                  "state" => F.state_json(r.state_in),
                  "frames" => r.evidence.space |> Log.ops() |> Map.keys() |> Enum.sort(),
                  "rotations" => r.evidence.rotations |> Map.keys() |> Enum.sort(),
                  "catalogs" => r.evidence.catalogs |> Map.keys() |> Enum.sort(),
                  "proven" =>
                    Enum.map(
                      r.evidence.proven,
                      &%{
                        "replica" => &1.replica,
                        "frontier" => &1.frontier,
                        "logDigest" => &1.log_digest
                      }
                    ),
                  "expect" => r.expect,
                  "beam" => r.view
                }
              end)
          }
        end)
    }
  end

  @doc "Unsafe-integer boundary cases for `next_generation/1` (finding 9)."
  def generation_cases do
    max = 9_007_199_254_740_991

    [
      %{"generations" => [0], "next" => 1},
      %{"generations" => [3, 1, 2], "next" => 4},
      %{"generations" => [max - 1], "next" => max},
      %{"generations" => [max], "next" => nil},
      %{"generations" => [], "next" => nil}
    ]
  end

  defp artifact(envelope), do: envelope |> Wire.encode_value() |> Jason.encode!()

  @doc "Write `binding_graph_v1.json`."
  def write(path) do
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, encode(vector()))
  end

  def encode(vector), do: Jason.encode!(vector, pretty: true) <> "\n"

  # --- review round: intrinsic Core refusal, block carry-forward, route reservation ----------

  defp revoked_in_prefix(base) do
    c0 = F.c0(base)
    rv = F.revoke(base, Log.frontier(base.log), base.delegation.id)
    lrv = add(base.log, [rv])
    rr = cite_c0(base, c0, "rr", log: lrv)
    r1 = cite_c0(base, c0, "r1")
    k1 = F.first(base, r1)
    l1 = add(base.log, [r1])
    later = F.revoke(base, Log.frontier(l1), base.delegation.id)

    labels =
      Map.merge(base_labels(base, c0), %{
        "Rv" => rv.id,
        "Rr" => rr.id,
        "R1" => r1.id,
        "K1" => F.cid(k1),
        "Later" => later.id
      })

    [
      one("authority revoked inside the candidate's own prefix adds no head or closure", labels, [
        step(
          ev(add(lrv, [rr]), catalogs: [c0]),
          ok(["B"], raw: %{"Rr" => "catalog_authority_refused"}, decision: accept("B", "C0"))
        )
      ]),
      one("a causally later revoke keeps the history", labels, [
        step(ev(l1, catalogs: [c0, k1]), ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))),
        step(
          ev(add(l1, [later]), catalogs: [c0, k1]),
          ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))
        )
      ])
    ]
  end

  defp late_first_catalog(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "r1")
    k1 = F.first(base, r1)
    l1 = add(base.log, [r1])
    {tn, t2, l2} = regrant(base, l1, Log.frontier(base.log))

    r2 =
      F.replacement(base, l2, "r2",
        parents: [r1.id],
        prior_catalogs: [%{binding: r1.id, catalog: F.cid(k1)}],
        generation: 2,
        author: base.nominee,
        claim: %{author: base.nominee.pub},
        cap: t2.delegation.id,
        holder_epoch: t2.op.id
      )

    k2 = F.first(base, r2)
    l3 = add(l2, [r2])

    r = F.replacement(base, base.log, "r")
    kr = F.first(base, r)
    lr = add(base.log, [r])

    rp =
      F.replacement(base, lr, "rp",
        parents: [r.id],
        prior_catalogs: [%{binding: r.id, catalog: F.cid(kr)}],
        generation: 2
      )

    kp = F.first(base, rp)
    lp = add(lr, [rp])

    labels =
      Map.merge(base_labels(base, c0), %{
        "R1" => r1.id,
        "K1" => F.cid(k1),
        "T2" => tn.id,
        "R2" => r2.id,
        "K2" => F.cid(k2),
        "R" => r.id,
        "KR" => F.cid(kr),
        "Rp" => rp.id,
        "KP" => F.cid(kp)
      })

    changed = fn head, opts ->
      ok(
        [head],
        opts ++
          [
            decision: [
              head: head,
              reason: "authority_changed",
              block: "authority_changed",
              freeze: true
            ]
          ]
      )
    end

    refused_k1 = %{"K1" => "catalog_authority_refused"}

    [
      one("C13: a resolution delivered before its first catalog still clears", labels, [
        step(ev(l1, catalogs: [c0, k1]), ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))),
        step(
          ev(add(l1, [tn]), catalogs: [c0, k1]),
          changed.("R1", closed: ["B"], refused: ["R1"], refusals: refused_k1)
        ),
        step(
          ev(l3, catalogs: [c0, k1]),
          changed.("R2", closed: ["B", "R1"], refused: ["R1"], refusals: refused_k1)
        ),
        step(
          ev(l3, catalogs: [c0, k1, k2]),
          ok(["R2"],
            closed: ["B", "R1"],
            refused: ["R1"],
            refusals: refused_k1,
            decision: accept("R2", "K2", clears: true)
          )
        )
      ]),
      one(
        "closing rule: a later resolution delivered before its first catalog still clears",
        labels,
        [
          step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
          step(ev(lr, catalogs: [c0, kr]), changed.("R", closed: ["B"], closed_out: ["C0"])),
          step(
            ev(lp, catalogs: [c0, kr]),
            changed.("Rp", closed: ["B", "R"], closed_out: ["C0"])
          ),
          step(
            ev(lp, catalogs: [c0, kr, kp]),
            ok(["Rp"],
              closed: ["B", "R"],
              closed_out: ["C0"],
              decision: accept("Rp", "KP", clears: true)
            )
          )
        ]
      )
    ]
  end

  # An old-key catalog under a closed binding reuses the head's route for another replica.
  defp route_reservation(base) do
    c0 = F.c0(base)
    r = F.replacement(base, base.log, "r")
    kr = F.first(base, r)
    [space] = F.base_entries(base)
    [route] = Enum.map(r.entries, & &1.route)

    squat =
      F.catalog(base, base.boot.id, 0, nil, base.catalog, [
        space,
        F.pool_thread(base, %{space | route: route}, "squat")
      ])

    labels =
      Map.merge(base_labels(base, c0), %{"R" => r.id, "KR" => F.cid(kr), "Squat" => F.cid(squat)})

    one("closed-out old-key catalogs reserve no route", labels, [
      step(
        ev(add(base.log, [r]), catalogs: [squat, kr]),
        ok(["R"], closed: ["B"], closed_out: ["Squat"], decision: accept("R", "KR"))
      )
    ])
  end

  defp pending_parent(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "r1")
    l1 = add(base.log, [r1])

    r2 =
      F.replacement(base, l1, "r2",
        parents: [r1.id],
        prior_catalogs: [%{binding: r1.id, catalog: nil}],
        generation: 2
      )

    k1 = F.first(base, r1)
    k2 = F.first(base, r2)

    labels =
      Map.merge(base_labels(base, c0), %{
        "R1" => r1.id,
        "R2" => r2.id,
        "K1" => F.cid(k1),
        "K2" => F.cid(k2)
      })

    one("held-but-pending parent makes the child pending", labels, [
      step(ev(add(l1, [r2]), catalogs: [k2]), err("trust_pending")),
      step(
        ev(add(l1, [r2]), catalogs: [c0, k1, k2]),
        ok(["R2"], closed: ["B", "R1"], closed_out: ["K1"], decision: accept("R2", "K2"))
      )
    ])
  end

  defp possession_each(base) do
    c0 = F.c0(base)
    pc = F.replacement(base, base.log, "pc", bad_possession: :catalog)
    ps = F.replacement(base, base.log, "ps", bad_possession: :service)
    deps = F.replacement(base, base.log, "deps", claim: %{deps: [base.boot.id]})

    labels =
      Map.merge(base_labels(base, c0), %{"Pc" => pc.id, "Ps" => ps.id, "Deps" => deps.id})

    one("each possession signature and the literal deps binding are re-checked", labels, [
      step(
        ev(add(base.log, [pc, ps, deps]), catalogs: [c0]),
        ok(["B"],
          raw: %{
            "Pc" => "invalid_possession",
            "Ps" => "invalid_possession",
            "Deps" => "invalid_catalog_transition"
          },
          decision: accept("B", "C0")
        )
      )
    ])
  end

  # --- review round 2: incomplete control history, rotation recovery, refused citations,
  # sequential nonce reuse, an absent accepted catalog -----------------------------------------

  # A concurrent revoke V whose dependency E is not held: the union is a smaller history, so
  # the resolve is trust_pending, never a judgment that later flips.
  defp incomplete_control(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "r1")
    k1 = F.first(base, r1)
    l1 = add(base.log, [r1])
    e = F.beacon(base, Log.frontier(base.log), 2)
    v = F.revoke(base, Enum.sort([e.id | Log.frontier(base.log)]), base.delegation.id)
    loose = Log.from_ops(base.replica, Map.put(Log.ops(l1), v.id, v))

    labels =
      Map.merge(base_labels(base, c0), %{
        "R1" => r1.id,
        "K1" => F.cid(k1),
        "E" => e.id,
        "V" => v.id
      })

    one("a held control op with an incomplete closure is trust_pending", labels, [
      step(ev(l1, catalogs: [c0, k1]), ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))),
      # The revoke's own closure is incomplete, so the complete part still accepts R1/K1:
      # pending evidence alone neither freezes nor stops serving (row 386, the section 4 limit).
      step(ev(loose, catalogs: [c0, k1]), err("trust_pending", serving: "K1")),
      step(
        ev(add(l1, [e, v]), catalogs: [c0, k1]),
        ok(["R1"],
          closed: ["B"],
          refused: ["R1"],
          refusals: %{"K1" => "catalog_authority_refused"},
          decision: [
            head: "R1",
            reason: "authority_changed",
            block: "authority_changed",
            freeze: true
          ]
        )
      )
    ])
  end

  # A rotation from a replacement keeps its service, so it inherits the unproven cutoffs.
  defp rotation_recovery(base) do
    c0 = F.c0(base)
    r = F.replacement(base, base.log, "r")
    kr = F.first(base, r)
    t = rotation(base, node(r.id, 1), kr, r.catalog_key, "t")
    ct = F.catalog(base, t.id, 0, nil, F.identity("rot-t"), r.entries)
    lr = add(base.log, [r])

    labels =
      Map.merge(base_labels(base, c0), %{
        "R" => r.id,
        "KR" => F.cid(kr),
        "T" => t.id,
        "CT" => F.cid(ct)
      })

    rotated = fn opts -> ok(["T"], [closed: ["B"], nodes: ["B", "R", "T"]] ++ opts) end

    one("a rotation does not bypass its replacement's recovery cutoffs", labels, [
      step(
        ev(lr, catalogs: [kr], unproven: [r.id]),
        ok(["R"],
          closed: ["B"],
          pending: ["R"],
          decision: [head: "R", reason: "recovery_incomplete", block: "recovery_incomplete"]
        )
      ),
      step(
        ev(lr, rotations: [t], catalogs: [kr, ct], unproven: [r.id]),
        rotated.(
          pending: ["R", "T"],
          decision: [head: "T", reason: "recovery_incomplete", block: "recovery_incomplete"]
        )
      ),
      step(
        ev(lr, rotations: [t], catalogs: [kr, ct]),
        rotated.(decision: accept("T", "CT"))
      )
    ])
  end

  # C0 lists Space + Thread; C1 follows C0 but drops the Thread (refused). R cites {B, C1}
  # with a Space-only first catalog: the citation does not make C1 valid, and R citing an
  # invalid prior is raw evidence (row 382), so B/C0 is kept, in both delivery orders.
  defp refused_catalog_citation(base) do
    [space] = F.base_entries(base)

    thread = F.pool_thread(base, %{space | route: "/r/" <> F.id("route-thread")}, "thread")

    c0 = F.catalog(base, base.boot.id, 0, nil, base.catalog, [space, thread])
    c1 = F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, [space])

    r =
      F.replacement(base, base.log, "r",
        prior_catalogs: [%{binding: base.boot.id, catalog: F.cid(c1)}]
      )

    kr = F.first(base, r)
    lr = add(base.log, [r])

    labels =
      Map.merge(base_labels(base, c0), %{"C1" => F.cid(c1), "R" => r.id, "KR" => F.cid(kr)})

    # Row 382 (OD-17): an intrinsically invalid cited prior makes R raw evidence, so B stays
    # open and B/C0 is kept and served.
    refused =
      ok(["B"],
        raw: %{"R" => "invalid_catalog_transition"},
        refusals: %{"C1" => "invalid_catalog_transition", "KR" => "invalid_catalog_transition"},
        decision: accept("B", "C0")
      )

    both(
      "citing a refused catalog neither rehabilitates it nor drops a Thread",
      labels,
      [
        step(
          ev(base.log, catalogs: [c0, c1]),
          ok(["B"],
            refusals: %{"C1" => "invalid_catalog_transition"},
            decision: accept("B", "C0")
          )
        ),
        step(ev(lr, catalogs: [c0, c1, kr]), refused)
      ],
      [
        step(ev(lr, catalogs: [c1, kr]), err("trust_pending")),
        step(ev(lr, catalogs: [c0, c1, kr]), refused)
      ]
    )
  end

  # The same Thread removal through an old-key rotation: T from B names refused C1 as its
  # prior, so T is a retained refusal rather than a head (row 382), CT under it is refused, and
  # the accepted (B, C0) stays.
  defp rotation_refused_prior(base) do
    [space] = F.base_entries(base)

    thread = F.pool_thread(base, %{space | route: "/r/" <> F.id("route-thread")}, "thread")

    c0 = F.catalog(base, base.boot.id, 0, nil, base.catalog, [space, thread])
    c1 = F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, [space])
    t = rotation(base, node(base.boot.id, 0), c1, base.catalog, "tc")
    ct = F.catalog(base, t.id, 0, nil, F.identity("rot-tc"), [space])

    labels =
      Map.merge(base_labels(base, c0), %{"C1" => F.cid(c1), "T" => t.id, "CT" => F.cid(ct)})

    one("a rotation naming a refused prior catalog cannot drop a Thread", labels, [
      step(
        ev(base.log, catalogs: [c0, c1]),
        ok(["B"], refusals: %{"C1" => "invalid_catalog_transition"}, decision: accept("B", "C0"))
      ),
      step(
        ev(base.log, rotations: [t], catalogs: [c0, c1, ct]),
        ok(["B"],
          refusals: %{
            "C1" => "invalid_catalog_transition",
            "CT" => "invalid_catalog_transition",
            "T" => "invalid_catalog_transition"
          },
          decision: accept("B", "C0")
        )
      )
    ])
  end

  # An uncited old-key catalog under a closed binding whose `previous` is not held is closed
  # out, never trust_pending (it cannot stall the resolution).
  defp uncited_pending(base) do
    c0 = F.c0(base)
    r = F.replacement(base, base.log, "r")
    kr = F.first(base, r)

    x =
      F.catalog(
        base,
        base.boot.id,
        1,
        F.id("unheld-previous"),
        base.catalog,
        F.base_entries(base)
      )

    labels = Map.merge(base_labels(base, c0), %{"R" => r.id, "KR" => F.cid(kr), "X" => F.cid(x)})

    one("an uncited old-key catalog with an unheld previous does not stall", labels, [
      step(
        ev(add(base.log, [r]), catalogs: [kr, x]),
        ok(["R"], closed: ["B"], closed_out: ["X"], decision: accept("R", "KR"))
      )
    ])
  end

  # R2 reuses its closed parent R1's nonce with a different claim (lifecycle section 3): a
  # nonce fork, resolved once a later R3 closes R2 as well.
  defp sequential_nonce(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "r1")
    k1 = F.first(base, r1)
    l1 = add(base.log, [r1])

    r2 =
      F.replacement(base, l1, "r2",
        parents: [r1.id],
        prior_catalogs: [%{binding: r1.id, catalog: F.cid(k1)}],
        generation: 2,
        claim: %{nonce: r1.claim.nonce}
      )

    k2 = F.first(base, r2)
    l2 = add(l1, [r2])

    r3 =
      F.replacement(base, l2, "r3",
        parents: [r2.id],
        prior_catalogs: [%{binding: r2.id, catalog: F.cid(k2)}],
        generation: 3
      )

    k3 = F.first(base, r3)

    labels =
      Map.merge(base_labels(base, c0), %{
        "R1" => r1.id,
        "K1" => F.cid(k1),
        "R2" => r2.id,
        "K2" => F.cid(k2),
        "R3" => r3.id,
        "K3" => F.cid(k3)
      })

    one("a child reusing its closed parent's nonce is catalog_fork until resolved", labels, [
      step(ev(l1, catalogs: [c0, k1]), ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))),
      step(
        ev(l2, catalogs: [c0, k1, k2]),
        ok(["R2"],
          closed: ["B", "R1"],
          forks: ["nonce"],
          decision: [reason: "catalog_fork", block: "catalog_fork"]
        )
      ),
      step(
        ev(add(l2, [r3]), catalogs: [c0, k1, k2, k3]),
        ok(["R3"], closed: ["B", "R1", "R2"], decision: accept("R3", "K3", clears: true))
      )
    ])
  end

  # Accepted (B, C0), but the caller omits C0: the resolver fails closed instead of promoting.
  defp missing_accepted(base) do
    c0 = F.c0(base)
    r = F.replacement(base, base.log, "r")
    kr = F.first(base, r)
    labels = Map.merge(base_labels(base, c0), %{"R" => r.id, "KR" => F.cid(kr)})

    state = %{
      accepted: %{
        binding: base.boot.id,
        generation: 0,
        catalog: F.cid(c0),
        revision: 0,
        routes: Map.new(c0.catalog.entries, &{&1.route, &1.replica})
      },
      frozen: false
    }

    one("an accepted catalog absent from the input fails closed", labels, [
      step(
        ev(add(base.log, [r]), catalogs: [kr]),
        ok(["R"],
          closed: ["B"],
          decision: [head: "R", reason: "authority_changed", block: "authority_changed"]
        ),
        state
      )
    ])
  end

  # Review round 3, finding 1 (D-275 non-stall): accepted R1/K1 closes B. An old-key rotation T
  # from B names a withheld C1, T2 rotates the pending T, and CT sits under T. None of them can
  # pend: each is closed-out evidence, so R2/K2 still promotes, and C1 arriving later only adds
  # C1 to the closed-out evidence.
  defp closed_rotation_withheld_prior(base) do
    c0 = F.c0(base)
    c1 = F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, F.base_entries(base))
    r1 = cite_c0(base, c0, "r1")
    k1 = F.first(base, r1)
    l1 = add(base.log, [r1])
    tkey = F.identity("rot-tw")
    t = rotation(base, node(base.boot.id, 0), c1, base.catalog, "tw")
    ct = F.catalog(base, t.id, 0, nil, tkey, F.base_entries(base))
    t2 = rotation(base, node(t.id, 1), ct, tkey, "tw2")

    r2 =
      F.replacement(base, l1, "r2",
        parents: [r1.id],
        prior_catalogs: [%{binding: r1.id, catalog: F.cid(k1)}],
        generation: 2
      )

    k2 = F.first(base, r2)
    l2 = add(l1, [r2])

    labels =
      Map.merge(base_labels(base, c0), %{
        "C1" => F.cid(c1),
        "R1" => r1.id,
        "K1" => F.cid(k1),
        "T" => t.id,
        "CT" => F.cid(ct),
        "T2" => t2.id,
        "R2" => r2.id,
        "K2" => F.cid(k2)
      })

    held = fn closed_out ->
      ok(["R1"], closed: ["B"], closed_out: closed_out, decision: accept("R1", "K1"))
    end

    out = ["CT", "T", "T2"]

    both(
      "a closed old-key rotation with a withheld prior catalog cannot freeze recovery",
      labels,
      [
        step(ev(l1, catalogs: [c0, k1]), held.([])),
        step(ev(l1, rotations: [t], catalogs: [c0, k1]), held.(["T"])),
        step(ev(l1, rotations: [t, t2], catalogs: [c0, k1, ct]), held.(out)),
        step(
          ev(l2, rotations: [t, t2], catalogs: [c0, k1, ct, k2]),
          ok(["R2"],
            closed: ["B", "R1"],
            closed_out: out,
            decision: accept("R2", "K2", clears: true)
          )
        ),
        step(
          ev(l2, rotations: [t, t2], catalogs: [c0, c1, k1, ct, k2]),
          ok(["R2"], closed: ["B", "R1"], closed_out: ["C1" | out], decision: accept("R2", "K2"))
        )
      ],
      [
        # While B is open the withheld C1 is a missing page (D-5); R1 then closes T out.
        step(ev(base.log, rotations: [t], catalogs: [c0]), err("trust_pending")),
        step(ev(l1, rotations: [t], catalogs: [c0, k1]), held.(["T"])),
        step(
          ev(l2, rotations: [t, t2], catalogs: [c0, k1, ct, k2]),
          ok(["R2"],
            closed: ["B", "R1"],
            closed_out: out,
            decision: accept("R2", "K2", clears: true)
          )
        )
      ]
    )
  end

  # Review round 3, finding 2: C0 lists Space + Thread and R commits the same inventory under
  # its new service, but R's cutoffs cover only the Space. Its first catalog KR is refused (the
  # cutoffs must cover every entry, as for a rotation); the full-cutoff Rf promotes.
  defp replacement_cutoff_coverage(base) do
    [space] = F.base_entries(base)

    thread = F.pool_thread(base, %{space | route: "/r/" <> F.id("route-thread")}, "thread")

    c0 = F.catalog(base, base.boot.id, 0, nil, base.catalog, [space, thread])
    prior = [%{binding: base.boot.id, catalog: F.cid(c0)}]

    moved = fn name ->
      key = F.identity("service-" <> name).pub
      sid = F.id("service-id-" <> name)
      for e <- [space, thread], do: %{e | service_id: sid, service_key: key}
    end

    r = F.replacement(base, base.log, "rcut", prior_catalogs: prior, entries: moved.("rcut"))
    kr = F.first(base, r)

    thread_cut = %{
      replica: thread.replica,
      frontier: [F.id("f-thread")],
      log_digest: F.id("d-thread")
    }

    full =
      F.replacement(base, base.log, "rfull",
        prior_catalogs: prior,
        entries: moved.("rfull"),
        claim: %{cutoffs: Enum.sort_by(r.claim.cutoffs ++ [thread_cut], & &1.replica)}
      )

    kf = F.first(base, full)

    labels =
      Map.merge(base_labels(base, c0), %{
        "R" => r.id,
        "KR" => F.cid(kr),
        "Rf" => full.id,
        "KF" => F.cid(kf)
      })

    one("a replacement's cutoffs must cover every entry of its first catalog", labels, [
      step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
      step(
        ev(add(base.log, [r]), catalogs: [c0, kr]),
        ok(["R"],
          closed: ["B"],
          refusals: %{"KR" => "invalid_catalog_transition"},
          decision: [head: "R"]
        )
      ),
      step(
        ev(add(base.log, [full]), catalogs: [c0, kf]),
        ok(["Rf"], closed: ["B"], decision: accept("Rf", "KF", clears: true))
      )
    ])
  end

  # PR #221 round 5, finding 3 (D-A15): a replacement keeping its parent's service inherits the
  # parent's unproven cutoffs, as a rotation does. R2 keeps R1's service and cites {R1, K1};
  # only R2's own cutoffs are proven, so R2 owes R1's and is recovery_incomplete until R1's are
  # proven too.
  defp same_service_inherits(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "dsi-r1")
    k1 = F.first(base, r1)
    l1 = add(base.log, [r1])

    r2 =
      F.replacement(base, l1, "dsi-r2",
        parents: [r1.id],
        prior_catalogs: [%{binding: r1.id, catalog: F.cid(k1)}],
        generation: 2,
        service_id: r1.service_id,
        service_key: r1.service_key,
        entries: r1.entries
      )

    k2 = F.first(base, r2)
    l2 = add(l1, [r2])

    labels =
      Map.merge(base_labels(base, c0), %{
        "R1" => r1.id,
        "K1" => F.cid(k1),
        "R2" => r2.id,
        "K2" => F.cid(k2)
      })

    one("a same-service replacement inherits its parent's unproven cutoffs (D-A15)", labels, [
      step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
      step(
        ev(l2, catalogs: [c0, k1, k2], unproven: [r1.id]),
        ok(["R2"],
          closed: ["B", "R1"],
          pending: ["R1", "R2"],
          decision: [head: "R2", reason: "recovery_incomplete", block: "recovery_incomplete"]
        )
      ),
      step(
        ev(l2, catalogs: [c0, k1, k2]),
        ok(["R2"], closed: ["B", "R1"], decision: accept("R2", "K2", clears: true))
      )
    ])
  end

  # PR #221 round 5, finding 5 (plan 316 section 4): a catalog whose entry service pair differs
  # from its binding's is wrong_catalog_scope (rank 2) even though its signature, made over the
  # original bytes, no longer verifies (invalid_catalog_signature, rank 4).
  defp scope_before_signature(base) do
    c0 = F.c0(base)
    entries = Enum.map(c0.catalog.entries, &%{&1 | service_id: F.id("ssig-other")})
    bad = put_in(c0, [:catalog, :entries], entries)
    labels = Map.merge(base_labels(base, c0), %{"Cs" => F.cid(bad)})

    one("a catalog's wrong service scope outranks its signature failure", labels, [
      step(
        ev(base.log, catalogs: [bad]),
        ok(["B"], refusals: %{"Cs" => "wrong_catalog_scope"}, decision: [head: "B"])
      )
    ])
  end

  # --- rows 382 and 383: convergence (S1-S14) ------------------------------------------------

  defp nominee(base, t2),
    do: [
      author: base.nominee,
      claim: %{author: base.nominee.pub},
      cap: t2.delegation.id,
      holder_epoch: t2.op.id
    ]

  defp moved(entries, name) do
    sid = F.id("service-id-" <> name)
    key = F.identity("service-" <> name).pub
    for e <- entries, do: %{e | service_id: sid, service_key: key}
  end

  defp route(name), do: "/r/" <> F.id("route-" <> name)

  defp other(base, space, pool, name),
    do: F.pool_thread(base, %{space | route: route(name)}, pool)

  # A replacement whose first catalog carries `entries` (moved to its own service), with a
  # cutoff for every entry (D-A15).
  defp carrying(base, log, name, entries, opts) do
    deps = Keyword.get(opts, :deps, Log.frontier(log))
    {:ok, %{cutoff: space_cut}} = CatalogCutoff.derive(F.prefix(base, log, deps))

    extra =
      for e <- entries,
          e.kind != :space,
          do: %{
            replica: e.replica,
            frontier: [F.id("f-" <> name <> e.replica)],
            log_digest: F.id("d-" <> name <> e.replica)
          }

    claim =
      Map.merge(
        %{cutoffs: Enum.sort_by([space_cut | extra], & &1.replica)},
        Keyword.get(opts, :claim, %{})
      )

    F.replacement(
      base,
      log,
      name,
      opts |> Keyword.put(:entries, moved(entries, name)) |> Keyword.put(:claim, claim)
    )
  end

  defp frozen_at(head, opts),
    do:
      ok(
        [head],
        opts ++
          [
            decision: [
              head: head,
              reason: "authority_changed",
              block: "authority_changed",
              freeze: true
            ],
            after: [frozen: true]
          ]
      )

  # S1 (row 383, PR #221 round 3 finding 4): accepted R1/K1, then a concurrent holder change
  # T2 and an old-key rotation TR under R1. R2 citing {R1, K1} closes TR out; it clears in
  # both delivery orders, and the TR head id is never compared again.
  defp s1_rotation_trigger(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "s1-r1")
    k1 = F.first(base, r1)
    l1 = add(base.log, [r1])
    {tn, t2, l2} = regrant(base, l1, Log.frontier(base.log))
    tr = rotation(base, node(r1.id, 1), k1, r1.catalog_key, "s1-tr")

    r2 =
      F.replacement(
        base,
        l2,
        "s1-r2",
        [parents: [r1.id], prior_catalogs: [%{binding: r1.id, catalog: F.cid(k1)}], generation: 2] ++
          nominee(base, t2)
      )

    k2 = F.first(base, r2)
    l3 = add(l2, [r2])

    labels =
      Map.merge(base_labels(base, c0), %{
        "R1" => r1.id,
        "K1" => F.cid(k1),
        "T2" => tn.id,
        "TR" => tr.id,
        "R2" => r2.id,
        "K2" => F.cid(k2)
      })

    accepted = ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))
    refused_k1 = %{"K1" => "catalog_authority_refused"}

    resolved = fn out, clears ->
      ok(["R2"],
        closed: ["B", "R1"],
        closed_out: out,
        refused: ["R1"],
        refusals: refused_k1,
        decision: accept("R2", "K2", clears: clears)
      )
    end

    both(
      "S1: a rotation beside a holder change freezes, and an admin resolution clears it",
      labels,
      [
        step(ev(l1, catalogs: [c0, k1]), accepted),
        step(
          ev(l2, rotations: [tr], catalogs: [c0, k1]),
          frozen_at("TR",
            closed: ["B"],
            nodes: ["B", "R1", "TR"],
            refused: ["R1", "TR"],
            refusals: Map.put(refused_k1, "TR", "catalog_authority_refused")
          )
        ),
        step(ev(l3, rotations: [tr], catalogs: [c0, k1, k2]), resolved.(["TR"], true))
      ],
      [
        step(ev(l1, catalogs: [c0, k1]), accepted),
        step(ev(l3, catalogs: [c0, k1, k2]), resolved.([], true)),
        step(ev(l3, rotations: [tr], catalogs: [c0, k1, k2]), resolved.(["TR"], false))
      ]
    )
  end

  # S2: the resolution's first catalog is withheld, so the client stays frozen; a later R3
  # descending from it clears.
  defp s2_withheld_first(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "s2-r1")
    k1 = F.first(base, r1)
    l1 = add(base.log, [r1])
    {tn, t2, l2} = regrant(base, l1, Log.frontier(base.log))

    r2 =
      F.replacement(
        base,
        l2,
        "s2-r2",
        [parents: [r1.id], prior_catalogs: [%{binding: r1.id, catalog: F.cid(k1)}], generation: 2] ++
          nominee(base, t2)
      )

    l3 = add(l2, [r2])

    r3 =
      F.replacement(
        base,
        l3,
        "s2-r3",
        [parents: [r2.id], prior_catalogs: [%{binding: r2.id, catalog: nil}], generation: 3] ++
          nominee(base, t2)
      )

    k3 = F.first(base, r3)

    labels =
      Map.merge(base_labels(base, c0), %{
        "R1" => r1.id,
        "K1" => F.cid(k1),
        "T2" => tn.id,
        "R2" => r2.id,
        "R3" => r3.id,
        "K3" => F.cid(k3)
      })

    refused = [refused: ["R1"], refusals: %{"K1" => "catalog_authority_refused"}]

    one("S2: a withheld resolution catalog stays frozen until a descendant clears", labels, [
      step(ev(l1, catalogs: [c0, k1]), ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))),
      step(ev(add(l1, [tn]), catalogs: [c0, k1]), frozen_at("R1", [closed: ["B"]] ++ refused)),
      step(ev(l3, catalogs: [c0, k1]), frozen_at("R2", [closed: ["B", "R1"]] ++ refused)),
      step(
        ev(add(l3, [r3]), catalogs: [c0, k1, k3]),
        ok(
          ["R3"],
          [closed: ["B", "R1", "R2"], decision: accept("R3", "K3", clears: true)] ++ refused
        )
      )
    ])
  end

  # S3 (row 382 item 2, PR #221 round 3 finding 3): KR is refused for missing Thread cutoffs.
  # R2 citing {R, nil} must still carry C0's Thread (Floor(R2) = entries(C0)): a Space-only K2
  # is refused, a K2f carrying the Thread promotes.
  defp s3_nil_floor(base) do
    [space] = F.base_entries(base)
    thread = thread_of(base, space, "s3")
    c0 = F.catalog(base, base.boot.id, 0, nil, base.catalog, [space, thread])

    r =
      F.replacement(base, base.log, "s3-r",
        prior_catalogs: [%{binding: base.boot.id, catalog: F.cid(c0)}],
        entries: moved([space, thread], "s3-r")
      )

    kr = F.first(base, r)
    lr = add(base.log, [r])
    child = [parents: [r.id], prior_catalogs: [%{binding: r.id, catalog: nil}], generation: 2]
    r2 = F.replacement(base, lr, "s3-r2", child)
    k2 = F.first(base, r2)
    r2f = carrying(base, lr, "s3-r2f", [space, thread], child)
    k2f = F.first(base, r2f)

    labels =
      Map.merge(base_labels(base, c0), %{
        "R" => r.id,
        "KR" => F.cid(kr),
        "R2" => r2.id,
        "K2" => F.cid(k2),
        "R2f" => r2f.id,
        "K2f" => F.cid(k2f)
      })

    start = step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0")))

    [
      one("S3: a nil citation of a node without a valid catalog carries its floor", labels, [
        start,
        step(
          ev(add(lr, [r2]), catalogs: [c0, kr, k2]),
          ok(["R2"],
            closed: ["B", "R"],
            closed_out: ["KR"],
            refusals: %{"K2" => "invalid_catalog_transition"},
            decision: [head: "R2"]
          )
        )
      ]),
      one("S3: a second replacement carrying the floor's Thread promotes", labels, [
        start,
        step(
          ev(add(lr, [r2f]), catalogs: [c0, kr, k2f]),
          ok(["R2f"],
            closed: ["B", "R"],
            closed_out: ["KR"],
            decision: accept("R2f", "K2f", clears: true)
          )
        )
      ])
    ]
  end

  # S4 (row 382 item 1, PR #221 round 3 finding 7): C0 maps Space->a, Thread->b; C1 extends it
  # with Space->b, Thread->c. C1 is intrinsically invalid in any id order, and R citing it is
  # raw evidence (OD-17), so B/C0 is kept and served.
  defp s4_route_reuse(base) do
    [space] = F.base_entries(base)
    thread = other(base, space, "thread", "s4-b")

    c0 =
      F.catalog(base, base.boot.id, 0, nil, base.catalog, [
        %{space | route: route("s4-a")},
        thread
      ])

    c1 =
      F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, [
        %{space | route: route("s4-b")},
        %{thread | route: route("s4-c")}
      ])

    r =
      carrying(
        base,
        base.log,
        "s4-r",
        [%{space | route: route("s4-r-space")}, %{thread | route: route("s4-r-thread")}],
        prior_catalogs: [%{binding: base.boot.id, catalog: F.cid(c1)}]
      )

    kr = F.first(base, r)
    lr = add(base.log, [r])

    labels =
      Map.merge(base_labels(base, c0), %{"C1" => F.cid(c1), "R" => r.id, "KR" => F.cid(kr)})

    kept =
      ok(["B"],
        raw: %{"R" => "invalid_catalog_transition"},
        refusals: %{"C1" => "invalid_catalog_transition", "KR" => "invalid_catalog_transition"},
        decision: accept("B", "C0")
      )

    both(
      "S4: a route-reusing catalog is invalid in any order and validates no replacement",
      labels,
      [
        step(
          ev(base.log, catalogs: [c0, c1]),
          ok(["B"],
            refusals: %{"C1" => "invalid_catalog_transition"},
            decision: accept("B", "C0")
          )
        ),
        step(ev(lr, catalogs: [c0, c1, kr]), kept)
      ],
      [step(ev(lr, catalogs: [c0, c1, kr]), kept)]
    )
  end

  # S6 (row 382 item 3, PR #221 round 3 finding 6): three rotations naming an intrinsically
  # invalid prior catalog are three retained refusals, not heads.
  defp s6_invalid_prior_rotations(base) do
    c0 = F.c0(base)
    cbad = F.catalog(base, base.boot.id, 2, F.cid(c0), base.catalog, F.base_entries(base))

    ts =
      for n <- ~w(1 2 3),
          do: rotation(base, node(base.boot.id, 0), cbad, base.catalog, "s6-t" <> n)

    labels =
      ts
      |> Enum.with_index(1)
      |> Map.new(fn {t, i} -> {"T#{i}", t.id} end)
      |> Map.merge(base_labels(base, c0))
      |> Map.put("Cbad", F.cid(cbad))

    bad = "invalid_catalog_transition"

    one("S6: rotations naming an invalid prior catalog are refusals, not heads", labels, [
      step(
        ev(base.log, rotations: ts, catalogs: [c0, cbad]),
        ok(["B"],
          refusals: %{"Cbad" => bad, "T1" => bad, "T2" => bad, "T3" => bad},
          decision: accept("B", "C0")
        )
      )
    ])
  end

  # S7 (D-573, row 383): the accepted bootstrap catalog absent from one delivery is a derived
  # block that does not freeze; the next complete delivery serves B/C0 again.
  defp s7_missing_clears(base) do
    c0 = F.c0(base)

    one(
      "S7: a missing accepted catalog serves nothing and does not freeze",
      base_labels(base, c0),
      [
        step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
        step(
          ev(base.log),
          ok(["B"],
            decision: [head: "B", reason: "authority_changed", block: "authority_changed"]
          )
        ),
        step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0")))
      ]
    )
  end

  # S8: a watermark under a closed-out rotation chain at generation 4 (T, T1, T2 from R1). R2
  # closing R1 freezes, whether it cites {R1, K1} or {R1, nil}; R3 descending from R2 and
  # carrying KT2's entries clears.
  defp s8_closed_out_rotation_watermark(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "s8-r1")
    k1 = F.first(base, r1)
    l1 = add(base.log, [r1])
    t = rotation(base, node(r1.id, 1), k1, r1.catalog_key, "s8-t")
    kt = F.catalog(base, t.id, 0, nil, F.identity("rot-s8-t"), r1.entries)
    ta = rotation(base, node(t.id, 2), kt, F.identity("rot-s8-t"), "s8-ta")
    kta = F.catalog(base, ta.id, 0, nil, F.identity("rot-s8-ta"), r1.entries)
    tb = rotation(base, node(ta.id, 3), kta, F.identity("rot-s8-ta"), "s8-tb")
    ktb = F.catalog(base, tb.id, 0, nil, F.identity("rot-s8-tb"), r1.entries)
    rots = [t, ta, tb]
    cats = [c0, k1, kt, kta, ktb]

    for {variant, prior} <- [{"cite", F.cid(k1)}, {"nil", nil}] do
      r2 =
        F.replacement(base, l1, "s8-r2-" <> variant,
          parents: [r1.id],
          prior_catalogs: [%{binding: r1.id, catalog: prior}],
          generation: 2
        )

      k2 = F.first(base, r2)
      l2 = add(l1, [r2])

      r3 =
        F.replacement(base, l2, "s8-r3-" <> variant,
          parents: [r2.id],
          prior_catalogs: [%{binding: r2.id, catalog: F.cid(k2)}],
          generation: 3
        )

      k3 = F.first(base, r3)

      labels =
        Map.merge(base_labels(base, c0), %{
          "R1" => r1.id,
          "K1" => F.cid(k1),
          "T" => t.id,
          "KT" => F.cid(kt),
          "Ta" => ta.id,
          "KTa" => F.cid(kta),
          "Tb" => tb.id,
          "KTb" => F.cid(ktb),
          "R2" => r2.id,
          "K2" => F.cid(k2),
          "R3" => r3.id,
          "K3" => F.cid(k3)
        })

      out =
        ["KT", "KTa", "KTb", "T", "Ta", "Tb"] ++ if(variant == "nil", do: ["K1"], else: [])

      one("S8: a closed-out rotation watermark freezes and clears (#{variant})", labels, [
        step(ev(l1, catalogs: [c0, k1]), ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))),
        step(
          ev(l1, rotations: [t], catalogs: [c0, k1, kt]),
          ok(["T"], closed: ["B"], nodes: ["B", "R1", "T"], decision: accept("T", "KT"))
        ),
        step(
          ev(l1, rotations: [t, ta], catalogs: [c0, k1, kt, kta]),
          ok(["Ta"], closed: ["B"], nodes: ["B", "R1", "T", "Ta"], decision: accept("Ta", "KTa"))
        ),
        step(
          ev(l1, rotations: rots, catalogs: cats),
          ok(["Tb"],
            closed: ["B"],
            nodes: ["B", "R1", "T", "Ta", "Tb"],
            decision: accept("Tb", "KTb")
          )
        ),
        step(
          ev(l2, rotations: rots, catalogs: cats ++ [k2]),
          frozen_at("R2", closed: ["B", "R1"], closed_out: out)
        ),
        step(
          ev(add(l2, [r3]), rotations: rots, catalogs: cats ++ [k2, k3]),
          ok(["R3"],
            closed: ["B", "R1", "R2"],
            closed_out: out,
            decision: accept("R3", "K3", clears: true)
          )
        )
      ])
    end
  end

  # S9: A = B/C1 (C1 adds a Thread). R citing {B, C0} closes C1 out and freezes; its child R2
  # without the Thread stays frozen, R2t carrying the Thread clears.
  defp s9_inventory_continuity(base) do
    [space] = F.base_entries(base)
    thread = thread_of(base, space, "s9")
    c0 = F.c0(base)
    c1 = F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, [space, thread])
    r = cite_c0(base, c0, "s9-r")
    kr = F.first(base, r)
    lr = add(base.log, [r])

    child = [
      parents: [r.id],
      prior_catalogs: [%{binding: r.id, catalog: F.cid(kr)}],
      generation: 2
    ]

    r2 = F.replacement(base, lr, "s9-r2", child)
    k2 = F.first(base, r2)
    r2t = carrying(base, lr, "s9-r2t", [space, thread], child)
    k2t = F.first(base, r2t)

    labels =
      Map.merge(base_labels(base, c0), %{
        "C1" => F.cid(c1),
        "R" => r.id,
        "KR" => F.cid(kr),
        "R2" => r2.id,
        "K2" => F.cid(k2),
        "R2t" => r2t.id,
        "K2t" => F.cid(k2t)
      })

    prefix = [
      step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
      step(ev(base.log, catalogs: [c0, c1]), ok(["B"], decision: accept("B", "C1"))),
      step(ev(lr, catalogs: [c0, c1, kr]), frozen_at("R", closed: ["B"], closed_out: ["C1"]))
    ]

    [
      one(
        "S9: a resolution dropping the watermark's Thread stays frozen",
        labels,
        prefix ++
          [
            step(
              ev(add(lr, [r2]), catalogs: [c0, c1, kr, k2]),
              frozen_at("R2", closed: ["B", "R"], closed_out: ["C1"])
            )
          ]
      ),
      one(
        "S9: a resolution carrying the watermark's Thread clears",
        labels,
        prefix ++
          [
            step(
              ev(add(lr, [r2t]), catalogs: [c0, c1, kr, k2t]),
              ok(["R2t"],
                closed: ["B", "R"],
                closed_out: ["C1"],
                decision: accept("R2t", "K2t", clears: true)
              )
            )
          ]
      )
    ]
  end

  # S10 (C1): A = B/C1. A B-key rotation T from C0 beside C1 is a rotation fork (serving
  # nil); R* citing [T, B] with {T, CT} and {B, C1} clears. A rotation from C1 is a planned
  # rotation and is served.
  defp s10_rotation_fork(base) do
    c0 = F.c0(base)
    c1 = F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, F.base_entries(base))
    t = rotation(base, node(base.boot.id, 0), c0, base.catalog, "s10-t")
    ct = F.catalog(base, t.id, 0, nil, F.identity("rot-s10-t"), F.base_entries(base))
    tp = rotation(base, node(base.boot.id, 0), c1, base.catalog, "s10-tp")
    ctp = F.catalog(base, tp.id, 0, nil, F.identity("rot-s10-tp"), F.base_entries(base))

    rs =
      F.replacement(base, base.log, "s10-rs",
        parents: Enum.sort([t.id, base.boot.id]),
        prior_catalogs:
          Enum.sort([
            %{binding: t.id, catalog: F.cid(ct)},
            %{binding: base.boot.id, catalog: F.cid(c1)}
          ]),
        generation: 2
      )

    krs = F.first(base, rs)

    labels =
      Map.merge(base_labels(base, c0), %{
        "C1" => F.cid(c1),
        "T" => t.id,
        "CT" => F.cid(ct),
        "Tp" => tp.id,
        "CTp" => F.cid(ctp),
        "Rs" => rs.id,
        "KRs" => F.cid(krs)
      })

    prefix = [
      step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
      step(ev(base.log, catalogs: [c0, c1]), ok(["B"], decision: accept("B", "C1")))
    ]

    [
      one(
        "S10: a rotation from an ancestor catalog forks until a resolution cites both",
        labels,
        prefix ++
          [
            step(
              ev(base.log, rotations: [t], catalogs: [c0, c1, ct]),
              ok(["T"],
                nodes: ["B", "T"],
                forks: ["rotation"],
                decision: [reason: "catalog_fork", block: "catalog_fork"]
              )
            ),
            step(
              ev(add(base.log, [rs]), rotations: [t], catalogs: [c0, c1, ct, krs]),
              ok(["Rs"], closed: ["B", "T"], decision: accept("Rs", "KRs", clears: true))
            )
          ]
      ),
      one(
        "S10: a rotation from the current catalog is a planned rotation",
        labels,
        prefix ++
          [
            step(
              ev(base.log, rotations: [tp], catalogs: [c0, c1, ctp]),
              ok(["Tp"], nodes: ["B", "Tp"], decision: accept("Tp", "CTp"))
            )
          ]
      )
    ]
  end

  # S11 (C4): three old-key rotations under the accepted R1 are control_history_limit (no
  # freeze, nothing served); a resolution citing {R1, K1} closes them out and clears, with R1
  # union-refused or honored.
  defp s11_head_limit(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "s11-r1")
    k1 = F.first(base, r1)
    l1 = add(base.log, [r1])
    {tn, t2, l2} = regrant(base, l1, Log.frontier(base.log))

    trs =
      for n <- ~w(a b c), do: rotation(base, node(r1.id, 1), k1, r1.catalog_key, "s11-tr" <> n)

    cite = [
      parents: [r1.id],
      prior_catalogs: [%{binding: r1.id, catalog: F.cid(k1)}],
      generation: 2
    ]

    r2 = F.replacement(base, l2, "s11-r2", cite ++ nominee(base, t2))
    k2 = F.first(base, r2)
    r2h = F.replacement(base, l1, "s11-r2h", cite)
    k2h = F.first(base, r2h)

    labels =
      trs
      |> Enum.zip(~w(TRa TRb TRc))
      |> Map.new(fn {t, l} -> {l, t.id} end)
      |> Map.merge(base_labels(base, c0))
      |> Map.merge(%{
        "R1" => r1.id,
        "K1" => F.cid(k1),
        "T2" => tn.id,
        "R2" => r2.id,
        "K2" => F.cid(k2),
        "R2h" => r2h.id,
        "K2h" => F.cid(k2h)
      })

    accepted =
      step(ev(l1, catalogs: [c0, k1]), ok(["R1"], closed: ["B"], decision: accept("R1", "K1")))

    out = ~w(TRa TRb TRc)

    [
      one(
        "S11: three rotation heads under a refused watermark are resolved by one citation",
        labels,
        [
          accepted,
          step(ev(l2, rotations: trs, catalogs: [c0, k1]), err("control_history_limit")),
          step(
            ev(add(l2, [r2]), rotations: trs, catalogs: [c0, k1, k2]),
            ok(["R2"],
              closed: ["B", "R1"],
              closed_out: out,
              refused: ["R1"],
              refusals: %{"K1" => "catalog_authority_refused"},
              decision: accept("R2", "K2", clears: true)
            )
          )
        ]
      ),
      one(
        "S11: three rotation heads under an honored watermark are resolved by one citation",
        labels,
        [
          accepted,
          step(ev(l1, rotations: trs, catalogs: [c0, k1]), err("control_history_limit")),
          step(
            ev(add(l1, [r2h]), rotations: trs, catalogs: [c0, k1, k2h]),
            ok(["R2h"],
              closed: ["B", "R1"],
              closed_out: out,
              decision: accept("R2h", "K2h", clears: true)
            )
          )
        ]
      )
    ]
  end

  # S12 (C5): A = B/C1 after C0 served Thread at route b and C1 moved it to b2. R citing
  # {B, nil} freezes. A descendant K2 mapping b to another replica is not accepted
  # (RouteCompat against every route ever served), while fresh routes clear.
  defp s12_cumulative_routes(base) do
    [space] = F.base_entries(base)
    thread = other(base, space, "thread", "s12-b")
    c0 = F.catalog(base, base.boot.id, 0, nil, base.catalog, [space, thread])

    c1 =
      F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, [
        space,
        %{thread | route: route("s12-b2")}
      ])

    r = F.replacement(base, base.log, "s12-r")
    kr = F.first(base, r)
    lr = add(base.log, [r])

    child = [
      parents: [r.id],
      prior_catalogs: [%{binding: r.id, catalog: F.cid(kr)}],
      generation: 2
    ]

    fresh = fn name ->
      [%{space | route: route(name <> "-space")}, %{thread | route: route(name <> "-thread")}]
    end

    squat = %{other(base, space, "thread2", "unused") | route: thread.route}
    r2 = carrying(base, lr, "s12-r2", fresh.("s12-r2") ++ [squat], child)
    k2 = F.first(base, r2)
    r2f = carrying(base, lr, "s12-r2f", fresh.("s12-r2f"), child)
    k2f = F.first(base, r2f)

    labels =
      Map.merge(base_labels(base, c0), %{
        "C1" => F.cid(c1),
        "R" => r.id,
        "KR" => F.cid(kr),
        "R2" => r2.id,
        "K2" => F.cid(k2),
        "R2f" => r2f.id,
        "K2f" => F.cid(k2f)
      })

    out = ["C0", "C1"]

    prefix = [
      step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
      step(ev(base.log, catalogs: [c0, c1]), ok(["B"], decision: accept("B", "C1"))),
      step(ev(lr, catalogs: [c0, c1, kr]), frozen_at("R", closed: ["B"], closed_out: out))
    ]

    [
      one(
        "S12: a route served earlier is never re-pointed",
        labels,
        prefix ++
          [
            step(
              ev(add(lr, [r2]), catalogs: [c0, c1, kr, k2]),
              frozen_at("R2", closed: ["B", "R"], closed_out: out)
            )
          ]
      ),
      one(
        "S12: a resolution with fresh routes clears",
        labels,
        prefix ++
          [
            step(
              ev(add(lr, [r2f]), catalogs: [c0, c1, kr, k2f]),
              ok(["R2f"],
                closed: ["B", "R"],
                closed_out: out,
                decision: accept("R2f", "K2f", clears: true)
              )
            )
          ]
      )
    ]
  end

  # S13 (C9): the accepted K1 missing from one delivery is a derived block (nothing served,
  # no freeze); the next complete delivery serves R1/K1 again without a resolution.
  defp s13_missing_watermark(base) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, "s13-r1")
    k1 = F.first(base, r1)
    l1 = add(base.log, [r1])
    labels = Map.merge(base_labels(base, c0), %{"R1" => r1.id, "K1" => F.cid(k1)})
    accepted = ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))

    one("S13: a missing watermark catalog is a derived block that does not freeze", labels, [
      step(ev(l1, catalogs: [c0, k1]), accepted),
      step(
        ev(l1, catalogs: [c0]),
        ok(["R1"],
          closed: ["B"],
          decision: [head: "R1", reason: "authority_changed", block: "authority_changed"]
        )
      ),
      step(ev(l1, catalogs: [c0, k1]), accepted)
    ])
  end

  # S14 (C7, the D-275 trade): a B-key C1 delivered in the same page as R {B, C0} is dropped;
  # delivered before R and accepted, it freezes the client. Both outcomes are intended.
  defp s14_same_page_trade(base) do
    [space] = F.base_entries(base)
    c0 = F.c0(base)

    c1 =
      F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, [
        space,
        thread_of(base, space, "s14")
      ])

    r = cite_c0(base, c0, "s14-r")
    kr = F.first(base, r)
    lr = add(base.log, [r])

    labels =
      Map.merge(base_labels(base, c0), %{"C1" => F.cid(c1), "R" => r.id, "KR" => F.cid(kr)})

    start = step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0")))

    [
      one("S14: a catalog delivered with the closing resolution is dropped", labels, [
        start,
        step(
          ev(lr, catalogs: [c0, c1, kr]),
          ok(["R"], closed: ["B"], closed_out: ["C1"], decision: accept("R", "KR", clears: true))
        )
      ]),
      one("S14: a catalog accepted before the closing resolution freezes", labels, [
        start,
        step(ev(base.log, catalogs: [c0, c1]), ok(["B"], decision: accept("B", "C1"))),
        step(ev(lr, catalogs: [c0, c1, kr]), frozen_at("R", closed: ["B"], closed_out: ["C1"]))
      ])
    ]
  end

  # S15 (PR #221 round 5, finding 8): Seen alone. A = B/C1. R cites {B, C0} and its KR carries
  # C1's entries, so Carry and RouteCompat hold, but R has not seen C1 (it closes it out), so
  # the client freezes. R2 citing {R, KR} strictly descends from that closer and clears.
  defp s15_seen_only(base) do
    [space] = F.base_entries(base)
    c0 = F.c0(base)
    thread = thread_of(base, space, "s15")
    c1 = F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, [space, thread])

    r =
      carrying(base, base.log, "s15-r", [space, thread],
        prior_catalogs: [%{binding: base.boot.id, catalog: F.cid(c0)}]
      )

    kr = F.first(base, r)
    lr = add(base.log, [r])

    r2 =
      carrying(base, lr, "s15-r2", [space, thread],
        parents: [r.id],
        prior_catalogs: [%{binding: r.id, catalog: F.cid(kr)}],
        generation: 2
      )

    k2 = F.first(base, r2)
    l2 = add(lr, [r2])

    labels =
      Map.merge(base_labels(base, c0), %{
        "C1" => F.cid(c1),
        "R" => r.id,
        "KR" => F.cid(kr),
        "R2" => r2.id,
        "K2" => F.cid(k2)
      })

    one("S15: a resolution carrying the watermark's entries without seeing it freezes", labels, [
      step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
      step(ev(base.log, catalogs: [c0, c1]), ok(["B"], decision: accept("B", "C1"))),
      step(ev(lr, catalogs: [c0, c1, kr]), frozen_at("R", closed: ["B"], closed_out: ["C1"])),
      step(
        ev(l2, catalogs: [c0, c1, kr, k2]),
        ok(["R2"],
          closed: ["B", "R"],
          closed_out: ["C1"],
          decision: accept("R2", "K2", clears: true)
        )
      )
    ])
  end

  # --- row 386: a trust_pending step carries the complete part's freeze bit ---------------

  # An authenticated op whose dependency is never delivered (a random hash): its closure stays
  # incomplete, so it is a missing page that never completes.
  defp orphan(base, name), do: F.beacon(base, [F.id("orphan-dep-" <> name)], 9)

  # A keyless catalog whose `binding` no held artifact names (`:binding_pending`).
  defp unknown_binding(base, name),
    do:
      F.catalog(
        base,
        F.id("unknown-binding-" <> name),
        0,
        nil,
        F.identity("unknown-signer-" <> name),
        F.base_entries(base, name)
      )

  defp loose(log, ops),
    do:
      Log.from_ops(log.replica, Map.merge(Log.ops(log), Map.new(ops, &{op_of(&1).id, op_of(&1)})))

  # The C13 fixtures: R1 cites {B, C0}; T2 is a concurrent holder change refusing R1; R2 is
  # the nominee's resolution citing {R1, K1}.
  defp c13_fixtures(base, name) do
    c0 = F.c0(base)
    r1 = cite_c0(base, c0, name <> "-r1")
    k1 = F.first(base, r1)
    l1 = add(base.log, [r1])
    {tn, t2, l2} = regrant(base, l1, Log.frontier(base.log))

    r2 =
      F.replacement(
        base,
        l2,
        name <> "-r2",
        [parents: [r1.id], prior_catalogs: [%{binding: r1.id, catalog: F.cid(k1)}], generation: 2] ++
          nominee(base, t2)
      )

    k2 = F.first(base, r2)

    %{
      c0: c0,
      r1: r1,
      k1: k1,
      l1: l1,
      tn: tn,
      t2: t2,
      l2: l2,
      r2: r2,
      k2: k2,
      l3: add(l2, [r2]),
      labels:
        Map.merge(base_labels(base, c0), %{
          "R1" => r1.id,
          "K1" => F.cid(k1),
          "T2" => tn.id,
          "R2" => r2.id,
          "K2" => F.cid(k2)
        })
    }
  end

  # S16a / S16e / S16h (row 386 repro 1): a withheld page beside a holder change.
  defp s16_pending_freeze(base) do
    x = c13_fixtures(base, "s16")
    o = orphan(base, "s16")
    u = unknown_binding(base, "s16")
    labels = Map.merge(x.labels, %{"O" => o.id, "U" => F.cid(u)})
    cats = [x.c0, x.k1]
    resolved_cats = [x.c0, x.k1, x.k2]
    accepted = ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))
    refused_k1 = %{"K1" => "catalog_authority_refused"}

    resolved = fn clears ->
      ok(["R2"],
        closed: ["B", "R1"],
        refused: ["R1"],
        refusals: refused_k1,
        decision: accept("R2", "K2", clears: clears)
      )
    end

    frozen = frozen_at("R1", closed: ["B"], refused: ["R1"], refusals: refused_k1)

    [
      one("S16a: a withheld page beside a holder change freezes and serves nothing", labels, [
        step(ev(x.l1, catalogs: cats), accepted),
        step(ev(loose(x.l2, [o]), catalogs: cats), err("trust_pending", freeze: true)),
        step(ev(x.l3, catalogs: resolved_cats), resolved.(true))
      ]),
      one("S16a: a withheld page after a holder change keeps the freeze (sequential)", labels, [
        step(ev(x.l1, catalogs: cats), accepted),
        step(ev(x.l2, catalogs: cats), frozen),
        step(ev(loose(x.l2, [o]), catalogs: cats), err("trust_pending", freeze: true)),
        step(ev(x.l3, catalogs: resolved_cats), resolved.(true))
      ]),
      # S16e: the complete part holds the clearing R2/K2, so the bit is false, but a pending
      # page never lifts a freeze; the clear applies once the pending set empties.
      one("S16e: a pending page never lifts a freeze", labels, [
        step(ev(x.l1, catalogs: cats), accepted),
        step(ev(x.l2, catalogs: cats), frozen),
        step(ev(loose(x.l3, [o]), catalogs: resolved_cats), err("trust_pending", frozen: true)),
        step(ev(x.l3, catalogs: resolved_cats), resolved.(true))
      ]),
      # S16h (C1): a clearing resolution beside an unresolvable page (an orphan op and a keyless
      # catalog with an unknown binding) does not freeze, and nothing is served under the
      # refused R1; evicting the page (the 4c simulation) accepts R2/K2.
      one("S16h: a clearing resolution beside an unresolvable page does not freeze", labels, [
        step(ev(x.l1, catalogs: cats), accepted),
        step(ev(loose(x.l3, [o]), catalogs: [u | resolved_cats]), err("trust_pending")),
        step(ev(x.l3, catalogs: resolved_cats), resolved.(true))
      ])
    ]
  end

  # S16b (row 386 repro 2): T2 plus an old-key rotation TR under the refused R1 whose prior
  # catalog is withheld (never published). The complete part refuses R1 with no clearing head,
  # so the pending step freezes; R2 citing {R1, K1} closes TR out and clears.
  defp s16b_withheld_prior(base) do
    x = c13_fixtures(base, "s16b")
    k1n = F.catalog(base, x.r1.id, 1, F.cid(x.k1), x.r1.catalog_key, x.k1.catalog.entries)
    tr = rotation(base, node(x.r1.id, 1), k1n, x.r1.catalog_key, "s16b-tr")
    labels = Map.merge(x.labels, %{"TR" => tr.id, "K1n" => F.cid(k1n)})
    cats = [x.c0, x.k1]

    one("S16b: a withheld prior under a refused binding freezes", labels, [
      step(ev(x.l1, catalogs: cats), ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))),
      step(ev(x.l2, rotations: [tr], catalogs: cats), err("trust_pending", freeze: true)),
      step(
        ev(x.l3, rotations: [tr], catalogs: [x.k2 | cats]),
        ok(["R2"],
          closed: ["B", "R1"],
          closed_out: ["TR"],
          refused: ["R1"],
          refusals: %{"K1" => "catalog_authority_refused"},
          decision: accept("R2", "K2", clears: true)
        )
      )
    ])
  end

  # S16c: pending evidence alone neither freezes nor stops serving.
  defp s16c_pending_alone(base) do
    c0 = F.c0(base)
    o = orphan(base, "s16c")
    labels = Map.put(base_labels(base, c0), "O", o.id)

    one("S16c: pending evidence alone neither freezes nor stops serving", labels, [
      step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
      step(ev(loose(base.log, [o]), catalogs: [c0]), err("trust_pending", serving: "C0")),
      step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0")))
    ])
  end

  # S16d: an honored replacement R citing {B, C0} closes the watermark binding B but its first
  # catalog is not yet held (D-600: closed but not changed). Beside a withheld page nothing is served and
  # nothing freezes.
  defp s16d_closing_beside_pending(base) do
    c0 = F.c0(base)
    r = cite_c0(base, c0, "s16d-r")
    kr = F.first(base, r)
    o = orphan(base, "s16d")
    lr = add(base.log, [r])
    labels = Map.merge(base_labels(base, c0), %{"R" => r.id, "KR" => F.cid(kr), "O" => o.id})

    one(
      "S16d: a withheld page beside an honored closing replacement serves nothing without freezing",
      labels,
      [
        step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
        step(ev(loose(lr, [o]), catalogs: [c0]), err("trust_pending")),
        step(
          ev(lr, catalogs: [c0, kr]),
          ok(["R"], closed: ["B"], decision: accept("R", "KR", clears: true))
        )
      ]
    )
  end

  # S16i (C6, row 386 repro 3): the watermark K1 is revision 1; T2 arrives while K1's revision-0
  # previous is withheld. R1 is refused (abs) and K1's chain is pending (acs `:missing`): the
  # refused binding freezes even though its catalog cannot be judged.
  defp s16i_refused_pending_chain(base) do
    x = c13_fixtures(base, "s16i")
    k1r = F.catalog(base, x.r1.id, 1, F.cid(x.k1), x.r1.catalog_key, x.k1.catalog.entries)
    labels = Map.merge(x.labels, %{"K1r" => F.cid(k1r)})

    one("S16i: a refused binding freezes even while its catalog's chain is withheld", labels, [
      step(
        ev(x.l1, catalogs: [x.c0, x.k1, k1r]),
        ok(["R1"], closed: ["B"], decision: accept("R1", "K1r"))
      ),
      step(
        ev(x.l2, catalogs: [x.c0, k1r]),
        ok(["R1"],
          closed: ["B"],
          refused: ["R1"],
          refusals: %{"K1r" => "catalog_authority_refused"},
          decision: [
            head: "R1",
            reason: "authority_changed",
            block: "authority_changed",
            freeze: true
          ],
          after: [frozen: true]
        )
      )
    ])
  end

  # --- row 387: a route-conflicting floor reserves the route to none -----------------------

  defp fresh(entries, name),
    do:
      entries
      |> Enum.map(&%{&1 | route: route(name <> "-" <> &1.replica)})
      |> Enum.sort_by(& &1.replica)

  # S17a / S17c: C0 lists Space; revision-1 siblings Ca (+Thread A at X) and Cb (+Thread B at X)
  # fork under B. R citing both with Space/A/B on fresh routes promotes (HEAD: KR refused). R'
  # keeping A at X is refused in both runtimes (the reservation). R3 citing {R, nil} with a
  # first catalog on X is refused: the reservation survives a nil citation.
  defp s17_reserved_routes(base) do
    c0 = F.c0(base)
    [space] = c0.catalog.entries
    ta = other(base, space, "s17a", "s17-x")
    tb = other(base, space, "s17b", "s17-x")
    ca = F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, [space, ta])
    cb = F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, [space, tb])

    priors = [
      %{binding: base.boot.id, catalog: F.cid(ca)},
      %{binding: base.boot.id, catalog: F.cid(cb)}
    ]

    priors = Enum.sort(priors)
    r = carrying(base, base.log, "s17-r", fresh([space, ta, tb], "s17-r"), prior_catalogs: priors)
    kr = F.first(base, r)
    lr = add(base.log, [r])

    rk =
      carrying(
        base,
        base.log,
        "s17-rk",
        Enum.sort_by(fresh([space, tb], "s17-rk") ++ [ta], & &1.replica),
        prior_catalogs: priors
      )

    krk = F.first(base, rk)

    r3 =
      carrying(
        base,
        lr,
        "s17-r3",
        [space, ta, tb] |> fresh("s17-r3") |> Enum.map(&reroute(&1, ta)),
        parents: [r.id],
        prior_catalogs: [%{binding: r.id, catalog: nil}],
        generation: 2
      )

    k3 = F.first(base, r3)

    labels =
      Map.merge(base_labels(base, c0), %{
        "Ca" => F.cid(ca),
        "Cb" => F.cid(cb),
        "R" => r.id,
        "KR" => F.cid(kr),
        "Rk" => rk.id,
        "KRk" => F.cid(krk),
        "R3" => r3.id,
        "K3" => F.cid(k3)
      })

    split =
      ok(["B"], forks: ["catalog"], decision: [reason: "catalog_fork", block: "catalog_fork"])

    promoted = ok(["R"], closed: ["B"], decision: accept("R", "KR", clears: true))

    [
      one(
        "S17a: route-conflicting siblings reserve the route and a fresh-route resolution promotes",
        labels,
        [
          step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
          step(ev(base.log, catalogs: [c0, ca, cb]), split),
          step(ev(lr, catalogs: [c0, ca, cb, kr]), promoted)
        ]
      ),
      one("S17a: a resolution keeping a reserved route is refused", labels, [
        step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
        step(
          ev(add(base.log, [rk]), catalogs: [c0, ca, cb, krk]),
          ok(["Rk"],
            closed: ["B"],
            refusals: %{"KRk" => "invalid_catalog_transition"},
            decision: [head: "Rk"]
          )
        )
      ]),
      one("S17c: a reservation survives a nil citation", labels, [
        step(
          ev(lr, catalogs: [c0, ca, cb, kr]),
          ok(["R"], closed: ["B"], decision: accept("R", "KR"))
        ),
        step(
          ev(add(lr, [r3]), catalogs: [c0, ca, cb, kr, k3]),
          # The nil citation also closes KR out, so the watermark changed and freezes.
          frozen_at("R3",
            closed: ["B", "R"],
            closed_out: ["KR"],
            refusals: %{"K3" => "invalid_catalog_transition"}
          )
        )
      ])
    ]
  end

  # Thread A of R3 back onto the reserved route X.
  defp reroute(%{replica: replica} = e, %{replica: replica, route: x}), do: %{e | route: x}
  defp reroute(e, _), do: e

  # S17b: after accepted R1/K1 is refused by a concurrent holder change, R1's (revoked) catalog
  # key signs K1a (+Thread at /r/p) and K1b (Space moved to /r/p) on top of K1. R2 citing both
  # with fresh routes promotes and clears; the old key is never an input.
  defp s17b_revoked_conflict(base) do
    x = c13_fixtures(base, "s17b")
    [space] = x.k1.catalog.entries
    p = route("s17b-p")
    th = %{other(base, space, "s17b-t", "s17b-t") | route: p}
    k1a = F.catalog(base, x.r1.id, 1, F.cid(x.k1), x.r1.catalog_key, [space, th])
    k1b = F.catalog(base, x.r1.id, 1, F.cid(x.k1), x.r1.catalog_key, [%{space | route: p}])

    priors =
      Enum.sort([
        %{binding: x.r1.id, catalog: F.cid(k1a)},
        %{binding: x.r1.id, catalog: F.cid(k1b)}
      ])

    r2 =
      carrying(
        base,
        x.l2,
        "s17b-r2",
        fresh([space, th], "s17b-r2"),
        [parents: [x.r1.id], prior_catalogs: priors, generation: 2] ++ nominee(base, x.t2)
      )

    k2 = F.first(base, r2)

    labels =
      Map.merge(x.labels, %{
        "K1a" => F.cid(k1a),
        "K1b" => F.cid(k1b),
        "R2" => r2.id,
        "K2" => F.cid(k2)
      })

    cats = [x.c0, x.k1, k1a, k1b]

    refused = %{
      "K1" => "catalog_authority_refused",
      "K1a" => "catalog_authority_refused",
      "K1b" => "catalog_authority_refused"
    }

    one("S17b: a revoked key's route-conflicting catalogs cannot block recovery", labels, [
      step(
        ev(x.l1, catalogs: [x.c0, x.k1]),
        ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))
      ),
      step(
        ev(x.l2, catalogs: cats),
        frozen_at("R1", closed: ["B"], refused: ["R1"], refusals: refused)
      ),
      step(
        ev(add(x.l2, [r2]), catalogs: [k2 | cats]),
        ok(["R2"],
          closed: ["B", "R1"],
          refused: ["R1"],
          refusals: refused,
          decision: accept("R2", "K2", clears: true)
        )
      )
    ])
  end

  # B1 (PR #221 bot, the old line 1048): a chain-invalid catalog (revision 3 on a revision-0
  # previous) under the union-refused R1 keeps its own `invalid_catalog_transition`.
  defp b1_bad_chain_under_refused(base) do
    x = c13_fixtures(base, "b1")
    kbad = F.catalog(base, x.r1.id, 3, F.cid(x.k1), x.r1.catalog_key, x.k1.catalog.entries)
    labels = Map.put(x.labels, "Kbad", F.cid(kbad))

    one("B1: a chain-invalid catalog under a refused node keeps its own reason", labels, [
      step(
        ev(x.l1, catalogs: [x.c0, x.k1]),
        ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))
      ),
      step(
        ev(x.l2, catalogs: [x.c0, x.k1, kbad]),
        frozen_at("R1",
          closed: ["B"],
          refused: ["R1"],
          refusals: %{"K1" => "catalog_authority_refused", "Kbad" => "invalid_catalog_transition"}
        )
      )
    ])
  end

  # B3 (PR #221 bot, the old line 304): a rotation with both a wrong generation and a bad
  # old-key signature reports the higher-precedence `invalid_catalog_signature`.
  defp b3_rotation_precedence(base) do
    c0 = F.c0(base)

    t =
      F.rotation(
        base,
        node(base.boot.id, 0),
        c0,
        F.identity("b3-not-the-catalog-key"),
        F.identity("rot-b3"),
        "b3",
        generation: 5
      )

    labels = Map.put(base_labels(base, c0), "T", t.id)

    one("B3: rotation failures follow section-4 precedence", labels, [
      step(
        ev(base.log, rotations: [t], catalogs: [c0]),
        ok(["B"], refusals: %{"T" => "invalid_catalog_signature"}, decision: accept("B", "C0"))
      )
    ])
  end

  # F1 (PR #221 round 1, finding 1; OD-17): Stage A judges the bootstrap in R's own prefix. E0
  # (a beacon on B's deps) and T1 (admin, lease 40, after E0) are concurrent with B, so B is
  # `stale_holder` at R's prefix and Core refuses R `application_invalid_catalog` there. The
  # concurrent T0 (nominee, lease 41, after B) wins the union, where B is honored and R is
  # `not_holder`. R is intrinsically invalid: raw evidence that closes nothing (HEAD: a refused
  # node that closed B and served nothing).
  defp f1_stale_bootstrap_prefix(base) do
    alt = F.base(transfer: false, beacons: false)
    {alt.boot.id, alt.record} == {base.boot.id, base.record} or raise "F1 base drifted"
    c0 = F.c0(alt)
    e0 = F.beacon(alt, alt.bootstrap.deps, 0)
    t1 = F.transfer(alt, [e0.id], alt.admin.pub, expires: 40)
    l1 = F.append(alt.log, [e0, t1.op])

    r =
      F.replacement(alt, l1, "f1-r",
        prior_catalogs: [%{binding: alt.boot.id, catalog: F.cid(c0)}],
        cap: t1.delegation.id,
        holder_epoch: t1.op.id
      )

    t0 = F.transfer(alt, [alt.bootstrap.id], alt.nominee.pub, expires: 41)
    l2 = F.append(l1, [r.op, t0.op])
    labels = Map.merge(base_labels(alt, c0), %{"R" => r.id})

    one("F1: a replacement whose bootstrap is stale in its own prefix is raw evidence", labels, [
      step(ev(alt.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
      step(
        ev(l2, catalogs: [c0]),
        ok(["B"], raw: %{"R" => "invalid_catalog_transition"}, decision: accept("B", "C0"))
      )
    ])
  end

  # S17e (PR #221 round 1, finding 5): the mirror of "a resolution keeping a reserved route is
  # refused", keeping the other sibling's replica on X. Between them a first-cited-wins and a
  # last-cited-wins floor join each accept one of the two, whatever the cited priors' sort order.
  defp s17e_first_prior_reserved(base) do
    c0 = F.c0(base)
    [space] = c0.catalog.entries
    ta = other(base, space, "s17a", "s17-x")
    tb = other(base, space, "s17b", "s17-x")
    ca = F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, [space, ta])
    cb = F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, [space, tb])

    priors =
      Enum.sort([
        %{binding: base.boot.id, catalog: F.cid(ca)},
        %{binding: base.boot.id, catalog: F.cid(cb)}
      ])

    rkb =
      carrying(
        base,
        base.log,
        "s17-rkb",
        Enum.sort_by(fresh([space, ta], "s17-rkb") ++ [tb], & &1.replica),
        prior_catalogs: priors
      )

    krkb = F.first(base, rkb)

    labels =
      Map.merge(base_labels(base, c0), %{
        "Ca" => F.cid(ca),
        "Cb" => F.cid(cb),
        "RkB" => rkb.id,
        "KRkB" => F.cid(krkb)
      })

    one("S17e: a resolution keeping the other sibling on a reserved route is refused", labels, [
      step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
      step(
        ev(add(base.log, [rkb]), catalogs: [c0, ca, cb, krkb]),
        ok(["RkB"],
          closed: ["B"],
          refusals: %{"KRkB" => "invalid_catalog_transition"},
          decision: [head: "RkB"]
        )
      )
    ])
  end

  # F2 (PR #221 round 1, finding 2): a valid rotation T of B, C0 under B, CT under T, and a
  # B-key-signed Cx (revision 2) on a withheld `previous`. Cx pends under the open B. R citing
  # {T, CT} closes B too (D-275, ancestor-or-self of its parents), so its post-sign view closes
  # Cx out; the authoring preflight escapes Cx through that closed set (HEAD: only direct
  # parents, so trust_pending).
  defp f2_pending_under_rotated_ancestor(base) do
    c0 = F.c0(base)
    t = rotation(base, node(base.boot.id, 0), c0, base.catalog, "f2-t")
    ct = F.catalog(base, t.id, 0, nil, F.identity("rot-f2-t"), F.base_entries(base))
    cx = F.catalog(base, base.boot.id, 2, F.id("f2-withheld"), base.catalog, F.base_entries(base))

    r =
      F.replacement(base, base.log, "f2-r",
        parents: [t.id],
        prior_catalogs: [%{binding: t.id, catalog: F.cid(ct)}],
        generation: 2
      )

    kr = F.first(base, r)

    labels =
      Map.merge(base_labels(base, c0), %{
        "T" => t.id,
        "CT" => F.cid(ct),
        "Cx" => F.cid(cx),
        "R" => r.id,
        "KR" => F.cid(kr)
      })

    one("F2: a withheld chain under a rotated ancestor is closed out by a resolution", labels, [
      step(ev(base.log, rotations: [t], catalogs: [c0, ct, cx]), err("trust_pending")),
      step(
        ev(add(base.log, [r]), rotations: [t], catalogs: [c0, ct, cx, kr]),
        ok(["R"], closed: ["B", "T"], closed_out: ["Cx"], decision: accept("R", "KR"))
      )
    ])
  end

  # Row 390, repair (c) (the L minimal counterexample): the old bootstrap catalog key signs A1, a
  # revision-0 sibling of C0 whose Space entry names a creation no history holds. A1's entry
  # facts pend, so A1 is chain-pending under the open B (trust_pending, C0 still served), never a
  # valid prior; the honest R citing {B, C0} closes it out and clears (HEAD: no resolution was
  # authorable, citing both was invalid_catalog_transition and citing either was catalog_fork).
  defp r390_contradicting_sibling(base) do
    c0 = F.c0(base)
    [space] = c0.catalog.entries

    a1 =
      F.catalog(base, base.boot.id, 0, nil, base.catalog, [%{space | creation: F.id("r390-c")}])

    r = cite_c0(base, c0, "r390-r")
    kr = F.first(base, r)

    labels =
      Map.merge(base_labels(base, c0), %{"A1" => F.cid(a1), "R" => r.id, "KR" => F.cid(kr)})

    one("R390: a sibling contradicting history is never a valid prior", labels, [
      step(ev(base.log, catalogs: [c0]), ok(["B"], decision: accept("B", "C0"))),
      step(ev(base.log, catalogs: [c0, a1]), err("trust_pending", serving: "C0")),
      step(
        ev(add(base.log, [r]), catalogs: [c0, a1, kr]),
        ok(["R"],
          closed: ["B"],
          closed_out: ["A1"],
          decision: accept("R", "KR", clears: true)
        )
      )
    ])
  end

  # Row 390, the general floor rule (the residual after repair (c)): Ka and Kb are revision-1
  # siblings of C0 that list the pool Thread with its two history-valid creations, so both are
  # valid and they disagree. R cites both and carries Ka's creation, which the per-replica floor
  # admits. A client whose watermark is Ka accepts and clears. A client whose watermark is Kb
  # gets `catalog_rollback`: Covers' Carry keeps that client's listed Thread facts immutable, so
  # no single resolution can clear both clients (row 388, question 9, is the operator's).
  defp r390_history_valid_variants(base) do
    c0 = F.c0(base)
    [space] = c0.catalog.entries
    th = &F.pool_thread(base, %{space | route: route("r390v-t")}, "gen0", creation: &1)
    ka = F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, [space, th.(0)])
    kb = F.catalog(base, base.boot.id, 1, F.cid(c0), base.catalog, [space, th.(1)])

    priors =
      Enum.sort([
        %{binding: base.boot.id, catalog: F.cid(ka)},
        %{binding: base.boot.id, catalog: F.cid(kb)}
      ])

    fresh = [
      %{space | route: route("r390v-rs")},
      %{th.(0) | route: route("r390v-rt")}
    ]

    r = carrying(base, base.log, "r390v-r", fresh, prior_catalogs: priors)
    kr = F.first(base, r)

    labels =
      Map.merge(base_labels(base, c0), %{
        "Ka" => F.cid(ka),
        "Kb" => F.cid(kb),
        "R" => r.id,
        "KR" => F.cid(kr)
      })

    fork =
      ok(["B"], forks: ["catalog"], decision: [reason: "catalog_fork", block: "catalog_fork"])

    all = ev(add(base.log, [r]), catalogs: [c0, ka, kb, kr])
    closed = [closed: ["B"]]

    [
      one("R390: history-valid variants, a client on Ka clears", labels, [
        step(ev(base.log, catalogs: [c0, ka]), ok(["B"], decision: accept("B", "Ka"))),
        step(ev(base.log, catalogs: [c0, ka, kb]), fork),
        step(all, ok(["R"], closed ++ [decision: accept("R", "KR", clears: true)]))
      ]),
      one("R390: history-valid variants, a client on Kb keeps its Thread facts", labels, [
        step(ev(base.log, catalogs: [c0, kb]), ok(["B"], decision: accept("B", "Kb"))),
        step(ev(base.log, catalogs: [c0, ka, kb]), fork),
        step(
          all,
          ok(["R"], closed ++ [decision: [head: "R", reason: "catalog_rollback"]])
        )
      ])
    ]
  end

  @doc """
  F3 (PR #221 round 1, finding 3): `levels` levels of two sibling replacements, the first
  citing {B, C0} and every later one citing both previous siblings with nil catalogs. Returns
  `{log, c0, ops_by_level}`; the ExUnit test runs it deeper than the vector does.
  """
  def floor_lattice(base, levels) do
    c0 = F.c0(base)
    prior = [%{binding: base.boot.id, catalog: F.cid(c0)}]

    first =
      for x <- ~w(a b), do: F.replacement(base, base.log, "f3-1" <> x, prior_catalogs: prior)

    {log, _prev, acc} =
      Enum.reduce(2..levels//1, {add(base.log, first), first, [first]}, fn k, {log, prev, acc} ->
        parents = prev |> Enum.map(& &1.id) |> Enum.sort()

        cur =
          for x <- ~w(a b),
              do: F.replacement(base, log, "f3-#{k}" <> x, parents: parents, generation: k)

        {add(log, cur), cur, [cur | acc]}
      end)

    {log, c0, Enum.reverse(acc)}
  end

  # F3 in the vectors: 12 levels (24 ops). Without the deduplicating join each final head's
  # floor holds 2,048 copies of the one Space entry; the TS test asserts the floors directly.
  defp f3_floor_lattice(base) do
    {log, c0, levels} = floor_lattice(base, 12)

    labels =
      for {ops, k} <- Enum.with_index(levels, 1), {r, x} <- Enum.zip(ops, ~w(a b)), into: %{} do
        {"L#{k}#{x}", r.id}
      end

    labels = Map.merge(base_labels(base, c0), labels)
    heads = ["L12a", "L12b"]
    closed = ["B" | for(k <- 1..11, x <- ~w(a b), do: "L#{k}#{x}")]

    one("F3: a lattice of nil citations keeps one copy of each floor entry", labels, [
      step(
        ev(log, catalogs: [c0]),
        ok(heads,
          closed: closed,
          forks: ["heads"],
          decision: [reason: "catalog_fork", block: "catalog_fork"]
        )
      )
    ])
  end
end
