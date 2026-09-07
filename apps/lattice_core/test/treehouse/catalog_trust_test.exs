defmodule Treehouse.CatalogTrustTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Canonical, Identity, Log, Op}
  alias Lattice.Authority.Delegation
  alias Lattice.Carrier.Wire
  alias Treehouse.{CatalogTrust, CatalogTrustVectors, TransportCatalog}

  @expected %{trust_revision: 0, history_generation: 0}

  test "reviewed bootstrap and authenticated catalog produce installation-required routes" do
    fixture = CatalogTrustVectors.fixture()

    assert %{kind: :propose, next: prepared, routes: []} =
             CatalogTrust.prepare_installation(%{
               review: fixture.review,
               history: hd(fixture.histories),
               store: %{kind: :verified_fresh, expected: @expected}
             })

    assert %{kind: :propose, reason: nil, next: installed, routes: routes} =
             decision =
             CatalogTrust.evaluate(%{
               installed: prepared,
               expected: @expected,
               incoming: %{
                 catalogs: [fixture.catalog_json],
                 rotations: [],
                 histories: fixture.histories,
                 cutoff_proofs: []
               }
             })

    assert installed.accepted.revision == 0
    assert length(routes) == 2

    assert %{ok: true, installation_required: true, candidate: candidate} =
             CatalogTrust.resolve_route(%{
               decision: decision,
               replica: hd(fixture.threads).replica
             })

    assert candidate.root == hd(fixture.threads).root.pub
  end

  test "missing raw closure is pending but representable forgery takes precedence" do
    fixture = CatalogTrustVectors.fixture()
    history = hd(fixture.histories)
    missing_id = fixture.space.genesis.id
    missing = %{history | frames: Enum.reject(history.frames, &(&1["id"] == missing_id))}

    assert %{kind: :reject, reason: :trust_pending} =
             CatalogTrust.prepare_installation(%{
               review: fixture.review,
               history: missing,
               store: %{kind: :verified_fresh, expected: @expected}
             })

    forged =
      update_in(missing.frames, fn frames ->
        Enum.map(frames, fn frame ->
          if frame["id"] == fixture.space.bootstrap.id,
            do: %{frame | "sig" => Base.encode64(<<0::512>>)},
            else: frame
        end)
      end)

    assert %{kind: :reject, reason: :invalid_verified_history} =
             CatalogTrust.prepare_installation(%{
               review: fixture.review,
               history: forged,
               store: %{kind: :verified_fresh, expected: @expected}
             })
  end

  test "a blocked retained snapshot cannot mask corrupted installed signatures" do
    fixture = CatalogTrustVectors.fixture()
    state = installed(fixture)

    revised = %{
      fixture.catalog
      | revision: 1,
        previous: TransportCatalog.catalog_id(fixture.catalog)
    }

    sibling = %{revised | entries: move_routes(revised.entries, "sibling")}

    fork =
      evaluate(state, fixture,
        catalogs: [
          json(revised, fixture.space.catalog),
          json(sibling, fixture.space.catalog)
        ]
      )

    assert %{kind: :retain_blocked, reason: :catalog_fork} = fork
    [saved | rest] = fork.next.catalogs
    {:ok, envelope} = TransportCatalog.decode_catalog_json(saved.json)

    corrupt = %{
      saved
      | json: CatalogTrustVectors.artifact_json(%{envelope | signature: <<0::512>>})
    }

    assert %{kind: :reject, reason: :trust_recovery_required} =
             evaluate(%{fork.next | catalogs: [corrupt | rest]}, fixture)
  end

  test "signed siblings freeze in either order and preserve the accepted watermark" do
    fixture = CatalogTrustVectors.fixture()
    state = installed(fixture)
    previous = TransportCatalog.catalog_id(fixture.catalog)

    a = %{
      fixture.catalog
      | revision: 1,
        previous: previous,
        entries: move_routes(fixture.catalog.entries, "a")
    }

    b = %{
      fixture.catalog
      | revision: 1,
        previous: previous,
        entries: move_routes(fixture.catalog.entries, "b")
    }

    artifacts = [json(a, fixture.space.catalog), json(b, fixture.space.catalog)]

    for values <- [artifacts, Enum.reverse(artifacts)] do
      assert %{kind: :retain_blocked, reason: :catalog_fork, routes: [], next: next} =
               evaluate(state, fixture, catalogs: values)

      assert next.accepted == state.accepted
      assert length(next.catalogs) == 3
    end
  end

  test "old-key rotation requires new possession and exact historical cutoffs" do
    fixture = CatalogTrustVectors.fixture()
    state = installed(fixture)
    rotation_id = TransportCatalog.rotation_id(fixture.rotation_envelope)
    rotated = %{fixture.catalog | binding: rotation_id}
    rotated_json = json(rotated, fixture.next_catalog)

    assert %{kind: :propose, reason: nil, next: next, routes: routes} =
             evaluate(state, fixture,
               rotations: [fixture.rotation_json],
               catalogs: [rotated_json],
               cutoff_proofs: fixture.cutoff_proofs
             )

    assert next.accepted.generation == 1
    assert next.accepted.binding == rotation_id
    assert length(routes) == 2

    bad = %{fixture.rotation_envelope | new_signature: <<0::512>>}

    assert %{kind: :reject, reason: :invalid_possession} =
             evaluate(state, fixture,
               rotations: [CatalogTrustVectors.artifact_json(bad)],
               cutoff_proofs: fixture.cutoff_proofs
             )

    assert %{kind: :propose, reason: :recovery_incomplete, next: pending} =
             evaluate(state, fixture,
               rotations: [fixture.rotation_json],
               catalogs: [rotated_json]
             )

    assert pending.accepted == state.accepted
  end

  test "closed inputs and route resolution reject caller-added authority" do
    fixture = CatalogTrustVectors.fixture()
    state = installed(fixture)

    assert %{kind: :reject, reason: :malformed_catalog} =
             CatalogTrust.evaluate(%{
               installed: state,
               expected: @expected,
               incoming: Map.put(empty(), :trusted, true)
             })

    decision = evaluate(state, fixture)
    assert decision.kind == :unchanged
    [route | _] = decision.routes
    forged = put_in(decision.routes, [%{route | service_key: <<0::256>>}])

    assert CatalogTrust.resolve_route(%{decision: forged, replica: route.replica}) ==
             CatalogTrust.resolve_route(%{decision: decision, replica: route.replica})

    assert %{ok: false, reason: :trust_recovery_required} =
             CatalogTrust.resolve_route(%{
               decision: Map.put(decision, :trusted, true),
               replica: route.replica
             })

    assert %{ok: false, reason: :trust_recovery_required} =
             CatalogTrust.resolve_route(%{
               decision: %{decision | detail: Map.put(decision.detail, :trusted, true)},
               replica: route.replica
             })
  end

  test "authority freeze stores an authenticated historical witness and reopens without routes" do
    fixture = CatalogTrustVectors.fixture()
    state = installed(fixture)
    transfer = refusing_transfer(fixture)

    changed_space =
      fixture.space_log |> Log.append!(transfer) |> CatalogTrustVectors.raw_history()

    assert %{kind: :retain_blocked, reason: :authority_changed, next: frozen, routes: []} =
             evaluate(state, fixture, histories: [changed_space])

    assert [%{replica: replica, frontier: frontier, op_ids: op_ids}] =
             frozen.blocked.authority_witnesses

    assert replica == fixture.space.replica
    assert frontier == Log.frontier(Log.append!(fixture.space_log, transfer))
    assert frozen.blocked.op_ids == op_ids
    assert fixture.space.bootstrap.id in op_ids

    assert %{kind: :retain_blocked, reason: :authority_changed, routes: []} =
             evaluate(frozen, fixture)

    corrupted =
      put_in(frozen.blocked.authority_witnesses, [
        %{replica: replica, frontier: [fixture.space.bootstrap.id], op_ids: op_ids}
      ])

    assert %{kind: :reject, reason: :trust_recovery_required} = evaluate(corrupted, fixture)
  end

  test "authority freeze retains only historically valid pending descendants" do
    base = CatalogTrustVectors.fixture(0)
    candidate = CatalogTrustVectors.fixture(1)
    state = installed(base)
    transfer = refusing_transfer(candidate)

    changed_space =
      candidate.space_log |> Log.append!(transfer) |> CatalogTrustVectors.raw_history()

    assert %{kind: :retain_blocked, reason: :authority_changed, next: authority_frozen} =
             evaluate(state, base, histories: [changed_space])

    candidate_space = Enum.find(candidate.catalog.entries, &(&1.kind == :space))
    candidate_thread = Enum.find(candidate.catalog.entries, &(&1.kind == :thread))
    [accepted_space] = base.catalog.entries

    pending_catalog = %{
      candidate.catalog
      | entries:
          [
            %{candidate_space | route: "/r/" <> CatalogTrustVectors.id("moved-space")},
            %{candidate_thread | route: accepted_space.route}
          ]
          |> Enum.sort_by(& &1.replica)
    }

    pending_json = json(pending_catalog, candidate.space.catalog)
    pending_id = TransportCatalog.catalog_id(pending_catalog)

    assert %{kind: :retain_blocked, reason: :authority_changed, next: pending, routes: []} =
             evaluate(authority_frozen, base, catalogs: [pending_json])

    assert Enum.any?(pending.catalogs, &(&1.id == pending_id and &1.json == pending_json))
    assert pending.blocked.authority_witnesses == authority_frozen.blocked.authority_witnesses

    thread = hd(candidate.threads)
    thread_transfer = refusing_thread_transfer(thread)

    changed_thread =
      thread.log |> Log.append!(thread_transfer) |> CatalogTrustVectors.raw_history()

    assert %{kind: :retain_blocked, reason: :authority_changed, next: retained, routes: []} =
             evaluate(pending, base, histories: [changed_thread])

    assert retained.blocked.authority_witnesses == authority_frozen.blocked.authority_witnesses

    assert %{kind: :retain_blocked, reason: :authority_changed, next: reopened, routes: []} =
             evaluate(retained, base)

    assert reopened == retained

    wrong_root =
      update_in(pending_catalog, [:entries], fn entries ->
        Enum.map(entries, fn entry ->
          if entry.kind == :thread, do: %{entry | root: <<0::256>>}, else: entry
        end)
      end)

    wrong_id = TransportCatalog.catalog_id(wrong_root)

    assert %{kind: :retain_blocked, reason: :authority_changed, next: unchanged, routes: []} =
             evaluate(authority_frozen, base,
               catalogs: [json(wrong_root, candidate.space.catalog)],
               histories: [changed_thread]
             )

    refute Enum.any?(unchanged.catalogs, &(&1.id == wrong_id))
  end

  @tag timeout: 120_000
  test "1023 retained artifacts plus two authenticated records retain both overflow witnesses" do
    fixture = CatalogTrustVectors.fixture(0)
    prepared = prepared(fixture)
    {records, latest, next_revision} = catalog_chain(fixture, 1_023)
    state = %{prepared | catalogs: records, accepted: latest}
    previous = latest.catalog

    first = %{fixture.catalog | revision: next_revision, previous: previous}
    first_json = json(first, fixture.space.catalog)
    first_id = TransportCatalog.catalog_id(first)
    second = %{fixture.catalog | revision: next_revision + 1, previous: first_id}
    second_json = json(second, fixture.space.catalog)

    assert %{kind: :retain_blocked, reason: :control_history_limit, next: frozen, routes: []} =
             evaluate(state, fixture, catalogs: [first_json, second_json])

    assert length(frozen.catalogs) == 1_023

    assert Enum.map(frozen.blocked.triggers, & &1.id) ==
             Enum.sort([first_id, TransportCatalog.catalog_id(second)])

    triggers = frozen.blocked.triggers

    assert %{kind: :retain_blocked, reason: :control_history_limit, routes: []} =
             evaluate(frozen, fixture)

    third = %{
      fixture.catalog
      | revision: next_revision,
        previous: previous,
        entries: move_routes(fixture.catalog.entries, "third")
    }

    assert %{kind: :retain_blocked, next: still_frozen} =
             evaluate(frozen, fixture, catalogs: [json(third, fixture.space.catalog)])

    assert still_frozen.catalogs == frozen.catalogs
    assert still_frozen.blocked.triggers == triggers

    transfer = refusing_transfer(fixture)

    changed_space =
      fixture.space_log |> Log.append!(transfer) |> CatalogTrustVectors.raw_history()

    assert %{kind: :retain_blocked, reason: :authority_changed, next: overflow_then_authority} =
             evaluate(frozen, fixture, histories: [changed_space])

    assert overflow_then_authority.blocked.triggers == triggers
    assert overflow_then_authority.blocked.authority_witnesses != []

    assert %{kind: :retain_blocked, reason: :authority_changed, next: authority_frozen} =
             evaluate(state, fixture, histories: [changed_space])

    assert %{kind: :retain_blocked, reason: :authority_changed, next: authority_then_overflow} =
             evaluate(authority_frozen, fixture, catalogs: [first_json, second_json])

    assert authority_then_overflow.catalogs == authority_frozen.catalogs
    assert authority_then_overflow.blocked.triggers == triggers

    assert authority_then_overflow.blocked.authority_witnesses ==
             authority_frozen.blocked.authority_witnesses

    assert %{kind: :retain_blocked, reason: :authority_changed, next: simultaneous} =
             evaluate(state, fixture,
               catalogs: [first_json, second_json],
               histories: [changed_space]
             )

    assert simultaneous.blocked.triggers == triggers
    assert simultaneous.blocked.authority_witnesses != []

    duplicate_trigger =
      put_in(frozen.blocked.triggers, [hd(frozen.blocked.triggers), hd(frozen.blocked.triggers)])

    assert %{kind: :reject, reason: :trust_recovery_required} =
             evaluate(duplicate_trigger, fixture)

    [saved | rest] = frozen.catalogs
    {:ok, envelope} = TransportCatalog.decode_catalog_json(saved.json)

    corrupt = %{
      saved
      | json: CatalogTrustVectors.artifact_json(%{envelope | signature: <<0::512>>})
    }

    assert %{kind: :reject, reason: :trust_recovery_required} =
             evaluate(%{frozen | catalogs: [corrupt | rest] |> Enum.sort_by(& &1.id)}, fixture)
  end

  test "catalog evidence stays pending until the exact child history arrives" do
    fixture = CatalogTrustVectors.fixture()
    prepared = prepared(fixture)

    assert %{kind: :propose, reason: :trust_pending, next: pending, routes: []} =
             evaluate(prepared, fixture, catalogs: [fixture.catalog_json])

    assert length(pending.catalogs) == 1
    assert pending.accepted == nil

    assert %{kind: :propose, reason: nil, routes: routes} =
             evaluate(pending, fixture, histories: fixture.histories)

    assert length(routes) == 2
  end

  test "a frozen fork retains later authentic refusal evidence and reopens stably" do
    base = CatalogTrustVectors.fixture(0)
    candidate = CatalogTrustVectors.fixture(1)
    state = installed(base)
    space_history = hd(candidate.histories)

    assert %{kind: :retain_blocked, reason: :catalog_fork, next: frozen, routes: []} =
             evaluate(state, base,
               catalogs: [candidate.catalog_json],
               histories: [space_history]
             )

    assert frozen.accepted == state.accepted
    assert frozen.blocked.pending_proof_ids == [TransportCatalog.catalog_id(candidate.catalog)]

    thread = hd(candidate.threads)
    transfer = refusing_thread_transfer(thread)
    changed_thread = thread.log |> Log.append!(transfer) |> CatalogTrustVectors.raw_history()

    assert Map.has_key?(
             Authority.analyze(Treehouse.Thread, Log.append!(thread.log, transfer)).reasons,
             thread.creation.id
           )

    for histories <- [
          [space_history, changed_thread],
          [changed_thread, space_history]
        ] do
      assert %{kind: :retain_blocked, reason: :catalog_fork, next: retained, routes: []} =
               evaluate(frozen, base, histories: histories)

      assert retained.accepted == state.accepted
      assert retained.histories |> Enum.find(&(&1.replica == thread.replica)) == changed_thread

      assert %{kind: :retain_blocked, reason: :catalog_fork, next: reopened, routes: []} =
               evaluate(retained, base)

      assert reopened == retained
    end

    assert %{kind: :reject, reason: :invalid_catalog_transition} =
             evaluate(state, base,
               catalogs: [candidate.catalog_json],
               histories: [space_history, changed_thread]
             )
  end

  test "a frozen nonaccepted sibling retains a later proven wrong reference" do
    base = CatalogTrustVectors.fixture(0)
    candidate = CatalogTrustVectors.fixture(2)
    state = installed(base)
    [thread_a, thread_b] = candidate.threads

    wrong_catalog =
      update_in(candidate.catalog, [:entries], fn entries ->
        entries
        |> Enum.reject(&(&1.replica == thread_a.replica))
        |> Enum.map(fn entry ->
          if entry.replica == thread_b.replica,
            do: %{entry | reference: thread_a.reference.id},
            else: entry
        end)
      end)

    wrong_json = json(wrong_catalog, candidate.space.catalog)
    wrong_id = TransportCatalog.catalog_id(wrong_catalog)
    [space_history, _thread_a_history, thread_b_history] = candidate.histories

    assert %{kind: :retain_blocked, reason: :catalog_fork, next: frozen, routes: []} =
             evaluate(state, base,
               catalogs: [wrong_json],
               histories: [space_history]
             )

    assert frozen.blocked.pending_proof_ids == [wrong_id]

    for histories <- [
          [space_history, thread_b_history],
          [thread_b_history, space_history]
        ] do
      assert %{kind: :retain_blocked, reason: :catalog_fork, next: retained, routes: []} =
               evaluate(frozen, base, histories: histories)

      assert retained.accepted == state.accepted
      assert Enum.any?(retained.catalogs, &(&1.id == wrong_id and &1.json == wrong_json))
      assert retained.blocked.pending_proof_ids == [wrong_id]

      assert %{kind: :retain_blocked, reason: :catalog_fork, next: reopened, routes: []} =
               evaluate(retained, base)

      assert reopened == retained
    end

    assert %{kind: :reject, reason: :invalid_catalog_transition} =
             evaluate(state, base,
               catalogs: [wrong_json],
               histories: [space_history, thread_b_history]
             )

    new_catalog = %{wrong_catalog | entries: move_routes(wrong_catalog.entries, "new-wrong")}
    new_id = TransportCatalog.catalog_id(new_catalog)

    assert %{kind: :retain_blocked, reason: :catalog_fork, next: unchanged, routes: []} =
             evaluate(frozen, base,
               catalogs: [json(new_catalog, candidate.space.catalog)],
               histories: [space_history, thread_b_history]
             )

    refute Enum.any?(unchanged.catalogs, &(&1.id == new_id))
    assert unchanged.catalogs == frozen.catalogs
  end

  test "twelve Threads retain all thirteen routes while a signed fourteenth entry refuses" do
    fixture = CatalogTrustVectors.fixture(12)
    prepared = prepared(fixture)

    assert %{kind: :propose, reason: nil, routes: routes} =
             evaluate(prepared, fixture,
               catalogs: [fixture.catalog_json],
               histories: fixture.histories
             )

    assert length(routes) == 13
    extra = List.last(fixture.catalog.entries)
    invalid = %{fixture.catalog | entries: fixture.catalog.entries ++ [extra]}

    signature =
      Identity.sign(
        fixture.space.catalog,
        Canonical.term(["lattice-treehouse-transport-catalog-v1", invalid])
      )

    assert %{kind: :reject, reason: :malformed_catalog} =
             evaluate(prepared, fixture,
               catalogs: [
                 CatalogTrustVectors.artifact_json(%{catalog: invalid, signature: signature})
               ],
               histories: fixture.histories
             )
  end

  test "route reservations include every complete retained catalog branch" do
    fixture = CatalogTrustVectors.fixture()
    first = installed(fixture)
    previous = first.accepted.catalog

    moved = %{
      fixture.catalog
      | revision: 1,
        previous: previous,
        entries: move_routes(fixture.catalog.entries, "moved")
    }

    %{kind: :propose, next: second} =
      evaluate(first, fixture, catalogs: [json(moved, fixture.space.catalog)])

    [space, thread] = fixture.catalog.entries

    reused =
      Enum.map(moved.entries, fn entry ->
        if entry.replica == thread.replica, do: %{entry | route: space.route}, else: entry
      end)

    invalid = %{fixture.catalog | revision: 2, previous: second.accepted.catalog, entries: reused}

    assert %{kind: :reject, reason: :invalid_catalog_transition} =
             evaluate(second, fixture, catalogs: [json(invalid, fixture.space.catalog)])
  end

  test "corrupt saved history, cutoff proof, watermark and rotation all require recovery" do
    fixture = CatalogTrustVectors.fixture()
    state = installed(fixture)
    [space_history | rest] = state.histories
    [frame | frames] = space_history.frames
    corrupt_frame = %{frame | "sig" => Base.encode64(<<0::512>>)}

    assert %{kind: :reject, reason: :trust_recovery_required} =
             evaluate(
               %{state | histories: [%{space_history | frames: [corrupt_frame | frames]} | rest]},
               fixture
             )

    assert %{kind: :reject, reason: :trust_recovery_required} =
             evaluate(
               %{state | histories: [%{space_history | frames: [corrupt_frame | frames]} | rest]},
               fixture,
               catalogs: [123]
             )

    assert %{kind: :reject, reason: :trust_recovery_required} =
             evaluate(%{state | accepted: %{state.accepted | revision: 9}}, fixture)

    rotation_id = TransportCatalog.rotation_id(fixture.rotation_envelope)
    rotated = %{fixture.catalog | binding: rotation_id}

    %{kind: :propose, next: rotated_state} =
      evaluate(state, fixture,
        rotations: [fixture.rotation_json],
        catalogs: [json(rotated, fixture.next_catalog)],
        cutoff_proofs: fixture.cutoff_proofs
      )

    [proof | proofs] = rotated_state.cutoff_proofs

    assert %{kind: :reject, reason: :trust_recovery_required} =
             evaluate(%{rotated_state | cutoff_proofs: [proof, proof]}, fixture)

    corrupt_proof = %{
      proof
      | cutoff: %{proof.cutoff | log_digest: CatalogTrustVectors.id("corrupt-proof")}
    }

    assert %{kind: :reject, reason: :trust_recovery_required} =
             evaluate(
               %{
                 rotated_state
                 | cutoff_proofs:
                     [corrupt_proof | proofs]
                     |> Enum.sort_by(&{&1.cutoff.replica, &1.cutoff.log_digest})
               },
               fixture
             )

    [rotation] = rotated_state.rotations
    {:ok, raw} = Jason.decode(rotation.json)
    {:ok, envelope} = Wire.decode_value(raw)

    corrupt_rotation = %{
      rotation
      | json: CatalogTrustVectors.artifact_json(%{envelope | old_signature: <<0::512>>})
    }

    assert %{kind: :reject, reason: :trust_recovery_required} =
             evaluate(%{rotated_state | rotations: [corrupt_rotation]}, fixture)
  end

  defp installed(fixture) do
    prepared = prepared(fixture)

    %{kind: :propose, next: installed} =
      evaluate(prepared, fixture, catalogs: [fixture.catalog_json], histories: fixture.histories)

    installed
  end

  defp prepared(fixture) do
    %{kind: :propose, next: prepared} =
      CatalogTrust.prepare_installation(%{
        review: fixture.review,
        history: hd(fixture.histories),
        store: %{kind: :verified_fresh, expected: @expected}
      })

    prepared
  end

  defp catalog_chain(fixture, count) do
    {records, latest, _previous} =
      Enum.reduce(0..(count - 1), {[], nil, nil}, fn revision, {records, _latest, previous} ->
        catalog = %{fixture.catalog | revision: revision, previous: previous}
        id = TransportCatalog.catalog_id(catalog)
        record = %{id: id, json: json(catalog, fixture.space.catalog)}

        {[record | records],
         %{binding: fixture.space.bootstrap.id, generation: 0, catalog: id, revision: revision},
         id}
      end)

    {Enum.sort_by(records, & &1.id), latest, count}
  end

  defp evaluate(state, _fixture, incoming \\ []) do
    incoming = Map.new(incoming)

    CatalogTrust.evaluate(%{
      installed: state,
      expected: @expected,
      incoming: %{
        catalogs: Map.get(incoming, :catalogs, []),
        rotations: Map.get(incoming, :rotations, []),
        histories: Map.get(incoming, :histories, []),
        cutoff_proofs: Map.get(incoming, :cutoff_proofs, [])
      }
    })
  end

  defp move_routes(entries, label),
    do:
      Enum.map(entries, &%{&1 | route: "/r/" <> CatalogTrustVectors.id("#{label}:#{&1.replica}")})

  defp json(catalog, signer),
    do: catalog |> CatalogTrustVectors.sign_catalog(signer) |> CatalogTrustVectors.artifact_json()

  defp empty, do: %{catalogs: [], rotations: [], histories: [], cutoff_proofs: []}

  defp refusing_transfer(fixture) do
    Enum.find_value(1..200, fn index ->
      successor = Identity.from_seed("successor", "r11a-beam-trust-successor-#{index}")

      delegation =
        Delegation.new(fixture.space.root, fixture.space.replica, successor.pub,
          parent_id: fixture.space.delegation.id,
          ops: MapSet.to_list(fixture.space.delegation.ops),
          roles: [:admin]
        )

      transfer =
        Op.new(
          fixture.space.root,
          fixture.space.replica,
          [fixture.space.creation.id],
          :authority,
          {:transfer, :admin, delegation, 0}
        )

      log = Log.append!(fixture.space_log, transfer)

      if Map.has_key?(
           Authority.analyze(Treehouse.Space, log).reasons,
           fixture.space.bootstrap.id
         ),
         do: transfer
    end) || flunk("could not construct deterministic concurrent transfer")
  end

  defp refusing_thread_transfer(thread) do
    Enum.find_value(1..200, fn index ->
      successor =
        Identity.from_seed("thread-successor", "r11a-beam-trust-thread-successor-#{index}")

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
        do: transfer
    end) || flunk("could not construct deterministic concurrent Thread transfer")
  end
end
