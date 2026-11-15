defmodule Treehouse.CatalogBindingGraphScenarios do
  @moduledoc """
  Plan 316 PR 4a scenario table for `Treehouse.CatalogBindingGraph`, shared by the ExUnit
  tests and the `binding_graph_v1.json` reciprocal vectors (finding 8).

  Each scenario is a list of deliveries. A delivery carries the full retained evidence (Space
  log, rotations, catalogs, proven cutoffs) and a hand-written expectation in label terms:
  heads, closed set, closed-out children, nodes, refused nodes, raw evidence, retained
  refusals, nodes with pending cutoffs, fork kinds and the decision. The accepted watermark
  and blocked state persist between deliveries (`CatalogBindingGraphFixtures.deliver/3`);
  multi-delivery scenarios are listed once per delivery order. Disposable seeded keys only.
  """

  alias Lattice.{Log, Op}
  alias Lattice.Carrier.Wire
  alias Treehouse.CatalogBindingGraphFixtures, as: F
  alias Treehouse.TransportCatalog

  # --- expectation helpers -----------------------------------------------------

  @doc "A successful expectation; omitted fields mean empty / no decision."
  def ok(heads, opts \\ []) do
    closed = Keyword.get(opts, :closed, [])
    d = Keyword.get(opts, :decision, [])

    %{
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
        "accepted" => Keyword.get(d, :accepted, false),
        "reason" => Keyword.get(d, :reason),
        "block" => Keyword.get(d, :block),
        "head" => Keyword.get(d, :head),
        "catalog" => Keyword.get(d, :catalog),
        "clears" => Keyword.get(d, :clears, false)
      }
    }
  end

  def err(reason), do: %{"error" => reason}

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
          do: %{replica: cutoff.replica, log_digest: cutoff.log_digest}

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
      &idempotent_and_rollback/1
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
        decision: [head: "R1", reason: "catalog_authority_refused"]
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
            decision: [head: "R1", reason: "authority_changed", block: "authority_changed"]
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
          decision: [head: "TR", reason: "catalog_authority_refused"]
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

    both(
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
          ok(["Res"], closed: ["A", "B", "Bs"], decision: accept("Res", "KRes"))
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
          ok(["Res"], closed: ["A", "B", "Bs"], decision: accept("Res", "KRes"))
        )
      ]
    )
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
          decision: [head: "Bs", reason: "recovery_incomplete"]
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
            decision: [head: "R", reason: "authority_changed", block: "authority_changed"]
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
            decision: [head: "R", reason: "authority_changed", block: "authority_changed"]
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
            decision: [head: "R", reason: "authority_changed", block: "authority_changed"]
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
        decision: [head: "R", reason: "catalog_authority_refused"]
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
            decision: [head: "R", reason: "catalog_authority_refused"]
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
        step(ev(lr, catalogs: [c0, k2]), ok(["R2"], closed: ["B"], decision: accept("R2", "K2")))
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
        decision: [head: "R1", reason: "authority_changed", block: "authority_changed"]
      )

    [
      one("C13: concurrent revoke after accepting R1, then a fresh resolution clears", labels, [
        step(ev(l1, catalogs: [c0, k1]), ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))),
        step(ev(add(l1, [tn]), catalogs: [c0, k1]), refused_r1),
        step(ev(l3, catalogs: cats), resolved.(true))
      ]),
      one("C13: revoke and resolution delivered together after accepting R1", labels, [
        step(ev(l1, catalogs: [c0, k1]), ok(["R1"], closed: ["B"], decision: accept("R1", "K1"))),
        step(ev(l3, catalogs: cats), resolved.(false)),
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
            decision: [head: "R1", reason: "catalog_authority_refused"]
          )
        ),
        step(ev(l3, catalogs: cats), resolved.(false))
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

    high = %{
      accepted: %{binding: r1.id, generation: 5, catalog: F.cid(k1), revision: 0},
      blocked: nil
    }

    [
      one("same bytes are idempotent", labels, [
        step(ev(l1, catalogs: [c0, k1]), done),
        step(ev(l1, catalogs: [c0, k1]), done)
      ]),
      one("lower generation than the watermark is catalog_rollback", labels, [
        step(
          ev(l1, catalogs: [c0, k1]),
          ok(["R1"], closed: ["B"], decision: [head: "R1", reason: "catalog_rollback"]),
          high
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
         label_view: label_view(result, scenario.labels),
         expect: s.expect,
         view: F.view(result),
         evidence: s.evidence,
         state_in: state
       }, next}
    end)
    |> elem(0)
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
        "head" => d.head && l.(d.head),
        "catalog" => d.catalog && l.(d.catalog),
        "clears" => d.clears_authority_changed
      }
    }
  end

  defp label_fun(labels) do
    reverse = Map.new(labels, fn {k, v} -> {v, k} end)
    &Map.get(reverse, &1, "?" <> &1)
  end

  defp sorted(ids, l), do: ids |> Enum.map(l) |> Enum.sort()

  # --- vectors -----------------------------------------------------------------------

  @doc "The JSON vector: inputs, hand-written expectations and BEAM incidental outputs."
  def vector(base \\ F.base()) do
    scenarios = all(base)

    %{
      "version" => 1,
      "bootstrap" => %{
        "id" => base.boot.id,
        "record" => base.boot.record |> Wire.encode_value()
      },
      "space" => base.replica,
      "generation_cases" => generation_cases(),
      "scenarios" =>
        Enum.map(scenarios, fn s ->
          %{
            "name" => s.name,
            "labels" => s.labels,
            "steps" =>
              Enum.map(run(base, s), fn r ->
                %{
                  "state" => state_json(r.state_in),
                  "frames" =>
                    r.evidence.space
                    |> Log.ops()
                    |> Map.values()
                    |> Enum.sort_by(& &1.id)
                    |> Enum.map(&Wire.encode_op/1),
                  "rotations" =>
                    r.evidence.rotations
                    |> Enum.sort()
                    |> Enum.map(fn {_id, e} -> artifact(e) end),
                  "catalogs" =>
                    r.evidence.catalogs
                    |> Enum.sort()
                    |> Enum.map(fn {_id, e} -> artifact(e) end),
                  "proven" =>
                    Enum.map(
                      r.evidence.proven,
                      &%{"replica" => &1.replica, "logDigest" => &1.log_digest}
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

  defp state_json(%{accepted: a, blocked: b}) do
    %{
      "accepted" =>
        a &&
          %{
            "binding" => a.binding,
            "generation" => a.generation,
            "catalog" => a.catalog,
            "revision" => a.revision
          },
      "blocked" => b && %{"reason" => to_string(b.reason), "triggers" => b.triggers}
    }
  end

  defp artifact(envelope), do: envelope |> Wire.encode_value() |> Jason.encode!()

  @doc "Write `binding_graph_v1.json`."
  def write(path) do
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, encode(vector()))
  end

  def encode(vector), do: Jason.encode!(vector, pretty: true) <> "\n"

  @doc false
  def inventory_id(entries), do: TransportCatalog.inventory_id(entries)
end
