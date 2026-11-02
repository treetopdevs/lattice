defmodule Treehouse.CatalogReplacementAuthoring do
  @moduledoc """
  `replace_catalog_v1` authoring preflight (plan 316 PR 2): freeze, derive, review, sign last.

  `prepare/3` freezes the Space frontier and derives the authority and recovery claim fields
  from the authenticated judged history: the honored bootstrap, the current `:admin` holder and
  its acquisition capability, the beacon epoch basis, the route inventory and the recovery
  cutoffs. The caller-chosen `parents`, `prior_catalogs` and `generation` are checked, not
  derived: against the binding graph built from the honored bootstrap, the caller's retained
  `rotations` and `catalogs` (verified here) and every on-Space replacement honored at its
  strict prefix (D-276), `parents` must equal the current heads, `prior_catalogs` every
  retained catalog head under each parent (D-271), and `generation` the maximum parent
  generation plus one. It signs nothing. The caller collects the two new-key possession signatures over
  the returned bytes, then `author/4` re-reads the log, refuses a reclassified frozen state
  (`authority_changed`) or any moved claim input (`stale_verified_state`), verifies both
  possessions, preflights the exact candidate on the full judge and signs once.

  Unsigned intents are private full-judge inputs only; they are never appended or exported.
  A Core-honored result is an authorized signed proposal, not a route switch or installed
  catalog trust: the Stage B resolver (PR 4) and the operator journal (lifecycle §5) remain
  the caller's. The returned journal entry is caller-owned and is not persisted here.
  """

  alias Lattice.{Authority, Dag, Identity, Log, Op}
  alias Lattice.Carrier.Wire
  alias Treehouse.{CatalogBootstrap, CatalogCutoff, MemberContinuityAuthoring, Space}
  alias Treehouse.TransportCatalog

  @request_fields ~w(author nonce parents prior_catalogs generation new_catalog_key new_service_id new_service_key new_origin entries replica_logs rotations catalogs)a
  @attempt_fields ~w(attempt_id request claim claim_bytes catalog_possession_bytes service_possession_bytes author cap frozen_frontier)a
  @zero <<0::512>>

  @spec prepare(Log.t(), map(), map()) :: {:ok, map()} | {:error, atom()}
  def prepare(log, request, journal) do
    if is_map(journal) do
      with {:ok, attempt} <- derive(log, request, journal) do
        {:ok, Map.put(attempt, :journal_entry, entry(attempt, :awaiting_possession, nil, nil))}
      end
    else
      {:error, :application_invalid_catalog}
    end
  end

  @spec author(Identity.t() | map(), Log.t() | (-> Log.t()), map(), map()) ::
          {:ok, map()} | {:error, atom(), map()}
  def author(signer, log_source, attempt, possession) do
    with {:ok, attempt} <- attempt_shape(attempt) do
      case presign(signer, log_source, attempt, possession) do
        {:ok, sign, candidate} -> sign_last(sign, log_source, attempt, candidate)
        {:error, reason} -> {:error, reason, entry(attempt, :cancelled, reason, nil)}
      end
    else
      {:error, reason} -> {:error, reason, entry(nil, :cancelled, reason, nil)}
    end
  end

  # --- prepare ----------------------------------------------------------------

  defp derive(log, request, journal) do
    with :ok <- request_shape(request),
         %Log{} <- log,
         :ok <- authentic(log),
         deps = Log.frontier(log),
         {:ok, bootstrap} <- bootstrap(log),
         {:ok, author, holder_epoch, cap} <- holder(log, request.author),
         {:ok, epoch, basis} <- epoch(log),
         {:ok, inventory} <- inventory(log, request),
         {:ok, cutoffs} <- cutoffs(log, request),
         {:ok, claim} <-
           claim(log, request, bootstrap, {author, holder_epoch, cap}, {epoch, basis}, deps,
             inventory: inventory,
             cutoffs: cutoffs
           ),
         :ok <- coverage(log, claim, request, bootstrap),
         claim_bytes = TransportCatalog.replacement_claim_bytes(claim),
         :ok <- nonce_free(journal, claim.nonce, claim_bytes),
         candidate = intent(claim, @zero, @zero),
         :ok <- envelope(candidate),
         :ok <- review_preflight(log, candidate) do
      {:ok,
       %{
         attempt_id: claim.nonce,
         status: :awaiting_possession,
         request: request,
         claim: claim,
         claim_bytes: claim_bytes,
         catalog_possession_bytes: TransportCatalog.replacement_possession_bytes(:catalog, claim),
         service_possession_bytes: TransportCatalog.replacement_possession_bytes(:service, claim),
         author: author,
         cap: cap,
         frozen_frontier: deps
       }}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :application_invalid_catalog}
    end
  end

  defp request_shape(request) when is_map(request) do
    if Enum.sort(Map.keys(request)) == Enum.sort(@request_fields) and key?(request.author) and
         is_list(request.entries) and is_map(request.replica_logs) and
         is_list(request.rotations) and is_list(request.catalogs) and
         Enum.all?(request.replica_logs, fn {replica, log} ->
           is_binary(replica) and match?(%Log{}, log)
         end),
       do: :ok,
       else: {:error, :application_invalid_catalog}
  end

  defp request_shape(_), do: {:error, :application_invalid_catalog}

  # Authenticate before any structural read, so a corrupt history refuses instead of raising.
  defp authentic(log) do
    if Log.verify_authenticity(log) == :ok, do: :ok, else: {:error, :invalid_verified_history}
  rescue
    _ -> {:error, :invalid_verified_history}
  end

  # The one honored bootstrap. None, or a competing set this preflight does not resolve
  # (D-275 closing is the resolver's), refuses with the Stage A reason.
  defp bootstrap(log) do
    case CatalogBootstrap.observe(log) do
      {:ok, %{bootstraps: [bootstrap]}} -> {:ok, bootstrap}
      {:ok, _} -> {:error, :application_invalid_catalog}
      {:error, reason} -> {:error, reason}
    end
  end

  # Holder and capability come from the judge only; the caller never supplies either.
  defp holder(log, author) do
    with %{holder: ^author, op_id: holder_epoch} <- Authority.holder_epoch(Space, log, :admin),
         %{delegation_id: cap} <-
           Space |> Authority.acquisitions(log, :admin) |> List.last() |> acquired(holder_epoch) do
      {:ok, author, holder_epoch, cap}
    else
      _ -> {:error, :not_holder}
    end
  end

  defp acquired(%{op_id: op_id} = record, op_id), do: record
  defp acquired(_, _), do: nil

  # Same rule as `MemberContinuityAuthoring.epoch/1`; an out-of-range maximum is the claim
  # codec's `malformed_catalog`.
  defp epoch(log) do
    case Authority.analyze_with_beacon_evidence(Space, log) do
      {_, []} ->
        {:error, :catalog_epoch_missing}

      {_, beacons} ->
        epoch = beacons |> Enum.map(& &1.epoch) |> Enum.max()
        {:ok, epoch, Enum.sort(for %{op_id: id, epoch: ^epoch} <- beacons, do: id)}
    end
  end

  defp inventory(log, request) do
    entries = request.entries

    if Enum.all?(entries, &service_entry?(&1, request)) and
         Enum.any?(entries, &match?(%{kind: :space}, &1)) and
         Enum.all?(entries, &(&1.kind != :space or &1.replica == log.replica)),
       do: {:ok, TransportCatalog.inventory_id(entries)},
       else: {:error, :application_invalid_catalog}
  rescue
    _ -> {:error, :application_invalid_catalog}
  end

  defp service_entry?(entry, request),
    do:
      is_map(entry) and Map.get(entry, :service_id) == request.new_service_id and
        Map.get(entry, :service_key) == request.new_service_key

  # The Space cutoff is the frozen pre-action log itself, so it never includes the action.
  defp cutoffs(log, request) do
    replicas = Enum.map(request.entries, & &1.replica)
    supplied = Map.put(request.replica_logs, log.replica, log)

    with true <-
           Enum.sort(Map.keys(supplied)) == Enum.sort(replicas) and
             not Map.has_key?(request.replica_logs, log.replica) and
             Enum.all?(supplied, fn {replica, retained} -> retained.replica == replica end) do
      supplied
      |> Enum.sort_by(&elem(&1, 0))
      |> Enum.reduce_while({:ok, []}, fn {_replica, retained}, {:ok, acc} ->
        case CatalogCutoff.derive(retained) do
          {:ok, %{cutoff: cutoff}} -> {:cont, {:ok, [cutoff | acc]}}
          {:error, reason} -> {:halt, {:error, reason}}
        end
      end)
      |> then(fn
        {:ok, cutoffs} -> {:ok, Enum.reverse(cutoffs)}
        error -> error
      end)
    else
      _ -> {:error, :recovery_incomplete}
    end
  end

  defp claim(log, request, bootstrap, {author, holder_epoch, cap}, {epoch, basis}, deps, derived) do
    case TransportCatalog.normalize_replacement_claim(%{
           version: 1,
           product: :treehouse,
           space: log.replica,
           bootstrap: bootstrap.id,
           profile_genesis: bootstrap.record.profile_genesis,
           profile_id: bootstrap.record.profile_id,
           parents: request.parents,
           prior_catalogs: request.prior_catalogs,
           generation: request.generation,
           nonce: request.nonce,
           new_catalog_key: request.new_catalog_key,
           new_service_id: request.new_service_id,
           new_service_key: request.new_service_key,
           new_origin: request.new_origin,
           inventory_digest: Keyword.fetch!(derived, :inventory),
           cutoffs: Keyword.fetch!(derived, :cutoffs),
           author: author,
           cap: cap,
           holder_epoch: holder_epoch,
           deps: deps,
           epoch: epoch,
           epoch_basis: basis
         }) do
      {:ok, claim} -> {:ok, claim}
      _ -> {:error, :malformed_catalog}
    end
  end

  # --- retained-evidence coverage (plan 316 §3: parents, prior_catalogs, generation) ----

  # Binding nodes are the honored bootstrap (generation 0), every on-Space replacement honored
  # at its strict prefix (D-276, refused-on-the-union nodes included) and every retained
  # rotation chained and verified from a known node. A cited but unknown node is
  # `trust_pending`: the caller must supply the retained evidence before authoring.
  defp coverage(log, claim, request, bootstrap) do
    root = %{bootstrap.id => %{generation: 0, key: bootstrap.record.catalog_key, parents: []}}

    with {:ok, pending} <- rotation_envelopes(log, request.rotations, bootstrap),
         {:ok, nodes} <- chain(pending, Map.merge(replacement_nodes(log, bootstrap), root)),
         :ok <- known_parents(nodes),
         {:ok, catalog_heads} <- catalog_heads(log, request.catalogs, bootstrap, nodes),
         :ok <- cover_parents(claim.parents, heads(nodes)),
         :ok <- cover_generation(claim, nodes) do
      expected =
        Enum.flat_map(claim.parents, fn parent ->
          case Map.get(catalog_heads, parent, []) do
            [] -> [%{binding: parent, catalog: nil}]
            catalogs -> for catalog <- catalogs, do: %{binding: parent, catalog: catalog}
          end
        end)

      cover(expected, claim.prior_catalogs)
    end
  end

  defp rotation_envelopes(log, rotations, bootstrap) do
    Enum.reduce_while(rotations, {:ok, %{}}, fn envelope, {:ok, acc} ->
      with true <-
             is_map(envelope) and
               Enum.sort(Map.keys(envelope)) == [:new_signature, :old_signature, :rotation],
           {:ok, rotation} <- TransportCatalog.normalize_rotation(envelope.rotation) do
        if rotation.space == log.replica and rotation.bootstrap == bootstrap.id,
          do: {:cont, {:ok, Map.put(acc, TransportCatalog.rotation_id(envelope), envelope)}},
          else: {:halt, {:error, :wrong_catalog_scope}}
      else
        _ -> {:halt, {:error, :malformed_catalog}}
      end
    end)
  rescue
    _ -> {:error, :malformed_catalog}
  end

  defp replacement_nodes(log, bootstrap) do
    for {id, %Op{kind: :command, body: {:replace_catalog_v1, [claim | _]}}} <- log.ops,
        {:ok, claim} <- [TransportCatalog.normalize_replacement_claim(claim)],
        claim.space == log.replica and claim.bootstrap == bootstrap.id,
        honored_at_prefix?(log, id),
        into: %{},
        do:
          {id,
           %{generation: claim.generation, key: claim.new_catalog_key, parents: claim.parents}}
  end

  defp honored_at_prefix?(log, id) do
    ids = Dag.reachable(log.ops, [id])
    prefix = Log.from_ops(log.replica, Map.take(log.ops, MapSet.to_list(ids)))
    Authority.analyze(Space, prefix).reasons[id] == nil
  end

  # Rotations chain only from a known node, verified under that node's catalog key.
  defp chain(pending, nodes) when map_size(pending) == 0, do: {:ok, nodes}

  defp chain(pending, nodes) do
    case Enum.filter(pending, fn {_id, envelope} ->
           Map.has_key?(nodes, envelope.rotation.parent)
         end) do
      [] ->
        {:error, :trust_pending}

      ready ->
        ready
        |> Enum.reduce_while({:ok, nodes}, fn {id, envelope}, {:ok, acc} ->
          rotation = envelope.rotation
          parent = Map.fetch!(acc, rotation.parent)

          cond do
            Map.has_key?(acc, id) or rotation.generation != parent.generation + 1 ->
              {:halt, {:error, :invalid_catalog_transition}}

            TransportCatalog.verify_rotation(envelope, parent.key) != :ok ->
              {:halt, {:error, :invalid_catalog_signature}}

            true ->
              node = %{
                generation: rotation.generation,
                key: rotation.new_catalog_key,
                parents: [rotation.parent]
              }

              {:cont, {:ok, Map.put(acc, id, node)}}
          end
        end)
        |> case do
          {:ok, nodes} -> chain(Map.drop(pending, Enum.map(ready, &elem(&1, 0))), nodes)
          error -> error
        end
    end
  end

  defp known_parents(nodes) do
    if Enum.all?(nodes, fn {_id, node} -> Enum.all?(node.parents, &Map.has_key?(nodes, &1)) end),
      do: :ok,
      else: {:error, :trust_pending}
  end

  # D-275: every ancestor-or-self of a cited parent is closed; the rest are heads.
  defp heads(nodes) do
    closed = nodes |> Map.values() |> Enum.flat_map(& &1.parents) |> closure(nodes, MapSet.new())
    nodes |> Map.keys() |> Enum.reject(&MapSet.member?(closed, &1)) |> Enum.sort()
  end

  defp closure([], _nodes, acc), do: acc

  defp closure([id | rest], nodes, acc) do
    if MapSet.member?(acc, id),
      do: closure(rest, nodes, acc),
      else: closure(Map.fetch!(nodes, id).parents ++ rest, nodes, MapSet.put(acc, id))
  end

  defp cover_parents(parents, heads), do: cover(heads, parents)

  # Omitting a known head would author a sibling (`catalog_fork`); anything else is wrong.
  defp cover(expected, supplied) do
    cond do
      Enum.sort(expected) == Enum.sort(supplied) -> :ok
      Enum.any?(expected, &(&1 not in supplied)) -> {:error, :catalog_fork}
      true -> {:error, :invalid_catalog_transition}
    end
  end

  defp cover_generation(claim, nodes) do
    max = claim.parents |> Enum.map(&Map.fetch!(nodes, &1).generation) |> Enum.max()
    if claim.generation == max + 1, do: :ok, else: {:error, :invalid_catalog_transition}
  end

  # Retained catalogs, verified under their binding's key; heads are those no other catalog
  # under the same binding names as `previous`.
  defp catalog_heads(log, catalogs, bootstrap, nodes) do
    catalogs
    |> Enum.reduce_while({:ok, []}, fn envelope, {:ok, acc} ->
      with true <- is_map(envelope) and Enum.sort(Map.keys(envelope)) == [:catalog, :signature],
           {:ok, catalog} <- TransportCatalog.normalize_catalog(envelope.catalog) do
        cond do
          catalog.space != log.replica or catalog.bootstrap != bootstrap.id ->
            {:halt, {:error, :wrong_catalog_scope}}

          not Map.has_key?(nodes, catalog.binding) ->
            {:halt, {:error, :trust_pending}}

          TransportCatalog.verify_catalog(envelope, nodes[catalog.binding].key) != :ok ->
            {:halt, {:error, :invalid_catalog_signature}}

          true ->
            {:cont, {:ok, [{TransportCatalog.catalog_id(catalog), catalog} | acc]}}
        end
      else
        _ -> {:halt, {:error, :malformed_catalog}}
      end
    end)
    |> case do
      {:ok, verified} ->
        previous =
          MapSet.new(verified, fn {_id, catalog} -> {catalog.binding, catalog.previous} end)

        {:ok,
         verified
         |> Enum.reject(fn {id, catalog} -> MapSet.member?(previous, {catalog.binding, id}) end)
         |> Enum.group_by(fn {_id, catalog} -> catalog.binding end, &elem(&1, 0))
         |> Map.new(fn {binding, ids} -> {binding, ids |> Enum.uniq() |> Enum.sort()} end)}

      error ->
        error
    end
  rescue
    _ -> {:error, :malformed_catalog}
  end

  # The attempt journal is keyed by the claim nonce; identical bytes are an idempotent retry.
  defp nonce_free(nil, _nonce, _bytes), do: :ok

  defp nonce_free(journal, nonce, bytes) do
    case Map.get(journal, nonce) do
      nil -> :ok
      %{claim_bytes: ^bytes} -> :ok
      _ -> {:error, :attempt_nonce_reused}
    end
  end

  # The possession and op-signature slots are fixed at 64 bytes, so the zero placeholder
  # measures the signed frame byte-exactly.
  defp intent(claim, catalog_possession, service_possession) do
    op = %Op{
      id: "",
      replica: claim.space,
      author: claim.author,
      deps: claim.deps,
      kind: :command,
      body: {:replace_catalog_v1, [claim, catalog_possession, service_possession]},
      cap: claim.cap,
      sig: @zero
    }

    %{op | id: Op.recompute_id(op)}
  end

  defp envelope(op) do
    case MemberContinuityAuthoring.envelope_status(op) do
      :ok -> :ok
      {:error, :capacity_stop} -> {:error, :catalog_command_too_large}
      {:error, reason} -> {:error, reason}
    end
  end

  # Only the existing full judge consumes this private unsigned intent. Never append/accept
  # it or pass this synthetic scope to an authenticated public API.
  defp intent_reason(log, op) do
    scope = %{log | ops: Map.put(log.ops, op.id, op)}
    Authority.analyze(Space, scope).reasons[op.id]
  end

  # Zero possession: Stage A must be the only refusal left.
  defp review_preflight(log, op) do
    case intent_reason(log, op) do
      :application_invalid_catalog -> :ok
      reason -> {:error, reason || :invalid_review_intent}
    end
  end

  # --- author -----------------------------------------------------------------

  defp attempt_shape(attempt) when is_map(attempt) do
    if Enum.all?(@attempt_fields, &Map.has_key?(attempt, &1)) and
         match?({:ok, _}, TransportCatalog.normalize_replacement_claim(attempt.claim)),
       do: {:ok, attempt},
       else: {:error, :stale_verified_state}
  end

  defp attempt_shape(_), do: {:error, :stale_verified_state}

  defp presign(signer, log_source, attempt, possession) do
    with {:ok, current} <- read(log_source, attempt),
         :ok <- reclassified(current, attempt, nil),
         :ok <- fresh(current, attempt),
         {:ok, catalog, service} <- possession(attempt, possession),
         {:ok, sign} <- signer(signer, attempt.author),
         candidate = intent(attempt.claim, catalog, service),
         :ok <- envelope(candidate),
         :ok <- preflight(current, candidate) do
      {:ok, sign, candidate}
    end
  end

  defp sign_last(sign, log_source, attempt, candidate) do
    with {:ok, signature} <- sign(sign, Op.canonical_encoding(candidate)),
         signed = %{candidate | sig: signature},
         :ok <- signed_valid(signed) do
      after_signature(log_source, attempt, signed)
    else
      {:error, reason} -> {:error, reason, entry(attempt, :cancelled, reason, nil)}
    end
  end

  # The signed frame leaves only if the freshly re-read frozen state is still unreclassified
  # with the signed op appended and still re-derives the signed claim byte-for-byte; otherwise
  # the pending attempt is cancelled.
  defp after_signature(log_source, attempt, signed) do
    with {:ok, current} <- read(log_source, attempt),
         :ok <- reclassified(current, attempt, signed),
         :ok <- fresh(current, attempt),
         :ok <- envelope(signed),
         {:ok, frame} <- Wire.encode_op_checked(signed) do
      {:ok,
       %{
         op: signed,
         frame: frame,
         binding_id: signed.id,
         attempt_id: attempt.attempt_id,
         journal_entry: entry(attempt, :signed, nil, signed.id)
       }}
    else
      {:error, reason} ->
        {:error, reason, entry(attempt, :cancelled_after_signature, reason, nil)}
    end
  end

  defp read(source, attempt) do
    log = if is_function(source, 0), do: source.(), else: source

    cond do
      not match?(%Log{}, log) -> {:error, :stale_verified_state}
      Log.verify_authenticity(log) != :ok -> {:error, :invalid_verified_history}
      log.replica != attempt.claim.space -> {:error, :stale_verified_state}
      true -> {:ok, log}
    end
  rescue
    _ -> {:error, :stale_verified_state}
  catch
    _, _ -> {:error, :stale_verified_state}
  end

  # C13: any op honored in the frozen analysis that the union quarantines, a moved `:admin`
  # holder epoch, or a Core refusal of the action itself on the union cancels the attempt.
  defp reclassified(current, attempt, signed) do
    with {:ok, frozen} <- frozen(current, attempt.frozen_frontier),
         {:ok, union} <- union(current, signed) do
      frozen_quarantine = Authority.analyze(Space, frozen).quarantine
      analysis = Authority.analyze(Space, union)

      demoted? =
        Enum.any?(Map.keys(frozen.ops), fn id ->
          not MapSet.member?(frozen_quarantine, id) and MapSet.member?(analysis.quarantine, id)
        end)

      holder = Map.get(analysis.holder_epochs, :admin)

      cond do
        demoted? ->
          {:error, :authority_changed}

        holder != %{holder: attempt.author, op_id: attempt.claim.holder_epoch} ->
          {:error, :authority_changed}

        action_refused?(union, analysis, attempt, signed) ->
          {:error, :authority_changed}

        true ->
          :ok
      end
    end
  end

  defp frozen(current, frontier) do
    if is_list(frontier) and frontier != [] and Enum.all?(frontier, &Log.has?(current, &1)) do
      ids = Dag.reachable(current.ops, frontier)
      {:ok, Log.from_ops(current.replica, Map.take(current.ops, MapSet.to_list(ids)))}
    else
      {:error, :stale_verified_state}
    end
  end

  defp union(current, nil), do: {:ok, current}

  defp union(current, signed) do
    case Log.accept(current, signed) do
      {:ok, log} -> {:ok, log}
      _ -> {:error, :authority_changed}
    end
  end

  defp action_refused?(_union, analysis, _attempt, %Op{id: id}),
    do: Map.has_key?(analysis.reasons, id)

  defp action_refused?(union, _analysis, attempt, nil),
    do: intent_reason(union, intent(attempt.claim, @zero, @zero)) != :application_invalid_catalog

  # Every changed dep, key, cutoff, inventory or acquisition changes these bytes.
  defp fresh(current, attempt) do
    case derive(current, attempt.request, nil) do
      {:ok, current_attempt} ->
        if Map.take(current_attempt, @attempt_fields) == Map.take(attempt, @attempt_fields),
          do: :ok,
          else: {:error, :stale_verified_state}

      {:error, :invalid_verified_history} = error ->
        error

      {:error, _} ->
        {:error, :stale_verified_state}
    end
  end

  defp possession(attempt, %{catalog: catalog, service: service} = possession)
       when map_size(possession) == 2 do
    case TransportCatalog.verify_replacement_possession(attempt.claim, catalog, service) do
      :ok -> {:ok, catalog, service}
      _ -> {:error, :invalid_possession}
    end
  end

  defp possession(_attempt, _possession), do: {:error, :invalid_possession}

  defp preflight(log, op) do
    case intent_reason(log, op) do
      nil -> :ok
      reason -> {:error, reason}
    end
  end

  defp signer(%Identity{pub: author} = identity, author),
    do: {:ok, &Identity.sign(identity, &1)}

  defp signer(%{pub: author, sign: sign}, author) when is_function(sign, 1), do: {:ok, sign}
  defp signer(_, _), do: {:error, :wrong_signer}

  defp sign(sign, bytes) do
    case sign.(bytes) do
      signature when is_binary(signature) and byte_size(signature) == 64 ->
        {:ok, signature}

      {:ok, signature} when is_binary(signature) and byte_size(signature) == 64 ->
        {:ok, signature}

      _ ->
        {:error, :invalid_signer_signature}
    end
  rescue
    _ -> {:error, :signer_failed}
  catch
    _, _ -> {:error, :signer_failed}
  end

  defp signed_valid(op) do
    if Op.valid?(op), do: :ok, else: {:error, :invalid_signer_signature}
  end

  defp entry(attempt, status, reason, op_id) do
    %{
      attempt_id: attempt && attempt.attempt_id,
      claim_bytes: attempt && attempt.claim_bytes,
      status: status,
      reason: reason,
      op_id: op_id
    }
  end

  defp key?(value), do: is_binary(value) and byte_size(value) == 32
end
