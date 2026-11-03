defmodule Treehouse.CatalogReplacementAuthoringTest do
  @moduledoc """
  Plan 316 PR 2: `replace_catalog_v1` authoring preflight (row 316).

  Disposable seeded keys over the PR 1 bootstrap history. A root-authored transfer gives the
  nominee a leased `:admin` capability (the grant and the acquisition are one Core op), then a
  root beacon sets epoch 1. A signed result is an authorized proposal, not installed trust.
  """
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Authority.Delegation
  alias Lattice.Carrier.Wire
  alias Treehouse.{CatalogCutoff, CatalogVectors, Space, TransportCatalog}

  # --- fixture --------------------------------------------------------------

  defp id(label),
    do: :crypto.hash(:sha256, "r316-pr2-" <> label) |> Base.url_encode64(padding: false)

  defp fixture(opts \\ []) do
    f = CatalogVectors.bootstrap_history()

    leased =
      Delegation.new(f.root, f.replica, f.nominee.pub,
        parent_id: f.delegation.id,
        ops: [:create_space, :create_thread, :replace_catalog_v1],
        roles: [:admin],
        expires_epoch: 10
      )

    transfer =
      Op.new(f.root, f.replica, Log.frontier(f.log), :authority, {:transfer, :admin, leased, 0})

    log = Log.append!(f.log, transfer)

    {log, beacon} =
      if Keyword.get(opts, :beacon, true) do
        beacon = Op.new(f.root, f.replica, [transfer.id], :authority, {:beacon, 1})
        {Log.append!(log, beacon), beacon}
      else
        {log, nil}
      end

    thread = Authority.bind_replica("replica:treehouse:thread:" <> id("thread"), f.root.pub)
    thread_d = Delegation.genesis(f.root, thread, ops: [:post], roles: [])
    thread_genesis = Op.new(f.root, thread, [], :authority, {:genesis, thread_d, %{}})
    thread_log = Log.append!(Log.new(thread), thread_genesis)
    new_catalog = Identity.from_seed("catalog", "r316-pr2-new-catalog")
    new_service = Identity.from_seed("service", "r316-pr2-new-service")

    Map.merge(f, %{
      leased: leased,
      transfer: transfer,
      beacon: beacon,
      space_log: log,
      thread: thread,
      thread_genesis: thread_genesis,
      thread_log: thread_log,
      new_catalog: new_catalog,
      new_service: new_service
    })
  end

  defp entries(f, service_key) do
    [
      entry(f, f.replica, :space, :treehouse_space_v1, f.genesis.id, f.creation.id, service_key,
        reference: f.bootstrap.id
      ),
      entry(
        f,
        f.thread,
        :thread,
        :treehouse_thread_v1,
        f.thread_genesis.id,
        f.thread_genesis.id,
        service_key,
        reference: id("thread-reference")
      )
    ]
    |> Enum.sort_by(& &1.replica)
  end

  defp entry(f, replica, kind, schema, genesis, creation, service_key, reference: reference) do
    %{
      product: :treehouse,
      replica: replica,
      kind: kind,
      schema: schema,
      root: f.root.pub,
      genesis: genesis,
      creation: creation,
      reference: reference,
      route: "/r/" <> id("route-" <> replica),
      service_id: id("service"),
      service_key: service_key
    }
  end

  defp request(f, overrides \\ %{}) do
    service_key = Map.get(overrides, :new_service_key, f.new_service.pub)

    Map.merge(
      %{
        author: f.nominee.pub,
        nonce: id("nonce"),
        parents: [f.bootstrap.id],
        prior_catalogs: [%{binding: f.bootstrap.id, catalog: nil}],
        generation: 1,
        new_catalog_key: f.new_catalog.pub,
        new_service_id: id("service"),
        new_service_key: service_key,
        new_origin: "wss://replacement-relay.invalid",
        entries: entries(f, service_key),
        replica_logs: %{f.thread => f.thread_log},
        rotations: [],
        catalogs: []
      },
      overrides
    )
  end

  defp spy(identity, label) do
    test = self()

    fn bytes ->
      send(test, {:signed, label})
      Identity.sign(identity, bytes)
    end
  end

  defp possess(f, attempt) do
    %{
      catalog: spy(f.new_catalog, :catalog_possession).(attempt.catalog_possession_bytes),
      service: spy(f.new_service, :service_possession).(attempt.service_possession_bytes)
    }
  end

  defp op_signer(f, before_return \\ fn -> :ok end) do
    sign = spy(f.nominee, :op)

    %{
      pub: f.nominee.pub,
      sign: fn bytes ->
        signature = sign.(bytes)
        before_return.()
        signature
      end
    }
  end

  defp prepared(f, journal \\ %{}) do
    assert {:ok, attempt} = Space.prepare_replace_catalog(f.space_log, request(f), journal)
    attempt
  end

  defp push_bytes(frame), do: byte_size(Jason.encode!(%{"type" => "push", "ops" => [frame]}))

  defp agent(log) do
    {:ok, pid} = start_supervised({Agent, fn -> log end})
    {pid, fn -> Agent.get(pid, & &1) end}
  end

  defp append_to(pid, op), do: Agent.update(pid, &Log.append!(&1, op))

  # --- 1 --------------------------------------------------------------------

  test "catalog_command_too_large before any signature" do
    f = fixture()

    wide =
      Enum.reduce(1..1_500, f.thread_log, fn n, log ->
        Log.append!(
          log,
          Op.new(f.root, f.thread, [f.thread_genesis.id], :command, {:post, ["post #{n}"]})
        )
      end)

    assert length(Log.frontier(wide)) == 1_500

    assert {:error, :catalog_command_too_large} =
             Space.prepare_replace_catalog(
               f.space_log,
               request(f, %{replica_logs: %{f.thread => wide}}),
               %{}
             )

    refute_received {:signed, _}

    # A normally prepared attempt cannot be signed over a widened Thread log.
    attempt = prepared(f)
    possession = possess(f, attempt)
    widened = %{attempt | request: %{attempt.request | replica_logs: %{f.thread => wide}}}

    assert {:error, :stale_verified_state, %{status: :cancelled}} =
             Space.author_replace_catalog(op_signer(f), f.space_log, widened, possession)

    refute_received {:signed, :op}

    # The zero-filled placeholder measures the signed frame byte-exactly.
    placeholder =
      %Op{
        id: "",
        replica: f.replica,
        author: attempt.author,
        deps: attempt.frozen_frontier,
        kind: :command,
        body: {:replace_catalog_v1, [attempt.claim, <<0::512>>, <<0::512>>]},
        cap: attempt.cap,
        sig: <<0::512>>
      }
      |> then(&%{&1 | id: Op.recompute_id(&1)})

    {:ok, placeholder_frame} = Wire.encode_op_checked(placeholder)

    assert {:ok, result} =
             Space.author_replace_catalog(op_signer(f), f.space_log, attempt, possession)

    assert push_bytes(placeholder_frame) == push_bytes(result.frame)
  end

  # --- 2 --------------------------------------------------------------------

  test "catalog_epoch_missing with zero beacons" do
    f = fixture(beacon: false)
    assert Authority.analyze_with_beacon_evidence(Space, f.space_log) |> elem(1) == []

    assert Authority.holder_epoch(Space, f.space_log, :admin) == %{
             holder: f.nominee.pub,
             op_id: f.transfer.id
           }

    assert {:error, :catalog_epoch_missing} =
             Space.prepare_replace_catalog(f.space_log, request(f), %{})

    refute_received {:signed, _}
  end

  # --- 3 --------------------------------------------------------------------

  test "a changed dep, key or cutoff requires new possession bytes" do
    f = fixture()
    attempt = prepared(f)
    possession = possess(f, attempt)

    # (dep) An ordinary honored Space command after the freeze.
    command =
      Op.new(
        f.nominee,
        f.replica,
        Log.frontier(f.space_log),
        :command,
        {:create_thread, [f.thread, "Moved"]},
        cap: f.leased.id
      )

    moved = Log.append!(f.space_log, command)
    assert Authority.analyze(Space, moved).reasons[command.id] == nil

    assert {:error, :stale_verified_state, %{status: :cancelled}} =
             Space.author_replace_catalog(op_signer(f), moved, attempt, possession)

    refute_received {:signed, :op}

    # (key) A swapped new service key is a different claim; the old possession refuses.
    other = Identity.from_seed("service", "r316-pr2-other-service").pub
    swapped = request(f, %{new_service_key: other})
    assert {:ok, rekeyed} = Space.prepare_replace_catalog(f.space_log, swapped, %{})
    refute rekeyed.catalog_possession_bytes == attempt.catalog_possession_bytes

    assert {:error, :invalid_possession, %{status: :cancelled}} =
             Space.author_replace_catalog(op_signer(f), f.space_log, rekeyed, possession)

    refute_received {:signed, :op}

    # (cutoff) An op appended to the Thread log after the freeze.
    post = Op.new(f.root, f.thread, [f.thread_genesis.id], :command, {:post, ["later"]})

    later = %{
      attempt
      | request: put_in(attempt.request.replica_logs[f.thread], Log.append!(f.thread_log, post))
    }

    assert {:error, :stale_verified_state, %{status: :cancelled}} =
             Space.author_replace_catalog(op_signer(f), f.space_log, later, possession)

    refute_received {:signed, :op}

    # New possession bytes need a fresh nonce; the same nonce with a changed claim refuses.
    journal = %{attempt.attempt_id => attempt.journal_entry}

    assert {:ok, fresh} =
             Space.prepare_replace_catalog(moved, %{request(f) | nonce: id("fresh")}, journal)

    refute fresh.catalog_possession_bytes == attempt.catalog_possession_bytes
    refute fresh.service_possession_bytes == attempt.service_possession_bytes

    assert {:error, :attempt_nonce_reused} =
             Space.prepare_replace_catalog(moved, request(f), journal)

    assert {:error, :attempt_nonce_reused} =
             Space.prepare_replace_catalog(f.space_log, swapped, journal)
  end

  # --- 4 --------------------------------------------------------------------

  test "the cutoff excludes the action" do
    f = fixture()
    attempt = prepared(f)
    possession = possess(f, attempt)

    assert {:ok, %{op: op, frame: frame, binding_id: binding_id} = result} =
             Space.author_replace_catalog(op_signer(f), f.space_log, attempt, possession)

    assert_received {:signed, :op}
    [space_cutoff] = Enum.filter(attempt.claim.cutoffs, &(&1.replica == f.replica))
    assert space_cutoff.frontier == op.deps
    assert op.deps == attempt.frozen_frontier

    {:ok, %{cutoff: %{log_digest: digest}}} = CatalogCutoff.derive(f.space_log)
    assert space_cutoff.log_digest == digest
    refute Enum.any?(attempt.claim.cutoffs, &(op.id in &1.frontier))
    assert binding_id == op.id
    assert result.attempt_id == attempt.claim.nonce

    assert result.journal_entry == %{
             attempt_id: attempt.attempt_id,
             claim_bytes: attempt.claim_bytes,
             status: :signed,
             reason: nil,
             op_id: op.id
           }

    assert {:ok, ^op} = Wire.decode_op(frame)
    assert op.author == f.nominee.pub and op.cap == f.leased.id
    assert attempt.claim.holder_epoch == f.transfer.id
    assert attempt.claim.epoch == 1 and attempt.claim.epoch_basis == [f.beacon.id]
    signed = Log.append!(f.space_log, op)
    assert Authority.analyze(Space, signed).reasons[op.id] == nil
    refute MapSet.member?(Authority.quarantine(Space, signed), op.id)
  end

  # --- 5 --------------------------------------------------------------------

  test "authority reclassification of the frozen state cancels the pending attempt before and after the signing call (C13)" do
    f = fixture()

    for label <- [:revoke, :lapse] do
      attempt = prepared(f)
      possession = possess(f, attempt)

      change =
        case label do
          :revoke ->
            Op.new(f.root, f.replica, attempt.frozen_frontier, :authority, {:revoke, f.leased.id})

          :lapse ->
            Op.new(f.root, f.replica, attempt.frozen_frontier, :authority, {:beacon, 11})
        end

      # The Core reason the union assigns to the otherwise-honored action.
      {:ok, %{op: honored}} =
        Space.author_replace_catalog(f.nominee, f.space_log, attempt, possession)

      union = f.space_log |> Log.append!(change) |> Log.append!(honored)

      assert Authority.analyze(Space, union).reasons[honored.id] ==
               %{revoke: :revoked_capability, lapse: :lease_expired}[label]

      # (before) The concurrent change arrives after possession, before the signing call.
      {pid, source} = agent(f.space_log)
      append_to(pid, change)

      assert {:error, :authority_changed, %{status: :cancelled, reason: :authority_changed}} =
               Space.author_replace_catalog(op_signer(f), source, attempt, possession),
             "#{label} before"

      refute_received {:signed, :op}
      stop_supervised!(Agent)

      # (after) The same change lands while the signer runs.
      {pid, source} = agent(f.space_log)
      signer = op_signer(f, fn -> append_to(pid, change) end)

      assert {:error, :authority_changed, entry} =
               Space.author_replace_catalog(signer, source, attempt, possession),
             "#{label} after"

      assert entry.status == :cancelled_after_signature
      assert entry.op_id == nil
      refute Map.has_key?(entry, :frame)
      assert_received {:signed, :op}
      stop_supervised!(Agent)
    end
  end

  # --- 6 --------------------------------------------------------------------

  test "an identical retry under the same nonce is idempotent" do
    f = fixture()
    attempt = prepared(f)
    retry = prepared(f, %{attempt.attempt_id => attempt.journal_entry})
    assert retry.claim_bytes == attempt.claim_bytes
    assert retry.catalog_possession_bytes == attempt.catalog_possession_bytes
    assert retry.journal_entry.status == :awaiting_possession
    assert attempt.attempt_id == attempt.claim.nonce
    assert attempt.cap == f.leased.id and attempt.author == f.nominee.pub

    assert {:ok, first} =
             Space.author_replace_catalog(op_signer(f), f.space_log, attempt, possess(f, attempt))

    assert {:ok, second} =
             Space.author_replace_catalog(f.nominee, f.space_log, retry, possess(f, retry))

    assert first.op.id == second.op.id

    assert {:error, :wrong_signer, %{status: :cancelled}} =
             Space.author_replace_catalog(f.root, f.space_log, attempt, possess(f, attempt))

    assert {:error, :not_holder} =
             Space.prepare_replace_catalog(f.space_log, %{request(f) | author: f.root.pub}, %{})
  end

  # --- 7 --------------------------------------------------------------------

  test "a tampered attempt or a corrupt re-read never yields a frame" do
    f = fixture()
    attempt = prepared(f)

    # A caller-held claim that differs from the fresh derivation, with matching possessions.
    claim = %{attempt.claim | new_origin: "wss://attacker.invalid"}

    tampered = %{
      attempt
      | claim: claim,
        catalog_possession_bytes:
          Treehouse.TransportCatalog.replacement_possession_bytes(:catalog, claim),
        service_possession_bytes:
          Treehouse.TransportCatalog.replacement_possession_bytes(:service, claim)
    }

    assert {:error, :stale_verified_state, %{status: :cancelled}} =
             Space.author_replace_catalog(
               op_signer(f),
               f.space_log,
               tampered,
               possess(f, tampered)
             )

    refute_received {:signed, :op}

    # A re-read after the signing call that fails authentication withholds the frame.
    {pid, source} = agent(f.space_log)

    corrupt = fn ->
      Agent.update(pid, fn log -> %{log | ops: Map.put(log.ops, "forged", f.genesis)} end)
    end

    assert {:error, :invalid_verified_history, %{status: :cancelled_after_signature, op_id: nil}} =
             Space.author_replace_catalog(
               op_signer(f, corrupt),
               source,
               attempt,
               possess(f, attempt)
             )

    assert_received {:signed, :op}
  end

  # --- 8: review round 1 ----------------------------------------------------

  test "an honored Space command appended during signing withholds the stale frame" do
    f = fixture()
    attempt = prepared(f)
    possession = possess(f, attempt)

    command =
      Op.new(
        f.nominee,
        f.replica,
        attempt.frozen_frontier,
        :command,
        {:create_thread, [f.thread, "Moved"]},
        cap: f.leased.id
      )

    {pid, source} = agent(f.space_log)
    signer = op_signer(f, fn -> append_to(pid, command) end)

    assert {:error, :stale_verified_state, %{status: :cancelled_after_signature, op_id: nil}} =
             Space.author_replace_catalog(signer, source, attempt, possession)

    assert_received {:signed, :op}
    assert Authority.analyze(Space, source.()).reasons[command.id] == nil
  end

  test "a corrupt history refuses preparation instead of raising" do
    f = fixture()
    corrupt = %Log{replica: "replica:x", ops: nil}

    assert {:error, :invalid_verified_history} =
             Space.prepare_replace_catalog(corrupt, request(f), %{})

    assert {:error, :invalid_verified_history} =
             Space.prepare_replace_catalog(%{f.space_log | ops: nil}, request(f), %{})
  end

  defp catalog(f, binding, revision, previous, entries \\ nil) do
    catalog = %{
      version: 1,
      product: :treehouse,
      space: f.replica,
      bootstrap: f.bootstrap.id,
      binding: binding,
      revision: revision,
      previous: previous,
      entries: entries || bound_entries(f)
    }

    %{
      catalog: catalog,
      signature: Identity.sign(f.catalog, TransportCatalog.catalog_bytes(catalog))
    }
  end

  # Catalog entries under the bootstrap binding carry the bootstrap's own service pair.
  defp bound_entries(f) do
    for entry <- entries(f, f.service.pub), do: %{entry | service_id: f.record.service_id}
  end

  defp rotation(f, parent, generation, old, new, label, prior \\ nil) do
    attempt = prepared(f)

    prior_catalog =
      if prior, do: TransportCatalog.catalog_id(prior.catalog), else: id("prior-" <> label)

    inventory =
      if prior,
        do: TransportCatalog.inventory_id(prior.catalog.entries),
        else: attempt.claim.inventory_digest

    rotation = %{
      version: 1,
      product: :treehouse,
      space: f.replica,
      bootstrap: f.bootstrap.id,
      parent: parent,
      prior_catalog: prior_catalog,
      generation: generation,
      new_catalog_key: new.pub,
      nonce: id("rotation-" <> label),
      inventory_digest: inventory,
      cutoffs: attempt.claim.cutoffs
    }

    envelope = %{
      rotation: rotation,
      old_signature: Identity.sign(old, TransportCatalog.rotation_bytes(rotation)),
      new_signature: Identity.sign(new, TransportCatalog.rotation_possession_bytes(rotation))
    }

    {TransportCatalog.rotation_id(envelope), envelope}
  end

  test "parents, prior_catalogs and generation are checked against the binding graph" do
    f = fixture()
    unrelated = id("unrelated-binding")

    # An off-graph parent with a wrong generation is an intrinsic transition failure.
    off_graph = %{
      parents: [unrelated],
      prior_catalogs: [%{binding: unrelated, catalog: nil}],
      generation: 9
    }

    assert {:error, :invalid_catalog_transition} =
             Space.prepare_replace_catalog(f.space_log, request(f, off_graph), %{})

    both = %{
      parents: Enum.sort([f.bootstrap.id, unrelated]),
      prior_catalogs:
        Enum.sort([
          %{binding: f.bootstrap.id, catalog: nil},
          %{binding: unrelated, catalog: nil}
        ])
    }

    assert {:error, :invalid_catalog_transition} =
             Space.prepare_replace_catalog(f.space_log, request(f, both), %{})

    assert {:error, :invalid_catalog_transition} =
             Space.prepare_replace_catalog(f.space_log, request(f, %{generation: 9}), %{})

    # A retained catalog under the bootstrap must be cited; `nil` would drop it.
    first = catalog(f, f.bootstrap.id, 0, nil)
    first_id = TransportCatalog.catalog_id(first.catalog)

    assert {:error, :catalog_fork} =
             Space.prepare_replace_catalog(f.space_log, request(f, %{catalogs: [first]}), %{})

    cited = %{catalogs: [first], prior_catalogs: [%{binding: f.bootstrap.id, catalog: first_id}]}

    # Citing a catalog that is not held is pending trust, not a valid prior.
    assert {:error, :trust_pending} =
             Space.prepare_replace_catalog(f.space_log, request(f, %{cited | catalogs: []}), %{})

    assert {:ok, _} = Space.prepare_replace_catalog(f.space_log, request(f, cited), %{})

    # Its successor supersedes it as the head under the same binding.
    second = catalog(f, f.bootstrap.id, 1, first_id)
    second_id = TransportCatalog.catalog_id(second.catalog)

    assert {:error, :catalog_fork} =
             Space.prepare_replace_catalog(
               f.space_log,
               request(f, %{cited | catalogs: [first, second]}),
               %{}
             )

    assert {:ok, _} =
             Space.prepare_replace_catalog(
               f.space_log,
               request(f, %{
                 catalogs: [second, first],
                 prior_catalogs: [%{binding: f.bootstrap.id, catalog: second_id}]
               }),
               %{}
             )

    forged = %{
      first
      | signature: Identity.sign(f.root, TransportCatalog.catalog_bytes(first.catalog))
    }

    assert {:error, :invalid_catalog_signature} =
             Space.prepare_replace_catalog(f.space_log, request(f, %{catalogs: [forged]}), %{})

    refute_received {:signed, :op}
  end

  test "a retained rotation advances the head the replacement must cite" do
    f = fixture()
    next = Identity.from_seed("catalog", "r316-pr2-rotated-catalog")
    prior = catalog(f, f.bootstrap.id, 0, nil)
    {t, rotated} = rotation(f, f.bootstrap.id, 1, f.catalog, next, "t", prior)
    retained = %{rotations: [rotated], catalogs: [prior]}

    assert {:error, :catalog_fork} =
             Space.prepare_replace_catalog(f.space_log, request(f, retained), %{})

    over_t =
      Map.merge(retained, %{
        parents: [t],
        prior_catalogs: [%{binding: t, catalog: nil}],
        generation: 2
      })

    assert {:ok, attempt} = Space.prepare_replace_catalog(f.space_log, request(f, over_t), %{})
    assert attempt.claim.parents == [t] and attempt.claim.generation == 2

    assert {:error, :invalid_catalog_transition} =
             Space.prepare_replace_catalog(
               f.space_log,
               request(f, %{over_t | generation: 1}),
               %{}
             )

    # Signed by a key that is not the parent binding's, or chained from an unknown node.
    {_, forged} = rotation(f, f.bootstrap.id, 1, f.root, next, "forged", prior)

    assert {:error, :invalid_catalog_signature} =
             Space.prepare_replace_catalog(
               f.space_log,
               request(f, %{retained | rotations: [forged]}),
               %{}
             )

    {_, orphan} = rotation(f, id("unknown-parent"), 1, f.catalog, next, "orphan", prior)

    assert {:error, :trust_pending} =
             Space.prepare_replace_catalog(
               f.space_log,
               request(f, %{retained | rotations: [orphan]}),
               %{}
             )
  end

  # Review thread (P1, :318): a correctly signed rotation is not a binding node until it
  # resolves under the Stage B structural rules; otherwise the preflight refuses rather than
  # require a replacement to cite it.
  test "a signed rotation that Stage B would reject never becomes a head to sign over" do
    f = fixture()
    next = Identity.from_seed("catalog", "r316-pr2-hostile-rotation")
    prior = catalog(f, f.bootstrap.id, 0, nil)

    over = fn {t, rotation}, catalogs ->
      request(f, %{
        rotations: [rotation],
        catalogs: catalogs,
        parents: [t],
        prior_catalogs: [%{binding: t, catalog: nil}],
        generation: 2
      })
    end

    # Its prior catalog is not retained: pending, never a head.
    missing = rotation(f, f.bootstrap.id, 1, f.catalog, next, "missing-prior")

    assert {:error, :trust_pending} =
             Space.prepare_replace_catalog(f.space_log, over.(missing, []), %{})

    # Inventory digest disagrees with the prior catalog it names.
    {t, honest} = rotation(f, f.bootstrap.id, 1, f.catalog, next, "drift", prior)
    drifted = put_in(honest.rotation.inventory_digest, id("other-inventory"))
    drifted = resign_rotation(drifted, f.catalog, next)

    assert {:error, :invalid_catalog_transition} =
             Space.prepare_replace_catalog(
               f.space_log,
               over.({TransportCatalog.rotation_id(drifted), drifted}, [prior]),
               %{}
             )

    # The new catalog key is the binding's service key.
    {_, as_service} = rotation(f, f.bootstrap.id, 1, f.catalog, f.service, "service", prior)

    assert {:error, :invalid_catalog_transition} =
             Space.prepare_replace_catalog(
               f.space_log,
               over.({TransportCatalog.rotation_id(as_service), as_service}, [prior]),
               %{}
             )

    # A second rotation whose prior catalog sits under the grandparent, not its parent.
    later = Identity.from_seed("catalog", "r316-pr2-hostile-rotation-2")
    {t2, crossed} = rotation(f, t, 2, next, later, "crossed", prior)

    assert {:error, :invalid_catalog_transition} =
             Space.prepare_replace_catalog(
               f.space_log,
               request(f, %{
                 rotations: [honest, crossed],
                 catalogs: [prior],
                 parents: [t2],
                 prior_catalogs: [%{binding: t2, catalog: nil}],
                 generation: 3
               }),
               %{}
             )

    refute_received {:signed, :op}
  end

  # Review thread (P1, :413): a signed catalog is held, and may be a head, only once its chain
  # and binding semantics resolve.
  test "a signed catalog whose chain Stage B would reject never becomes a held head" do
    f = fixture()
    first = catalog(f, f.bootstrap.id, 0, nil)
    first_id = TransportCatalog.catalog_id(first.catalog)

    cite = fn catalogs, head ->
      request(f, %{
        catalogs: catalogs,
        prior_catalogs: [%{binding: f.bootstrap.id, catalog: head}]
      })
    end

    # `previous` names a catalog that is not retained.
    dangling = catalog(f, f.bootstrap.id, 1, id("absent-previous"))
    dangling_id = TransportCatalog.catalog_id(dangling.catalog)

    assert {:error, :trust_pending} =
             Space.prepare_replace_catalog(f.space_log, cite.([dangling], dangling_id), %{})

    # A revision that does not step by one.
    skipped = catalog(f, f.bootstrap.id, 5, first_id)

    assert {:error, :invalid_catalog_transition} =
             Space.prepare_replace_catalog(
               f.space_log,
               cite.([first, skipped], TransportCatalog.catalog_id(skipped.catalog)),
               %{}
             )

    # A successor that drops a retained replica does not extend the inventory.
    shrunk = catalog(f, f.bootstrap.id, 1, first_id, Enum.take(bound_entries(f), 1))

    assert {:error, :invalid_catalog_transition} =
             Space.prepare_replace_catalog(
               f.space_log,
               cite.([first, shrunk], TransportCatalog.catalog_id(shrunk.catalog)),
               %{}
             )

    # Entries served by a credential other than the binding's.
    stranger = catalog(f, f.bootstrap.id, 0, nil, entries(f, f.service.pub))

    assert {:error, :wrong_catalog_scope} =
             Space.prepare_replace_catalog(
               f.space_log,
               cite.([stranger], TransportCatalog.catalog_id(stranger.catalog)),
               %{}
             )

    refute_received {:signed, :op}
  end

  # Review thread (P2, :82): the caller-owned journal may be lost or belong to another device.
  test "a nonce already carried by a retained replacement is reused even with an empty journal" do
    f = fixture()
    attempt = prepared(f)

    {:ok, %{op: r1}} =
      Space.author_replace_catalog(op_signer(f), f.space_log, attempt, possess(f, attempt))

    log = Log.append!(f.space_log, r1)

    reused = %{
      parents: [r1.id],
      prior_catalogs: [%{binding: r1.id, catalog: nil}],
      generation: 2,
      new_catalog_key: Identity.from_seed("catalog", "r316-pr2-nonce-reuse").pub
    }

    assert {:error, :attempt_nonce_reused} =
             Space.prepare_replace_catalog(log, request(f, reused), %{})

    assert {:ok, _} =
             Space.prepare_replace_catalog(
               log,
               request(f, Map.put(reused, :nonce, id("fresh"))),
               %{}
             )
  end

  # Review thread (P2, TS :329) twin: replica sets compare in UTF-8 byte order on both sides.
  test "non-ASCII thread replicas order by UTF-8 bytes on both sides of the recovery check" do
    f = fixture()
    service_key = f.new_service.pub
    [space] = Enum.filter(entries(f, service_key), &(&1.kind == :space))

    threads =
      for suffix <- ["\u{E000}", "\u{10000}"] do
        replica = Authority.bind_replica("replica:treehouse:thread:" <> suffix, f.root.pub)
        d = Delegation.genesis(f.root, replica, ops: [:post], roles: [])
        genesis = Op.new(f.root, replica, [], :authority, {:genesis, d, %{}})
        {replica, genesis}
      end

    thread_entries =
      for {replica, genesis} <- threads do
        %{
          space
          | replica: replica,
            kind: :thread,
            schema: :treehouse_thread_v1,
            genesis: genesis.id,
            creation: genesis.id,
            reference: id("reference-" <> replica),
            route: "/r/" <> id("route-" <> replica)
        }
      end

    all = Enum.sort_by([space | thread_entries], & &1.replica)

    logs =
      Map.new(threads, fn {replica, genesis} ->
        {replica, Log.append!(Log.new(replica), genesis)}
      end)

    assert {:ok, attempt} =
             Space.prepare_replace_catalog(
               f.space_log,
               request(f, %{entries: all, replica_logs: logs}),
               %{}
             )

    assert Enum.map(attempt.claim.cutoffs, & &1.replica) == Enum.map(all, & &1.replica)
  end

  # Codex round 4: route reservation, duplicate-id signatures, nonce eligibility, signature shape.
  test "retained catalogs that swap routes, or hide a bad signature behind a good copy, refuse" do
    f = fixture()
    first = catalog(f, f.bootstrap.id, 0, nil)
    first_id = TransportCatalog.catalog_id(first.catalog)

    cite = fn catalogs, head ->
      request(f, %{
        catalogs: catalogs,
        prior_catalogs: [%{binding: f.bootstrap.id, catalog: head}]
      })
    end

    [a, b] = bound_entries(f)

    swapped =
      catalog(f, f.bootstrap.id, 1, first_id, [%{a | route: b.route}, %{b | route: a.route}])

    assert {:error, :invalid_catalog_transition} =
             Space.prepare_replace_catalog(
               f.space_log,
               cite.([first, swapped], TransportCatalog.catalog_id(swapped.catalog)),
               %{}
             )

    bad = %{first | signature: :binary.copy(<<7>>, 64)}

    for order <- [[bad, first], [first, bad]] do
      assert {:error, :invalid_catalog_signature} =
               Space.prepare_replace_catalog(f.space_log, cite.(order, first_id), %{})
    end

    assert {:error, :malformed_catalog} =
             Space.prepare_replace_catalog(
               f.space_log,
               cite.([%{first | signature: <<1>>}], first_id),
               %{}
             )

    # Round 5: like `CatalogTrust`, any differing copy for one id refuses at parse, before any
    # verification, so a second valid signature cannot pass either. Under an unknown binding
    # (otherwise `trust_pending`) the parse-time refusal is observable.
    orphan = catalog(f, id("unknown-binding"), 0, nil)
    orphan_id = TransportCatalog.catalog_id(orphan.catalog)
    other = %{orphan | signature: other_signature(orphan.signature)}

    assert {:error, :trust_pending} =
             Space.prepare_replace_catalog(f.space_log, cite.([orphan], orphan_id), %{})

    for order <- [[orphan, other], [other, orphan]] do
      assert {:error, :invalid_catalog_signature} =
               Space.prepare_replace_catalog(f.space_log, cite.(order, orphan_id), %{})
    end
  end

  test "an unauthorized retained proposal does not reserve the nonce" do
    f = fixture()
    attempt = prepared(f)
    stranger = Identity.from_seed("stranger", "r316-pr2-stranger")

    raw =
      Op.new(
        stranger,
        f.replica,
        Log.frontier(f.space_log),
        :command,
        {:replace_catalog_v1, [attempt.claim, <<0::512>>, <<0::512>>]}
      )

    log = Log.append!(f.space_log, raw)
    assert Authority.analyze(Space, log).reasons[raw.id] != nil
    assert {:ok, _} = Space.prepare_replace_catalog(log, request(f), %{})
  end

  # Review round 6: Space entry binding, service-ID rotation, prior-catalog extension, budget.
  test "the proposed entries and service pair must be ones Stage B can accept" do
    f = fixture()

    rebound =
      for entry <- entries(f, f.new_service.pub) do
        if entry.kind == :space, do: %{entry | reference: id("not-the-bootstrap")}, else: entry
      end

    assert {:error, :application_invalid_catalog} =
             Space.prepare_replace_catalog(f.space_log, request(f, %{entries: rebound}), %{})

    # A new service key under the parent's service ID.
    reused_id =
      for entry <- entries(f, f.new_service.pub), do: %{entry | service_id: f.record.service_id}

    assert {:error, :invalid_catalog_transition} =
             Space.prepare_replace_catalog(
               f.space_log,
               request(f, %{new_service_id: f.record.service_id, entries: reused_id}),
               %{}
             )

    # Keeping the parent's whole service pair is allowed (OD-15).
    kept =
      for entry <- entries(f, f.service.pub), do: %{entry | service_id: f.record.service_id}

    assert {:ok, _} =
             Space.prepare_replace_catalog(
               f.space_log,
               request(f, %{
                 new_service_id: f.record.service_id,
                 new_service_key: f.service.pub,
                 entries: kept
               }),
               %{}
             )

    # Entries that change an immutable field of the cited prior catalog.
    first = catalog(f, f.bootstrap.id, 0, nil)
    first_id = TransportCatalog.catalog_id(first.catalog)
    cited = %{catalogs: [first], prior_catalogs: [%{binding: f.bootstrap.id, catalog: first_id}]}
    assert {:ok, _} = Space.prepare_replace_catalog(f.space_log, request(f, cited), %{})

    drifted =
      for entry <- entries(f, f.new_service.pub) do
        if entry.kind == :thread, do: %{entry | reference: id("other-reference")}, else: entry
      end

    assert {:error, :invalid_catalog_transition} =
             Space.prepare_replace_catalog(
               f.space_log,
               request(f, Map.put(cited, :entries, drifted)),
               %{}
             )

    assert {:error, :control_history_limit} =
             Space.prepare_replace_catalog(
               f.space_log,
               request(f, %{catalogs: List.duplicate(first, 1_025)}),
               %{}
             )
  end

  # Review round 7: plan 316 §3 step 4 acquisition predicates and the current profile pin.
  test "an acquisition Stage B would refuse is never signed over" do
    f = fixture()

    beacon = fn log ->
      Log.append!(log, Op.new(f.root, f.replica, Log.frontier(log), :authority, {:beacon, 1}))
    end

    # The root holds :admin through its live, unleased genesis capability.
    rooted = beacon.(f.log)

    assert {:error, :catalog_authority_refused} =
             Space.prepare_replace_catalog(rooted, request(f, %{author: f.root.pub}), %{})

    for opts <- [[], [live: true, expires_epoch: 10]] do
      d =
        Delegation.new(
          f.root,
          f.replica,
          f.nominee.pub,
          [
            parent_id: f.delegation.id,
            ops: [:create_space, :create_thread, :replace_catalog_v1],
            roles: [:admin]
          ] ++ opts
        )

      transfer =
        Op.new(f.root, f.replica, Log.frontier(f.log), :authority, {:transfer, :admin, d, 0})

      log = beacon.(Log.append!(f.log, transfer))
      assert Authority.holder_epoch(Space, log, :admin).holder == f.nominee.pub

      assert {:error, :catalog_authority_refused} =
               Space.prepare_replace_catalog(log, request(f), %{})
    end
  end

  test "a bootstrap honored under an earlier continuation pin lends no stale profile fields" do
    f = fixture()
    empty = Delegation.genesis(f.root, f.replica, ops: [], roles: [], live: false)
    profile = %{f.profile | max_lease_epochs: 6}

    repin =
      Op.new(
        f.root,
        f.replica,
        Log.frontier(f.space_log),
        :authority,
        {:genesis, empty, %{__continuation__: profile}}
      )

    log = Log.append!(f.space_log, repin)
    assert {:ok, %{profile_genesis: genesis}} = Authority.continuation_profile(log)
    assert genesis != f.record.profile_genesis

    assert {:error, :wrong_catalog_scope} = Space.prepare_replace_catalog(log, request(f), %{})
  end

  defp other_signature(<<r::binary-32, _s::binary-32>>), do: r <> :binary.copy(<<9>>, 32)

  defp resign_rotation(envelope, old, new) do
    %{
      envelope
      | old_signature: Identity.sign(old, TransportCatalog.rotation_bytes(envelope.rotation)),
        new_signature:
          Identity.sign(new, TransportCatalog.rotation_possession_bytes(envelope.rotation))
    }
  end

  test "an appended replacement is a head a later replacement must cite (D-276)" do
    f = fixture()
    attempt = prepared(f)

    {:ok, %{op: r1}} =
      Space.author_replace_catalog(op_signer(f), f.space_log, attempt, possess(f, attempt))

    log = Log.append!(f.space_log, r1)
    assert Authority.analyze(Space, log).reasons[r1.id] == nil

    assert {:error, :catalog_fork} =
             Space.prepare_replace_catalog(log, request(f, %{nonce: id("r2")}), %{})

    second_key = Identity.from_seed("catalog", "r316-pr2-second-catalog").pub

    r2 = %{
      nonce: id("r2"),
      new_catalog_key: second_key,
      parents: [r1.id],
      prior_catalogs: [%{binding: r1.id, catalog: nil}],
      generation: 2
    }

    assert {:ok, prepared_r2} = Space.prepare_replace_catalog(log, request(f, r2), %{})
    assert prepared_r2.claim.parents == [r1.id]

    # A concurrent revoke refuses R1 on the union but leaves it a binding node.
    revoke =
      Op.new(f.root, f.replica, attempt.frozen_frontier, :authority, {:revoke, f.leased.id})

    revoked = Log.append!(log, revoke)
    assert Authority.analyze(Space, revoked).reasons[r1.id] == :revoked_capability

    assert {:error, :catalog_fork} =
             Space.prepare_replace_catalog(revoked, request(f, %{nonce: id("r2")}), %{})
  end
end
