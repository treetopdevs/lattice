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

  defp catalog(f, binding, revision, previous) do
    catalog = %{
      version: 1,
      product: :treehouse,
      space: f.replica,
      bootstrap: f.bootstrap.id,
      binding: binding,
      revision: revision,
      previous: previous,
      entries: entries(f, f.service.pub)
    }

    %{
      catalog: catalog,
      signature: Identity.sign(f.catalog, TransportCatalog.catalog_bytes(catalog))
    }
  end

  defp rotation(f, parent, generation, old, new, label) do
    attempt = prepared(f)

    rotation = %{
      version: 1,
      product: :treehouse,
      space: f.replica,
      bootstrap: f.bootstrap.id,
      parent: parent,
      prior_catalog: id("prior-" <> label),
      generation: generation,
      new_catalog_key: new.pub,
      nonce: id("rotation-" <> label),
      inventory_digest: attempt.claim.inventory_digest,
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

    # An off-graph parent with a wrong generation omits the honored bootstrap head.
    off_graph = %{
      parents: [unrelated],
      prior_catalogs: [%{binding: unrelated, catalog: nil}],
      generation: 9
    }

    assert {:error, :catalog_fork} =
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
    {t, rotated} = rotation(f, f.bootstrap.id, 1, f.catalog, next, "t")

    assert {:error, :catalog_fork} =
             Space.prepare_replace_catalog(f.space_log, request(f, %{rotations: [rotated]}), %{})

    over_t = %{
      rotations: [rotated],
      parents: [t],
      prior_catalogs: [%{binding: t, catalog: nil}],
      generation: 2
    }

    assert {:ok, attempt} = Space.prepare_replace_catalog(f.space_log, request(f, over_t), %{})
    assert attempt.claim.parents == [t] and attempt.claim.generation == 2

    assert {:error, :invalid_catalog_transition} =
             Space.prepare_replace_catalog(
               f.space_log,
               request(f, %{over_t | generation: 1}),
               %{}
             )

    # Signed by a key that is not the parent binding's, or chained from an unknown node.
    {_, forged} = rotation(f, f.bootstrap.id, 1, f.root, next, "forged")

    assert {:error, :invalid_catalog_signature} =
             Space.prepare_replace_catalog(f.space_log, request(f, %{rotations: [forged]}), %{})

    {_, orphan} = rotation(f, id("unknown-parent"), 1, f.catalog, next, "orphan")

    assert {:error, :trust_pending} =
             Space.prepare_replace_catalog(f.space_log, request(f, %{rotations: [orphan]}), %{})
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
