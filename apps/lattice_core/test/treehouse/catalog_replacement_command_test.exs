defmodule Treehouse.CatalogReplacementCommandTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Authority.Delegation
  alias Treehouse.{CatalogReplacementVectors, Space}

  # SHA-256 of the root-only preview genesis bytes, captured on origin/main 7bdace22e before
  # this command existed (seed "r316-preview-root", "treehouse:legacy-preview", "Canopy").
  @preview_genesis_sha256 "707eb023c89e82dd558953149413e42eb52bd9a26a28f4c9717157cad351802d"

  setup_all do
    {:ok, f: CatalogReplacementVectors.fixture()}
  end

  defp reason(log, op), do: Authority.analyze(Space, Log.append!(log, op)).reasons[op.id]

  test "admin-authored valid replacement is Core-honored and writes only the admin_actions marker",
       %{f: f} do
    assert Authority.analyze(Space, f.log).reasons == %{}
    before = Lattice.state(Space, f.before_replacement)
    after_ = Lattice.state(Space, f.log)
    assert before.admin_actions == "create_space"
    assert after_ == %{before | admin_actions: "replace_catalog_v1"}
    assert {:replace_catalog_v1, [_, _, _]} = f.replacement.body
  end

  test "non-admin refused by cap", %{f: f} do
    member = f.nominee

    narrow =
      Delegation.new(f.root, f.replica, member.pub,
        parent_id: f.delegation.id,
        ops: [:create_space],
        roles: [:admin]
      )

    no_admin =
      Delegation.new(f.root, f.replica, member.pub,
        parent_id: f.delegation.id,
        ops: [:create_space, :replace_catalog_v1],
        roles: []
      )

    not_holder =
      Delegation.new(f.root, f.replica, member.pub,
        parent_id: f.delegation.id,
        ops: [:create_space, :replace_catalog_v1],
        roles: [:admin]
      )

    grants =
      for d <- [narrow, no_admin, not_holder],
          do:
            Op.new(f.root, f.replica, Log.frontier(f.before_replacement), :authority, {:grant, d})

    log = Enum.reduce(grants, f.before_replacement, &Log.append!(&2, &1))
    deps = Enum.sort(Log.frontier(log))

    for {d, expected} <- [
          {narrow, :operation_not_granted},
          {no_admin, :role_not_granted},
          {not_holder, :not_holder}
        ] do
      claim = %{f.claim | author: member.pub, cap: d.id, deps: deps}

      op =
        CatalogReplacementVectors.replacement_op(
          f,
          claim,
          CatalogReplacementVectors.signed_args(f, claim),
          identity: member,
          cap: d.id
        )

      assert reason(log, op) == expected
    end
  end

  test "Stage A literal bindings", %{f: f} do
    cases = CatalogReplacementVectors.stage_a_cases(f)

    assert Enum.map(cases, &elem(&1, 0)) == [
             "malformed-claim-extra-field",
             "malformed-claim-nil",
             "wrong-author-field",
             "wrong-cap-field",
             "deps-differ-from-op",
             "holder-epoch-not-visible",
             "bootstrap-not-visible",
             "bootstrap-not-a-bootstrap-op",
             "bootstrap-quarantined",
             "wrong-space",
             "bad-catalog-possession",
             "bad-service-possession",
             "non-binary-possession",
             "high-generation",
             "high-epoch",
             "high-integer-possession"
           ]

    for {name, prefix, op} <- cases do
      log = Enum.reduce(prefix, f.before_replacement, &Log.append!(&2, &1))
      assert reason(log, op) == :application_invalid_catalog, name
      assert Lattice.state(Space, Log.append!(log, op)).admin_actions != "replace_catalog_v1"
    end

    # The quarantined-bootstrap case fails only on its bootstrap: the same history with the
    # honored bootstrap cited is honored.
    {_, [bad], op} = Enum.find(cases, &(elem(&1, 0) == "bootstrap-quarantined"))
    log = Log.append!(f.before_replacement, bad)
    assert Authority.analyze(Space, log).reasons[bad.id] == :application_invalid_catalog
    {:replace_catalog_v1, [claim, _, _]} = op.body
    claim = %{claim | bootstrap: f.bootstrap.id}

    honored =
      CatalogReplacementVectors.replacement_op(
        f,
        claim,
        CatalogReplacementVectors.signed_args(f, claim)
      )

    assert reason(log, honored) == nil
  end

  test "op deps are compared as a sorted set", %{f: f} do
    op =
      CatalogReplacementVectors.replacement_op(
        f,
        f.claim,
        [f.claim, f.catalog_possession, f.service_possession],
        deps: Enum.reverse(f.claim.deps ++ f.claim.deps)
      )

    assert reason(f.before_replacement, op) == nil
  end

  test "arity", %{f: f} do
    for args <- [[f.claim], [f.claim, f.catalog_possession]] do
      op = CatalogReplacementVectors.replacement_op(f, f.claim, args)
      assert reason(f.before_replacement, op) == :bad_command_arity
    end
  end

  test "root-only preview ceiling bytes unchanged" do
    root = Identity.from_seed("root", "r316-preview-root")

    assert {:ok, %{pending: [genesis, _]}} =
             Space.prepare_creation(root, "treehouse:legacy-preview", "Canopy")

    assert Base.encode16(:crypto.hash(:sha256, Op.canonical_encoding(genesis)), case: :lower) ==
             @preview_genesis_sha256

    {:genesis, d, %{}} = genesis.body

    assert d.ops ==
             MapSet.new([
               :create_space,
               :create_thread,
               :issue_invitation,
               :revoke_invitation,
               :admit_member,
               :remove_member
             ])
  end
end
