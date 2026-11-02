defmodule Treehouse.CatalogReplacementAuthoring do
  @moduledoc """
  `replace_catalog_v1` authoring preflight (plan 316 PR 2): freeze, derive, review, sign last.

  `prepare/3` freezes the Space frontier and derives every consent-bearing claim field from
  the authenticated judged history: the honored bootstrap, the current `:admin` holder and
  its acquisition capability, the beacon epoch basis, the route inventory and the recovery
  cutoffs. It signs nothing. The caller collects the two new-key possession signatures over
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

  @request_fields ~w(author nonce parents prior_catalogs generation new_catalog_key new_service_id new_service_key new_origin entries replica_logs)a
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
         Enum.all?(request.replica_logs, fn {replica, log} ->
           is_binary(replica) and match?(%Log{}, log)
         end),
       do: :ok,
       else: {:error, :application_invalid_catalog}
  end

  defp request_shape(_), do: {:error, :application_invalid_catalog}

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
  # with the signed op appended; otherwise the pending attempt is cancelled.
  defp after_signature(log_source, attempt, signed) do
    with {:ok, current} <- read(log_source, attempt),
         :ok <- reclassified(current, attempt, signed),
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
