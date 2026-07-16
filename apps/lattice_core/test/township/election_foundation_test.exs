defmodule Township.ElectionFoundationTest do
  use ExUnit.Case, async: true

  alias Lattice.Canonical.Atom, as: CanonicalAtom
  alias Lattice.Sim
  alias Township.{Election, Matter}
  alias Township.Election.{Link, ProfileRef, Spec}

  @matter "replica:matter:election-foundation"

  setup do
    keys =
      for role <- [:supervisor, :registrar, :box_a, :box_b, :trustee_a, :trustee_b], into: %{} do
        identity = Lattice.Identity.from_seed(Atom.to_string(role), "election-foundation:#{role}")
        {role, identity.pub}
      end

    {:ok, profile} =
      ProfileRef.new(%{
        id: "chide-research-candidate",
        version: "unselected",
        parameters_digest: "not-pinned"
      })

    {:ok, spec} =
      Spec.new(%{
        subject: @matter,
        question_digest: "sha256:question",
        choices: [:approve, :reject],
        profile: profile,
        supervisor: keys.supervisor,
        registration_tellers: [keys.registrar],
        ballot_boxes: [keys.box_a, keys.box_b],
        close_policy: %{id: :unanimous_boxes_v1, members: :ballot_boxes, quorum: :all},
        trustees: [keys.trustee_a, keys.trustee_b],
        max_corrupt_trustees: 0,
        tally_share_quorum: 2,
        result_policy: :plurality,
        domain: "township:test:election"
      })

    %{keys: keys, profile: profile, spec: spec}
  end

  test "the versioned spec digest binds every accepted frozen field but never an election id", %{
    spec: spec
  } do
    digest = Spec.digest(spec)
    alternate_key = Lattice.Identity.from_seed("alternate", "alternate-election-role").pub

    {:ok, alternate_profile} =
      ProfileRef.new(%{
        id: "other-profile",
        version: "other-version",
        parameters_digest: "other-parameters"
      })

    assert is_binary(digest)
    assert byte_size(digest) == 43
    refute Map.has_key?(Spec.to_canonical_term(spec), "election_id")

    replacements = [
      subject: "replica:matter:other",
      question_digest: "sha256:other-question",
      choices: [:approve, :reject, :abstain],
      profile: alternate_profile,
      supervisor: alternate_key,
      registration_tellers: [alternate_key],
      ballot_boxes: [hd(spec.ballot_boxes), alternate_key],
      trustees: [hd(spec.trustees), alternate_key],
      max_corrupt_trustees: 1,
      tally_share_quorum: 1,
      result_policy: :supermajority,
      domain: "township:test:other-election"
    ]

    for {field, replacement} <- replacements do
      {:ok, changed} = Spec.new(Map.put(Map.from_struct(spec), field, replacement))

      refute Spec.digest(changed) == digest,
             "changing #{field} must change the spec digest"
    end

    assert {:error, :unsupported_schema} =
             Spec.new(%{Map.from_struct(spec) | schema: "township-election-v2"})

    assert {:error, :unsupported_close_policy} =
             Spec.new(%{
               Map.from_struct(spec)
               | close_policy: %{id: :hash_winner, members: :ballot_boxes, quorum: 1}
             })

    assert {:error, :unsupported_close_policy} =
             Spec.new(%{
               Map.from_struct(spec)
               | close_policy: %{
                   id: :unanimous_boxes_v1,
                   members: :ballot_boxes,
                   quorum: :all,
                   unreviewed: make_ref()
                 }
             })

    assert Election.election_id(digest, "matter-link-a") ==
             Election.election_id(digest, "matter-link-a")

    refute Election.election_id(digest, "matter-link-a") ==
             Election.election_id(digest, "matter-link-b")
  end

  test "invalid threshold and role configurations fail before a digest exists", %{spec: spec} do
    attrs = Map.from_struct(spec)

    assert {:error, :tally_share_quorum_out_of_range} =
             Spec.new(%{attrs | tally_share_quorum: 3})

    assert {:error, :corruption_bound_out_of_range} =
             Spec.new(%{attrs | max_corrupt_trustees: 2})

    assert {:error, :duplicate_role_key} =
             Spec.new(%{attrs | ballot_boxes: [hd(spec.ballot_boxes), hd(spec.ballot_boxes)]})
  end

  test "canonical atom aliases are rejected before a spec digest exists", %{spec: spec} do
    token = %CanonicalAtom{name: "approve"}
    collision = %{:approve => 1, token => 2}

    assert {:error, :noncanonical_spec} =
             Spec.new(%{Map.from_struct(spec) | choices: [collision]})

    assert {:error, :noncanonical_spec} =
             Spec.new(%{Map.from_struct(spec) | result_policy: collision})
  end

  test "an honored Matter link binds the exact spec digest and link op id", %{spec: spec} do
    sim = Sim.new(Matter, @matter, ["sponsor", "outsider"], seed: "election-link")
    {sim, _genesis} = Sim.create_replica(sim, "sponsor")
    {:ok, spec} = Spec.new(%{Map.from_struct(spec) | subject: Sim.replica(sim)})
    {sim, link_op} = Sim.command(sim, "sponsor", :link_election, [Spec.digest(spec)])

    assert {:ok,
            %Link{
              election_id: election_id,
              spec_digest: spec_digest,
              matter_link_op_id: matter_link_op_id
            }} = Election.verify_link(spec, Sim.log(sim, "sponsor"), link_op.id)

    assert spec_digest == Spec.digest(spec)
    assert matter_link_op_id == link_op.id
    assert election_id == Election.election_id(spec_digest, matter_link_op_id)

    {sim, forged} =
      Sim.command(sim, "outsider", :link_election, [Spec.digest(spec)], cap: :none)

    assert {:error, :unauthorized_matter_link} =
             Election.verify_link(spec, Sim.log(sim, "outsider"), forged.id)
  end

  test "link verification rejects a self-asserted mutated spec", %{spec: spec} do
    sim = Sim.new(Matter, @matter, ["sponsor"], seed: "mutated-election-spec")
    {sim, _genesis} = Sim.create_replica(sim, "sponsor")
    {:ok, spec} = Spec.new(%{Map.from_struct(spec) | subject: Sim.replica(sim)})
    {sim, link_op} = Sim.command(sim, "sponsor", :link_election, [Spec.digest(spec)])

    assert {:error, :unsupported_schema} =
             Election.verify_link(
               %{spec | schema: "invented-schema"},
               Sim.log(sim, "sponsor"),
               link_op.id
             )

    assert {:error, :noncanonical_spec} =
             Election.verify_link(%{spec | choices: [1 | 2]}, Sim.log(sim, "sponsor"), link_op.id)
  end

  test "link verification rejects a structurally invalid causal closure", %{spec: spec} do
    sim = Sim.new(Matter, @matter, ["sponsor"], seed: "invalid-election-link-structure")
    {sim, _genesis} = Sim.create_replica(sim, "sponsor")
    {:ok, spec} = Spec.new(%{Map.from_struct(spec) | subject: Sim.replica(sim)})
    {sim, link_op} = Sim.command(sim, "sponsor", :link_election, [Spec.digest(spec)])

    tampered = %{link_op | sig: <<0::512>>}

    invalid_log =
      Sim.log(sim, "sponsor")
      |> Lattice.Log.ops()
      |> Map.put(link_op.id, tampered)
      |> then(&Lattice.Log.from_ops(Sim.replica(sim), &1))

    assert {:error, :invalid_matter_link_structure} =
             Election.verify_link(spec, invalid_log, link_op.id)

    malformed_deps = %{link_op | deps: :not_a_list}

    valid_log = Sim.log(sim, "sponsor")
    malformed_log = %{valid_log | ops: Map.put(valid_log.ops, link_op.id, malformed_deps)}

    assert {:error, :invalid_matter_link_structure} =
             Election.verify_link(spec, malformed_log, link_op.id)

    aliased_log = %{valid_log | ops: Map.put(valid_log.ops, "not-the-op-id", link_op)}

    assert {:error, :invalid_matter_link_structure} =
             Election.verify_link(spec, aliased_log, "not-the-op-id")
  end

  test "an invalid same-id forgery cannot poison a later genuine Matter link", %{spec: spec} do
    sim = Sim.new(Matter, @matter, ["sponsor"], seed: "election-link-forgery-poisoning")
    {sim, _genesis} = Sim.create_replica(sim, "sponsor")
    {:ok, spec} = Spec.new(%{Map.from_struct(spec) | subject: Sim.replica(sim)})
    {sim, link_op} = Sim.command(sim, "sponsor", :link_election, [Spec.digest(spec)])
    forgery = %{link_op | sig: <<0::512>>}

    log = %{
      Sim.log(sim, "sponsor")
      | quarantine: [%{op: forgery, reason: :bad_signature}]
    }

    assert {:ok, %Link{matter_link_op_id: matter_link_op_id}} =
             Election.verify_link(spec, log, link_op.id)

    assert matter_link_op_id == link_op.id
  end

  test "verification names the link explicitly and never chooses among concurrent links", %{
    spec: spec
  } do
    sim =
      Sim.new(Matter, @matter, ["sponsor_a", "sponsor_b"], seed: "concurrent-election-links")

    {sim, _genesis} = Sim.create_replica(sim, "sponsor_a")
    {sim, _grant} = Sim.grant(sim, "sponsor_a", "sponsor_b", ops: [:link_election])
    sim = Sim.sync_all(sim)
    {:ok, spec} = Spec.new(%{Map.from_struct(spec) | subject: Sim.replica(sim)})

    {branch_a, link_a} = Sim.command(sim, "sponsor_a", :link_election, [Spec.digest(spec)])
    {branch_b, link_b} = Sim.command(sim, "sponsor_b", :link_election, [Spec.digest(spec)])

    {merged, _other, _report} =
      Lattice.Sync.reconcile(Sim.log(branch_a, "sponsor_a"), Sim.log(branch_b, "sponsor_b"))

    assert {:ok, link_context_a} = Election.verify_link(spec, merged, link_a.id)
    assert {:ok, link_context_b} = Election.verify_link(spec, merged, link_b.id)
    refute link_context_a.election_id == link_context_b.election_id
  end
end
