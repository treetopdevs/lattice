defmodule Treehouse.CatalogReplacementAuthorityTest do
  @moduledoc """
  Plan 316 PR 4a step-4 predicates of `Treehouse.CatalogReplacementAuthority`, one each,
  against strict-prefix input only, plus the resolver-level C10 continuation case. Every
  negative asserts the exact failing predicate so a crash can never pass vacuously.
  Disposable seeded keys only.
  """
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Log, Sim}
  alias Lattice.Authority.Delegation
  alias Treehouse.CatalogBindingGraph, as: G
  alias Treehouse.CatalogBindingGraphFixtures, as: F
  alias Treehouse.CatalogReplacementAuthority, as: A
  alias Treehouse.Space

  @base F.base()

  defp check(base, log, r) do
    A.check(
      F.prefix(base, log, r.op.deps),
      %{author: r.op.author, cap: r.op.cap},
      r.claim,
      base.root.pub
    )
  end

  defp refused(predicate),
    do: {:error, :catalog_authority_refused, %{predicate: predicate, core_reason: nil}}

  test "honored leased admin passes every predicate" do
    r = F.replacement(@base, @base.log, "ok")
    assert check(@base, @base.log, r) == :ok
  end

  test "non-admin author is not_holder" do
    r =
      F.replacement(@base, @base.log, "n",
        author: @base.nominee,
        claim: %{author: @base.nominee.pub}
      )

    assert check(@base, @base.log, r) == refused(:not_holder)
  end

  test "stale holder epoch is not_holder" do
    r = F.replacement(@base, @base.log, "s", holder_epoch: @base.genesis.id)
    assert check(@base, @base.log, r) == refused(:not_holder)
  end

  test "cap that is not the acquisition delegation is wrong_acquisition_cap" do
    other = F.genesis_delegation(@base).id
    r = F.replacement(@base, @base.log, "c", cap: other)
    assert check(@base, @base.log, r) == refused(:wrong_acquisition_cap)
  end

  test "a ceiling without replace_catalog_v1 is missing_permission" do
    base = F.base(ops: F.admin_ops() -- [:replace_catalog_v1])
    r = F.replacement(base, base.log, "p")
    assert check(base, base.log, r) == refused(:missing_permission)
  end

  test "a live or unleased acquisition is refused, including the root genesis cap" do
    root_only = F.base(transfer: false)
    genesis = F.genesis_delegation(root_only)

    r =
      F.replacement(root_only, root_only.log, "root",
        author: root_only.root,
        claim: %{author: root_only.root.pub},
        cap: genesis.id,
        holder_epoch: root_only.genesis.id
      )

    assert Authority.holder_epoch(Space, root_only.log, :admin) == %{
             holder: root_only.root.pub,
             op_id: root_only.genesis.id
           }

    # The living root's genesis delegation is live and unleased; liveness is checked first.
    assert genesis.live == true and genesis.expires_epoch == nil
    assert check(root_only, root_only.log, r) == refused(:live_capability)

    for {opts, predicate} <- [{[live: true], :live_capability}, {[expires: nil], :unleased}] do
      t = F.transfer(root_only, Log.frontier(root_only.log), root_only.admin.pub, opts)
      log = F.append(root_only.log, [t.op])
      reason = Authority.analyze(Space, log).reasons[t.op.id]

      r =
        F.replacement(root_only, log, "lease-#{if predicate == :unleased, do: "u", else: "l"}",
          cap: t.delegation.id,
          holder_epoch: t.op.id
        )

      # Core honors both acquisitions; only the resolver predicate refuses them.
      assert reason == nil
      assert check(root_only, log, r) == refused(predicate)
    end
  end

  test "no honored beacon is no_beacon" do
    base = F.base(beacons: false)
    r = F.replacement(base, base.log, "nb")
    assert check(base, base.log, r) == refused(:no_beacon)
  end

  test "wrong epoch or basis is epoch_mismatch" do
    r = F.replacement(@base, @base.log, "e", claim: %{epoch: 0})
    assert check(@base, @base.log, r) == refused(:epoch_mismatch)
    r = F.replacement(@base, @base.log, "eb", claim: %{epoch_basis: [@base.beacon0.id]})
    assert check(@base, @base.log, r) == refused(:epoch_mismatch)
  end

  test "a lease lapsed at the prefix epoch is lease_lapsed" do
    base = F.base(expires: 0)
    r = F.replacement(base, base.log, "l")
    assert check(base, base.log, r) == refused(:lease_lapsed)
  end

  test "profile pin mismatch is wrong_catalog_scope and outranks the authority predicates" do
    r =
      F.replacement(@base, @base.log, "pf",
        author: @base.nominee,
        claim: %{author: @base.nominee.pub, profile_id: F.id("other")}
      )

    assert check(@base, @base.log, r) ==
             {:error, :wrong_catalog_scope, %{predicate: :profile, core_reason: nil}}
  end

  # --- R04 continuation (C10) and row 335 ------------------------------------------

  defp witnessed(sim, epochs) do
    Enum.reduce(epochs, sim, fn epoch, s ->
      {s, _} = Sim.beacon(s, "w1", epoch, witnesses: ["w1", "w2"])
      Sim.sync_all(s)
    end)
  end

  defp continued(sim, ops, expires) do
    case Sim.continue_role(sim, "admin", :admin,
           ops: ops,
           expires_epoch: expires,
           witnesses: ["w1", "w2"]
         ) do
      {%Sim{} = sim, op} -> {:ok, Sim.sync_all(sim), op}
      error -> error
    end
  end

  test "R04 continuation successor (parent_id nil) passes and is an accepted resolver node" do
    sim = witnessed(@base.sim, [2])
    {:ok, sim, cont} = continued(sim, F.admin_ops(), 8)
    {:succeed, :admin, %Delegation{} = d, _} = cont.body
    assert d.parent_id == nil and d.issuer == @base.admin.pub and d.expires_epoch == 8
    log = Sim.log(sim, "observer")

    r = F.replacement(@base, log, "rc", cap: d.id, holder_epoch: cont.id)
    assert check(@base, log, r) == :ok

    k = F.first(@base, r)
    c0 = F.c0(@base)

    {{:ok, g}, _} =
      F.deliver(@base, F.empty_state(), %{
        space: F.append(log, [r.op]),
        catalogs: %{F.cid(c0) => c0, F.cid(k) => k},
        proven: Enum.map(r.claim.cutoffs, &Map.take(&1, [:replica, :frontier, :log_digest]))
      })

    n = G.node(g, r.id)
    assert n.kind == :replacement and n.generation == 1 and not n.refused?

    assert {n.service_id, n.service_key, n.origin} ==
             {r.service_id, r.service_key.pub, "wss://rc-relay.invalid"}

    assert n.key == r.catalog_key.pub and n.parents == [@base.boot.id]
    assert g.decision.accepted and g.decision.head == r.id and g.decision.catalog == F.cid(k)

    # The ceiling and lease predicates are evaluated on the continuation delegation itself.
    assert A.acquired(F.prefix(@base, log, r.op.deps), %{op_id: cont.id, delegation_id: d.id}) ==
             d
  end

  test "continuation negative twins: a ceiling without replace_catalog_v1 and an unleased continuation" do
    sim = witnessed(@base.sim, [2])
    {:ok, narrow_sim, narrow} = continued(sim, F.admin_ops() -- [:replace_catalog_v1], 8)
    {:succeed, :admin, nd, _} = narrow.body
    log = Sim.log(narrow_sim, "observer")
    r = F.replacement(@base, log, "rcn", cap: nd.id, holder_epoch: narrow.id)
    assert check(@base, log, r) == refused(:missing_permission)

    # Core never reviews an unleased continuation (and `Sim.continue_role/4` fixes live: false),
    # so neither twin can reach the resolver as an honored record.
    assert {:error, _} = continued(sim, F.admin_ops(), nil)
  end

  test "row 335: a broad, narrowed, restored acquisition sequence is Core-honored and refused" do
    sim = witnessed(@base.sim, [2])
    {:ok, sim, cont} = continued(sim, F.admin_ops(), 8)
    {:succeed, :admin, broad, _} = cont.body
    {:ok, sim, _narrow} = continued(sim, F.admin_ops() -- [:replace_catalog_v1], 8)

    restored =
      Delegation.new(@base.admin, sim.replica, @base.nominee.pub,
        ops: F.admin_ops(),
        roles: [:admin],
        parent_id: broad.id,
        expires_epoch: 8
      )

    {sim, restore_op} = Sim.append(sim, "admin", :authority, {:transfer, :admin, restored, 0})
    log = Sim.log(Sim.sync_all(sim), "observer")
    assert Authority.analyze(Space, log).reasons[restore_op.id] == nil

    assert Authority.holder_epoch(Space, log, :admin) == %{
             holder: @base.nominee.pub,
             op_id: restore_op.id
           }

    r =
      F.replacement(@base, log, "restored",
        author: @base.nominee,
        claim: %{author: @base.nominee.pub},
        cap: restored.id,
        holder_epoch: restore_op.id
      )

    assert check(@base, log, r) == refused(:inherited_provenance)
  end

  test "refute_without_closure reads only the held holder_epoch op's own delegation" do
    claim = F.replacement(@base, @base.log, "x").claim
    ops = Log.ops(@base.log)
    assert A.refute_without_closure(ops, @base.admin.pub, claim) == nil
    assert A.refute_without_closure(ops, @base.nominee.pub, claim) == :not_holder
    assert A.refute_without_closure(%{}, @base.nominee.pub, claim) == nil

    assert A.refute_without_closure(ops, @base.admin.pub, %{claim | cap: F.id("none")}) ==
             :delegation_unreadable
  end
end
