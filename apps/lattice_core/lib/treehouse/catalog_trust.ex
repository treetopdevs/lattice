defmodule Treehouse.CatalogTrust do
  @moduledoc """
  Pure retained transport-catalog trust decisions over complete raw evidence.

  Returned routes are installation candidates. This module performs no storage,
  freshness, compare-and-swap, carrier-readiness, or route-activation work.
  """

  alias Lattice.{Authority, Canonical, Identity, Log, Op}
  alias Lattice.Authority.{Continuation, ContinuationCertificate}
  alias Lattice.Carrier.Wire
  alias Treehouse.{CatalogBootstrap, CatalogCutoff, CatalogEntries, Space, TransportCatalog}

  @history_fields [:replica, :frames, :rejected]
  @review_fields [
    :version,
    :product,
    :space,
    :space_root,
    :bootstrap_id,
    :observed_bootstrap_ids,
    :disposition
  ]
  @token_fields [:trust_revision, :history_generation]
  @page_fields [:catalogs, :rotations, :histories, :cutoff_proofs]
  @state_fields [
    :version,
    :review,
    :histories,
    :catalogs,
    :rotations,
    :cutoff_proofs,
    :accepted,
    :blocked
  ]
  @accepted_fields [:binding, :generation, :catalog, :revision]
  @block_fields [
    :reason,
    :bindings,
    :catalogs,
    :bootstrap_ids,
    :op_ids,
    :pending_proof_ids,
    :triggers,
    :authority_witnesses
  ]
  @decision_fields [
    :kind,
    :expected,
    :next,
    :reason,
    :detail,
    :replacement_configured,
    :observed,
    :routes
  ]
  @detail_fields [:ids, :core_reason, :pending_proof_ids]
  @observed_fields [:bootstrap_ids, :binding_heads, :catalog_heads]
  @catalog_head_fields [:binding, :catalogs]
  @route_fields [
    :replica,
    :kind,
    :schema,
    :root,
    :genesis,
    :creation,
    :reference,
    :binding,
    :catalog,
    :revision,
    :origin,
    :path,
    :url,
    :service_id,
    :service_key,
    :realm
  ]
  @frame_fields ~w(v id replica author deps kind body cap sig)
  @max_safe_integer 9_007_199_254_740_991
  @max_artifacts 1_024
  @max_artifact_bytes 131_072
  @max_total_bytes 16 * 1_024 * 1_024
  @max_canonical_integer 18_446_744_073_709_551_615

  # The retained-cutoff grammar is fixed and compiled into this module. Checking
  # names before Wire decoding makes a fresh VM deterministic without interning
  # atoms from input or relying on whichever domain modules happened to load.
  @cutoff_atoms MapSet.new(~w(
    __beacon__ __continuation__ accept admin admin_actions admit_member archive_thread archived
    audience author author_edit author_tombstone authority bad_signature beacon binding
    bootstrap bounded_continuation bounded_space_admin_v1 bytes cap catalog catalog_bootstrap_v1
    catalog_key claim command consent continuation_v1 create_space create_thread creation
    cutoffs delegation_id deps dormant_ticks entries epoch epoch_basis expires_epoch frontier
    generation genesis grant heartbeat holder holder_epoch id inbox inventory_digest invitations
    issue_invitation issuer kind live log_digest max_epoch_step max_lease_epochs member members
    membership_events mode moderation moderator moderator_actions moderator_tombstone name
    new_catalog_key new_origin new_service_id new_service_key new_signature nominee nonce
    old_signature ops origin parent parent_id parents policy_id post posts previous
    prior_catalog prior_catalogs product profile_genesis profile_id reason recovery reference
    reject remove_member replace_catalog_v1 replacement_rule replica request revision revoke
    revoke_invitation revoked_invitations role roles root rotation route schema service
    service_id service_key sig signature signatures space space_root succeed successor thread
    threads threshold title tombstone transfer treehouse treehouse_space_v1 treehouse_thread_v1
    version witness witnessed witnesses
  )a)
  @cutoff_atom_by_name Map.new(@cutoff_atoms, &{Atom.to_string(&1), &1})

  @type reason ::
          :malformed_catalog
          | :control_history_limit
          | :wrong_catalog_scope
          | :trust_pending
          | :invalid_catalog_signature
          | :invalid_possession
          | :catalog_authority_refused
          | :invalid_catalog_transition
          | :catalog_rollback
          | :catalog_fork
          | :recovery_incomplete
          | :carrier_pending
          | :authority_changed
          | :invalid_verified_history
          | :unsupported_cutoff
          | :trust_recovery_required
          | :stale_trust_snapshot
          | :trust_persistence_failed

  @type decision :: map()

  @doc "Prepare a proposed empty retained snapshot from an explicit reviewed bootstrap."
  @spec prepare_installation(term()) :: decision()
  def prepare_installation(input) do
    protect(fn ->
      require_fields!(input, [:review, :history, :store], :malformed_catalog)
      review = validate_review!(input.review)
      require_fields!(input.store, [:kind, :expected], :malformed_catalog)
      if input.store.kind != :verified_fresh, do: refuse(:malformed_catalog)
      expected = validate_token!(input.store.expected)
      %{logs: logs, raws: raws} = histories!([input.history], :incoming)
      log = Map.fetch!(logs, review.space)
      if log.replica != review.space, do: refuse(:wrong_catalog_scope)
      {bootstrap, bootstrap_ids, replacement} = reviewed_bootstrap!(review, log, true)

      next = %{
        version: 1,
        review: review,
        histories: raws,
        catalogs: [],
        rotations: [],
        cutoff_proofs: [],
        accepted: nil,
        blocked: nil
      }

      issue(:propose, expected, next, nil, replacement, bootstrap_ids, [bootstrap.id], [], [])
    end)
  end

  @doc "Evaluate an evidence page against a separately validated retained snapshot."
  @spec evaluate(term()) :: decision()
  def evaluate(input) do
    protect(fn ->
      require_fields!(input, [:installed, :expected, :incoming], :malformed_catalog)

      # This phase is deliberately isolated: incoming bytes cannot repair saved
      # history, and an existing block cannot conceal corrupt saved evidence.
      original_context = validate_original!(input.installed)
      original = original_context.state
      expected = validate_token!(input.expected)
      validate_page!(input.incoming)

      union = merge_histories!(original.histories, input.incoming.histories)
      %{logs: histories, raws: raw_histories} = histories!(union, :incoming)

      {bootstrap, bootstrap_ids, replacement} =
        current_bootstrap!(original.review, histories[original.review.space])

      next = %{original | histories: raw_histories}

      preliminary =
        merge_security_block(original.blocked, security_block(original, histories, bootstrap_ids))

      try do
        graph_source =
          if preliminary && preliminary.reason == :authority_changed,
            do: :incoming_authority_frozen,
            else: :incoming

        context =
          graph!(
            original,
            input.incoming,
            histories,
            bootstrap,
            original.review.bootstrap_id,
            graph_source
          )

        next = %{
          next
          | catalogs: context.catalog_records,
            rotations: context.rotation_records,
            cutoff_proofs: context.cutoff_proofs,
            blocked: preliminary || original.blocked
        }

        graph_block = graph_block(context)
        next = if next.blocked == nil, do: %{next | blocked: graph_block}, else: next

        triggers = overflow(context, original)

        cond do
          original.blocked != nil and original.blocked.triggers != [] ->
            retain_existing_block(
              next,
              original,
              expected,
              replacement,
              bootstrap_ids,
              triggers
            )

          triggers == nil ->
            finish(next, original, expected, replacement, bootstrap_ids, context)

          true ->
            overflow_decision(next, original, expected, replacement, bootstrap_ids, triggers)
        end
      catch
        {:catalog_trust_refusal, _reason, _detail} = refusal ->
          if preliminary != nil or original.blocked != nil do
            blocked = preliminary || original.blocked
            next = %{next | blocked: blocked}

            issue(
              :retain_blocked,
              expected,
              next,
              blocked.reason,
              replacement,
              bootstrap_ids,
              blocked.bindings,
              [],
              []
            )
          else
            throw(refusal)
          end
      end
    end)
  end

  @doc "Re-derive an installation-required route from a complete decision snapshot."
  @spec resolve_route(term()) :: map()
  def resolve_route(input) do
    protect_route(fn ->
      require_fields!(input, [:decision, :replica], :trust_recovery_required)
      if not text?(input.replica), do: refuse(:trust_recovery_required)
      decision = input.decision
      require_fields!(decision, @decision_fields, :trust_recovery_required)

      if decision.kind not in [:unchanged, :propose, :retain_blocked],
        do: refuse(:trust_recovery_required)

      validate_token!(decision.expected)
      validate_decision_shape!(decision)
      context = validate_original!(decision.next)

      if context.state.blocked != nil do
        %{ok: false, reason: context.state.blocked.reason}
      else
        case Enum.find(routes(context), &(&1.replica == input.replica)) do
          nil -> %{ok: false, reason: :thread_unavailable}
          candidate -> %{ok: true, candidate: candidate, installation_required: true}
        end
      end
    end)
  end

  defp finish(next, original, expected, replacement, bootstrap_ids, context) do
    heads = binding_heads(context)
    catalog_heads = catalog_heads(context)

    if next.blocked != nil do
      issue(
        :retain_blocked,
        expected,
        next,
        next.blocked.reason,
        replacement,
        bootstrap_ids,
        heads,
        catalog_heads,
        []
      )
    else
      head = Map.fetch!(context.bindings, hd(heads))

      latest_id =
        catalog_heads |> Enum.find(&(&1.binding == head.id)) |> then(&(&1 && hd(&1.catalogs)))

      latest = latest_id && context.catalogs[latest_id]

      {next, reason} =
        cond do
          head.pending != [] ->
            {next, :recovery_incomplete}

          latest == nil or latest.pending != [] ->
            {next, :trust_pending}

          true ->
            {%{
               next
               | accepted: %{
                   binding: head.id,
                   generation: head.generation,
                   catalog: latest.id,
                   revision: latest.envelope.catalog.revision
                 }
             }, nil}
        end

      route_values = routes(%{context | state: next})
      kind = if next == original, do: :unchanged, else: :propose

      issue(
        kind,
        expected,
        next,
        reason,
        replacement,
        bootstrap_ids,
        heads,
        catalog_heads,
        route_values
      )
    end
  end

  defp overflow_decision(next, original, expected, replacement, bootstrap_ids, triggers) do
    previous = original.blocked

    witnesses =
      cond do
        next.blocked && next.blocked.reason == :authority_changed ->
          next.blocked.authority_witnesses

        previous ->
          previous.authority_witnesses

        true ->
          []
      end

    block =
      block(
        if(witnesses == [], do: :control_history_limit, else: :authority_changed),
        [],
        [],
        [],
        Enum.flat_map(witnesses, & &1.op_ids),
        [],
        witnesses
      )
      |> Map.put(
        :triggers,
        if(previous && previous.triggers != [], do: previous.triggers, else: triggers)
      )

    retained = %{
      next
      | catalogs: original.catalogs,
        rotations: original.rotations,
        cutoff_proofs: original.cutoff_proofs,
        accepted: original.accepted,
        blocked: block
    }

    issue(
      :retain_blocked,
      expected,
      retained,
      block.reason,
      replacement,
      bootstrap_ids,
      [],
      [],
      []
    )
  end

  defp retain_existing_block(next, original, expected, replacement, bootstrap_ids, triggers) do
    block = next.blocked

    block =
      if triggers != nil and block.reason == :authority_changed and block.triggers == [],
        do: %{block | triggers: triggers},
        else: block

    retained = %{
      next
      | catalogs: original.catalogs,
        rotations: original.rotations,
        cutoff_proofs: original.cutoff_proofs,
        accepted: original.accepted,
        blocked: block
    }

    issue(
      :retain_blocked,
      expected,
      retained,
      block.reason,
      replacement,
      bootstrap_ids,
      block.bindings,
      [],
      []
    )
  end

  defp validate_original!(state) do
    state = validate_state_shape!(state)
    %{logs: histories} = histories!(state.histories, :stored)

    {bootstrap, bootstrap_ids, replacement} =
      current_bootstrap!(state.review, histories[state.review.space])

    context =
      graph!(
        state,
        %{catalogs: [], rotations: [], cutoff_proofs: [], histories: []},
        histories,
        bootstrap,
        state.review.bootstrap_id,
        :stored
      )
      |> Map.merge(%{
        state: state,
        bootstrap_ids: bootstrap_ids,
        replacement: replacement
      })

    validate_watermark!(state, context)
    validate_authority_witnesses!(state, histories)
    validate_saved_block!(state, context, histories, bootstrap_ids)
    context
  rescue
    _ -> refuse(:trust_recovery_required)
  catch
    {:catalog_trust_refusal, _reason, _detail} ->
      refuse(:trust_recovery_required)
  end

  defp graph!(state, incoming, histories, bootstrap, bootstrap_id, source) do
    {catalogs, catalog_records} =
      artifacts!(state.catalogs, incoming.catalogs, :catalog, bootstrap, bootstrap_id, source)

    {rotations, rotation_records} =
      artifacts!(state.rotations, incoming.rotations, :rotation, bootstrap, bootstrap_id, source)

    context = %{
      catalogs: catalogs,
      rotations: rotations,
      bindings: %{
        bootstrap_id => %{
          id: bootstrap_id,
          generation: 0,
          key: bootstrap.catalog_key,
          parent: nil,
          prior: nil,
          inventory: nil,
          pending: []
        }
      },
      histories: histories,
      bootstrap: bootstrap,
      bootstrap_id: bootstrap_id,
      catalog_records: catalog_records,
      rotation_records: rotation_records,
      cutoff_proofs: [],
      entry_proofs: %{},
      state: state,
      source: source,
      accepted_support: nil
    }

    context = %{context | accepted_support: accepted_support(context)}

    context =
      Enum.reduce(sorted(Map.keys(catalogs)), context, fn id, acc ->
        {acc, _node} = resolve_catalog!(id, acc, MapSet.new())
        acc
      end)

    context =
      Enum.reduce(sorted(Map.keys(rotations)), context, fn id, acc ->
        {acc, _binding} = resolve_binding!(id, acc, MapSet.new())
        acc
      end)

    proofs = merge_proofs!(state.cutoff_proofs, incoming.cutoff_proofs, histories, source)
    context = %{context | cutoff_proofs: proofs}

    bindings =
      context.bindings
      |> Map.values()
      |> Enum.sort_by(&{&1.generation, &1.id})
      |> Enum.reduce(context.bindings, fn binding, acc ->
        id = binding.id

        if binding.parent == nil do
          acc
        else
          rotation = context.rotations[id].envelope.rotation

          missing =
            Enum.reject(rotation.cutoffs, fn cutoff ->
              Enum.any?(proofs, &(&1.cutoff == cutoff))
            end)

          parent_pending = Map.fetch!(acc, binding.parent).pending

          Map.put(acc, id, %{
            binding
            | pending:
                sorted(binding.pending ++ parent_pending ++ Enum.map(missing, & &1.log_digest))
          })
        end
      end)

    context = %{context | bindings: bindings}
    validate_route_history!(context)
    context
  end

  defp resolve_catalog!(id, context, visiting) do
    node = Map.get(context.catalogs, id) || refuse(:trust_pending, [id])

    if node.ready do
      {context, node}
    else
      marker = {:catalog, id}
      if MapSet.member?(visiting, marker), do: refuse(:invalid_catalog_transition, [id])
      visiting = MapSet.put(visiting, marker)
      catalog = node.envelope.catalog
      {context, binding} = resolve_binding!(catalog.binding, context, visiting)

      case TransportCatalog.verify_catalog(node.envelope, binding.key) do
        :ok -> :ok
        {:error, reason} -> refuse(reason, [id])
      end

      if catalog.space != context.bootstrap.space or catalog.bootstrap != context.bootstrap_id,
        do: refuse(:wrong_catalog_scope, [id])

      if Enum.any?(catalog.entries, fn entry ->
           entry.service_id != context.bootstrap.service_id or
             entry.service_key != context.bootstrap.service_key
         end),
         do: refuse(:wrong_catalog_scope, [id])

      context =
        if catalog.previous == nil do
          if binding.inventory != nil and
               TransportCatalog.inventory_id(catalog.entries) != binding.inventory,
             do: refuse(:invalid_catalog_transition, [id])

          context
        else
          {context, prior} = resolve_catalog!(catalog.previous, context, visiting)
          previous = prior.envelope.catalog

          if previous.binding != catalog.binding or catalog.revision != previous.revision + 1 or
               not safe?(previous.revision + 1) or
               not inventory_extends?(previous.entries, catalog.entries),
             do: refuse(:invalid_catalog_transition, [id])

          context
        end

      historical = historical_accepted_entry_proof?(id, context)
      {context, entry_proof} = observe_entries(catalog, historical, context)

      pending =
        case entry_proof do
          {:ok, _} ->
            []

          {:error, :trust_pending} ->
            [id]

          {:error, :invalid_catalog_transition} ->
            authority =
              if authority_frozen_context?(context),
                do: authority_refusal_status(catalog, context.histories),
                else: :invalid

            cond do
              authority != :invalid and node.retained and context.state.blocked != nil and
                  not supports_accepted_watermark?(id, context) ->
                pending_frozen_entry!(catalog, node, context, id)

              authority == :pending ->
                [id]

              authority == :complete ->
                []

              true ->
                pending_frozen_entry!(catalog, node, context, id)
            end

          {:error, reason} ->
            refuse(reason, [id])
        end

      node = %{node | ready: true, pending: pending}
      {%{context | catalogs: Map.put(context.catalogs, id, node)}, node}
    end
  end

  defp observe_entries(catalog, historical, context) do
    key = {TransportCatalog.inventory_id(catalog.entries), historical}

    case Map.fetch(context.entry_proofs, key) do
      {:ok, result} ->
        {context, result}

      :error ->
        histories =
          if historical,
            do: catalog_fact_histories(catalog, context.histories),
            else: context.histories

        result = CatalogEntries.observe(catalog, histories)
        {%{context | entry_proofs: Map.put(context.entry_proofs, key, result)}, result}
    end
  end

  defp resolve_binding!(id, context, visiting) do
    case Map.get(context.bindings, id) do
      nil ->
        marker = {:binding, id}
        if MapSet.member?(visiting, marker), do: refuse(:invalid_catalog_transition, [id])
        visiting = MapSet.put(visiting, marker)
        node = Map.get(context.rotations, id) || refuse(:trust_pending, [id])
        rotation = node.envelope.rotation
        {context, parent} = resolve_binding!(rotation.parent, context, visiting)

        if rotation.generation != parent.generation + 1 or not safe?(parent.generation + 1) or
             rotation.new_catalog_key == parent.key or
             rotation.new_catalog_key == context.bootstrap.service_key,
           do: refuse(:invalid_catalog_transition, [id])

        verify_rotation!(node.envelope, parent.key, id)
        {context, prior} = resolve_catalog!(rotation.prior_catalog, context, visiting)

        if prior.envelope.catalog.binding != rotation.parent or
             TransportCatalog.inventory_id(prior.envelope.catalog.entries) !=
               rotation.inventory_digest or
             Enum.map(rotation.cutoffs, & &1.replica) !=
               Enum.map(prior.envelope.catalog.entries, & &1.replica),
           do: refuse(:invalid_catalog_transition, [id])

        binding = %{
          id: id,
          generation: rotation.generation,
          key: rotation.new_catalog_key,
          parent: rotation.parent,
          prior: rotation.prior_catalog,
          inventory: rotation.inventory_digest,
          pending: prior.pending
        }

        context = %{
          context
          | bindings: Map.put(context.bindings, id, binding),
            rotations: Map.put(context.rotations, id, %{node | ready: true})
        }

        {context, binding}

      binding ->
        {context, binding}
    end
  end

  defp verify_rotation!(envelope, trusted_key, id) do
    rotation = envelope.rotation

    cond do
      not Identity.verify(
        trusted_key,
        TransportCatalog.rotation_bytes(rotation),
        envelope.old_signature
      ) ->
        refuse(:invalid_catalog_signature, [id])

      not Identity.verify(
        rotation.new_catalog_key,
        TransportCatalog.rotation_possession_bytes(rotation),
        envelope.new_signature
      ) ->
        refuse(:invalid_possession, [id])

      true ->
        :ok
    end
  end

  defp artifacts!(saved, incoming, kind, bootstrap, bootstrap_id, source) do
    parsed_saved = Enum.map(saved, &parse_saved!(&1, kind, bootstrap, bootstrap_id))
    parsed_incoming = Enum.map(incoming, &parse_incoming!(&1, kind, bootstrap, bootstrap_id))

    nodes =
      Enum.reduce(parsed_saved ++ parsed_incoming, %{}, fn node, acc ->
        case acc[node.id] do
          nil ->
            Map.put(acc, node.id, node)

          previous
          when kind == :catalog and previous.envelope.signature != node.envelope.signature ->
            refuse(
              if(source == :stored,
                do: :trust_recovery_required,
                else: :invalid_catalog_signature
              ),
              [node.id]
            )

          _ ->
            acc
        end
      end)

    records =
      nodes
      |> Map.values()
      |> Enum.sort_by(& &1.id)
      |> Enum.map(fn node ->
        case Enum.find(parsed_saved, &(&1.id == node.id)) do
          nil -> %{id: node.id, json: node.json}
          original -> %{id: original.id, json: original.json}
        end
      end)

    {nodes, records}
  end

  defp parse_saved!(record, kind, bootstrap, bootstrap_id) do
    require_fields!(record, [:id, :json], :trust_recovery_required)
    if not id?(record.id) or not is_binary(record.json), do: refuse(:trust_recovery_required)
    node = parse_artifact!(record.json, kind, bootstrap, bootstrap_id) |> Map.put(:retained, true)
    if node.id != record.id, do: refuse(:trust_recovery_required)
    node
  end

  defp parse_incoming!(json, kind, bootstrap, bootstrap_id) when is_binary(json),
    do: parse_artifact!(json, kind, bootstrap, bootstrap_id) |> Map.put(:retained, false)

  defp parse_incoming!(_json, _kind, _bootstrap, _bootstrap_id), do: refuse(:malformed_catalog)

  defp parse_artifact!(json, kind, bootstrap, bootstrap_id) do
    if byte_size(json) > @max_artifact_bytes, do: refuse(:control_history_limit)

    value =
      with {:ok, raw} <- Jason.decode(json),
           true <- closed_wire_term?(raw, 64),
           {:ok, decoded} <- Wire.decode_value(raw) do
        decoded
      else
        _ -> refuse(:malformed_catalog)
      end

    case kind do
      :catalog ->
        require_fields!(value, [:catalog, :signature], :malformed_catalog)

        with {:ok, catalog} <- TransportCatalog.normalize_catalog(value.catalog),
             true <- is_binary(value.signature) and byte_size(value.signature) == 64 do
          id = TransportCatalog.catalog_id(catalog)

          if catalog.space != bootstrap.space or catalog.bootstrap != bootstrap_id,
            do: refuse(:wrong_catalog_scope, [id])

          %{
            id: id,
            json: json,
            envelope: %{catalog: catalog, signature: value.signature},
            ready: false,
            pending: []
          }
        else
          _ -> refuse(:malformed_catalog)
        end

      :rotation ->
        require_fields!(value, [:rotation, :old_signature, :new_signature], :malformed_catalog)

        with {:ok, rotation} <- TransportCatalog.normalize_rotation(value.rotation),
             true <- is_binary(value.old_signature) and byte_size(value.old_signature) == 64,
             true <- is_binary(value.new_signature) and byte_size(value.new_signature) == 64 do
          envelope = %{
            rotation: rotation,
            old_signature: value.old_signature,
            new_signature: value.new_signature
          }

          id = TransportCatalog.rotation_id(envelope)

          if rotation.space != bootstrap.space or rotation.bootstrap != bootstrap_id,
            do: refuse(:wrong_catalog_scope, [id])

          %{id: id, json: json, envelope: envelope, ready: false}
        else
          _ -> refuse(:malformed_catalog)
        end
    end
  end

  defp merge_proofs!(saved, incoming, histories, source) do
    Enum.reduce(saved ++ incoming, %{}, fn proof, acc ->
      require_fields!(proof, [:cutoff, :history], :malformed_catalog)
      validate_cutoff!(proof.cutoff)

      proof_context =
        try do
          histories!([proof.history], :stored)
        catch
          {:catalog_trust_refusal, _reason, _detail} ->
            refuse(
              if(source == :stored, do: :trust_recovery_required, else: :recovery_incomplete)
            )
        end

      proof_log = proof_context.logs[proof.cutoff.replica]
      if proof_log == nil, do: refuse(:recovery_incomplete, [proof.cutoff.log_digest])

      observed =
        case CatalogCutoff.derive(proof_log) do
          {:ok, observed} -> observed.cutoff
          {:error, reason} -> refuse(reason, [proof.cutoff.log_digest])
        end

      if observed != proof.cutoff, do: refuse(:recovery_incomplete, [proof.cutoff.log_digest])

      current =
        histories[proof.cutoff.replica] || refuse(:recovery_incomplete, [proof.cutoff.log_digest])

      ensure_history_subset!(proof_log, current, proof.cutoff.log_digest)
      Map.put_new(acc, {proof.cutoff.replica, proof.cutoff.log_digest}, proof)
    end)
    |> Map.values()
    |> Enum.sort_by(&{&1.cutoff.replica, &1.cutoff.log_digest})
  end

  defp validate_watermark!(%{accepted: nil}, _context), do: :ok

  defp validate_watermark!(state, context) do
    accepted = state.accepted
    node = context.catalogs[accepted.catalog] || refuse(:trust_recovery_required)
    binding = context.bindings[accepted.binding] || refuse(:trust_recovery_required)

    if node.pending != [] or binding.pending != [] or
         node.envelope.catalog.binding != binding.id or
         node.envelope.catalog.revision != accepted.revision or
         binding.generation != accepted.generation,
       do: refuse(:trust_recovery_required)
  end

  defp validate_route_history!(context) do
    _routes =
      context.catalogs
      |> Map.values()
      |> Enum.filter(&(&1.pending == []))
      |> Enum.reduce(%{}, fn node, used ->
        Enum.reduce(node.envelope.catalog.entries, used, fn entry, routes ->
          case routes[entry.route] do
            nil -> Map.put(routes, entry.route, entry.replica)
            replica when replica == entry.replica -> routes
            _other -> refuse(:invalid_catalog_transition, [node.id])
          end
        end)
      end)

    :ok
  end

  defp historical_accepted_entry_proof?(id, context) do
    authority_origin = context.source == :incoming_authority_frozen

    retained_authority =
      context.source == :stored and context.state.blocked != nil and
        context.state.blocked.reason == :authority_changed

    (authority_origin or retained_authority) and supports_accepted_watermark?(id, context)
  end

  defp authority_frozen_context?(context) do
    context.source == :incoming_authority_frozen or
      (context.state.blocked != nil and context.state.blocked.reason == :authority_changed)
  end

  defp authority_refusal_status(catalog, histories) do
    refused =
      catalog
      |> catalog_targets()
      |> Enum.any?(fn {replica, op_id} ->
        case histories[replica] do
          nil -> false
          log -> Map.has_key?(Authority.analyze(schema_for(replica), log).reasons, op_id)
        end
      end)

    if refused do
      case CatalogEntries.observe(catalog, catalog_fact_histories(catalog, histories)) do
        {:ok, _} -> :complete
        {:error, :trust_pending} -> :pending
        _other -> :invalid
      end
    else
      :invalid
    end
  end

  defp pending_frozen_entry!(catalog, node, context, id) do
    if node.retained and context.state.blocked != nil and
         not supports_accepted_watermark?(id, context) do
      diagnostics = frozen_entry_diagnostics(catalog, context.histories)

      if diagnostics == [], do: [id], else: diagnostics
    else
      refuse(:invalid_catalog_transition, [id])
    end
  end

  defp frozen_entry_diagnostics(catalog, histories) do
    space = Enum.find(catalog.entries, &(&1.kind == :space))

    catalog.entries
    |> Enum.flat_map(fn entry ->
      entries =
        if entry.kind == :space, do: [space], else: Enum.sort_by([space, entry], & &1.replica)

      probe = %{catalog | entries: entries}

      case CatalogEntries.observe(probe, histories) do
        {:error, :invalid_catalog_transition} -> entry_diagnostics(entry, catalog, histories)
        _other -> []
      end
    end)
    |> sorted()
  end

  defp entry_diagnostics(entry, catalog, histories) do
    targets = catalog_targets(%{catalog | entries: [entry]})

    refused =
      Enum.filter(targets, fn {replica, op_id} ->
        case histories[replica] do
          nil -> false
          log -> Map.has_key?(Authority.analyze(schema_for(replica), log).reasons, op_id)
        end
      end)

    targets = if refused == [], do: targets, else: refused
    Enum.map(targets, &elem(&1, 1))
  end

  defp supports_accepted_watermark?(_id, %{state: %{accepted: nil}}), do: false

  defp supports_accepted_watermark?(id, context) do
    case context.accepted_support do
      %MapSet{} = support -> MapSet.member?(support, id)
      _invalid -> true
    end
  end

  defp accepted_support(%{state: %{accepted: nil}}), do: MapSet.new()

  defp accepted_support(context) do
    accepted = context.state.accepted

    with {:ok, catalogs} <-
           accepted_catalog_support(accepted.catalog, context.catalogs, MapSet.new()),
         {:ok, catalogs} <-
           accepted_binding_support(
             accepted.binding,
             context,
             catalogs,
             MapSet.new()
           ) do
      catalogs
    else
      :error -> :invalid
    end
  end

  defp accepted_catalog_support(nil, _catalogs, support), do: {:ok, support}

  defp accepted_catalog_support(id, catalogs, support) do
    if MapSet.member?(support, id) do
      :error
    else
      case Map.get(catalogs, id) do
        nil ->
          :error

        node ->
          accepted_catalog_support(
            node.envelope.catalog.previous,
            catalogs,
            MapSet.put(support, id)
          )
      end
    end
  end

  defp accepted_binding_support(id, context, support, seen) do
    cond do
      id == context.bootstrap_id ->
        {:ok, support}

      MapSet.member?(seen, id) ->
        :error

      true ->
        case Map.get(context.rotations, id) do
          nil ->
            :error

          node ->
            rotation = node.envelope.rotation

            with {:ok, support} <-
                   accepted_catalog_support(
                     rotation.prior_catalog,
                     context.catalogs,
                     support
                   ) do
              accepted_binding_support(
                rotation.parent,
                context,
                support,
                MapSet.put(seen, id)
              )
            end
        end
    end
  end

  defp validate_authority_witnesses!(%{blocked: nil}, _histories), do: :ok

  defp validate_authority_witnesses!(state, histories) do
    witnesses = state.blocked.authority_witnesses

    allowed =
      MapSet.new([{state.review.space, state.review.bootstrap_id} | accepted_targets(state)])

    Enum.each(witnesses, fn witness ->
      if Enum.any?(witness.op_ids, &(not MapSet.member?(allowed, {witness.replica, &1}))),
        do: refuse(:trust_recovery_required)

      full = histories[witness.replica] || refuse(:trust_recovery_required)
      slice = causal_slice!(full, witness.frontier)

      if Log.frontier(slice) != witness.frontier,
        do: refuse(:trust_recovery_required)

      reasons = Authority.analyze(schema_for(witness.replica), slice).reasons

      if Enum.any?(witness.op_ids, &(not Map.has_key?(reasons, &1))),
        do: refuse(:trust_recovery_required)
    end)
  end

  defp validate_saved_block!(%{blocked: nil} = state, context, histories, bootstrap_ids) do
    if security_block(state, histories, bootstrap_ids) != nil or graph_block(context) != nil,
      do: refuse(:trust_recovery_required)
  end

  defp validate_saved_block!(state, context, histories, bootstrap_ids) do
    block = state.blocked
    security = security_block(state, histories, bootstrap_ids)
    graph = graph_block(context)
    validate_block_indexes!(state, context, bootstrap_ids)

    valid =
      case block.reason do
        :authority_changed ->
          block.authority_witnesses != [] and
            (block.triggers == [] or overflow_witness?(state, block.triggers))

        :catalog_fork ->
          (security != nil and security.reason == :catalog_fork) or
            (graph != nil and graph.reason == :catalog_fork)

        :control_history_limit ->
          (graph != nil and graph.reason == :control_history_limit) or
            (block.bindings == [] and block.catalogs == [] and
               overflow_witness?(state, block.triggers))
      end

    if not valid, do: refuse(:trust_recovery_required)
  end

  defp validate_block_indexes!(state, context, bootstrap_ids) do
    block = state.blocked

    if Enum.any?(block.bindings, &(not Map.has_key?(context.bindings, &1))) or
         Enum.any?(
           block.catalogs ++ block.pending_proof_ids,
           &(not Map.has_key?(context.catalogs, &1))
         ) or
         Enum.any?(block.bootstrap_ids, &(&1 not in bootstrap_ids)) or
         Enum.any?(block.bootstrap_ids, &(&1 in state.review.observed_bootstrap_ids)),
       do: refuse(:trust_recovery_required)
  end

  defp overflow_witness?(state, triggers) do
    artifacts = state.catalogs ++ state.rotations

    present =
      MapSet.new(
        Enum.map(state.catalogs, &{:catalog, &1.id}) ++
          Enum.map(state.rotations, &{:rotation, &1.id})
      )

    trigger_keys = Enum.map(triggers, &{&1.kind, &1.id})
    bytes = Enum.reduce(artifacts, 0, &(&2 + byte_size(&1.json)))
    trigger_bytes = Enum.reduce(triggers, 0, &(&2 + &1.bytes))

    triggers != [] and trigger_keys == Enum.sort(Enum.uniq(trigger_keys)) and
      Enum.all?(trigger_keys, &(not MapSet.member?(present, &1))) and
      (length(artifacts) + length(triggers) > @max_artifacts or
         bytes + trigger_bytes > @max_total_bytes)
  end

  defp security_block(original, histories, bootstrap_ids) do
    refused = authority_refusals(original, histories)

    unseen = bootstrap_ids -- original.review.observed_bootstrap_ids

    cond do
      refused != [] ->
        witnesses = authority_witnesses(refused, histories)
        block(:authority_changed, [], [], [], Enum.map(refused, &elem(&1, 1)), [], witnesses)

      unseen != [] ->
        block(:catalog_fork, [], [], unseen, [], [])

      true ->
        nil
    end
  end

  defp accepted_targets(%{accepted: nil}), do: []

  defp accepted_targets(state) do
    case Enum.find(state.catalogs, &(&1.id == state.accepted.catalog)) do
      nil ->
        []

      record ->
        case parse_json_value(record.json) do
          %{catalog: catalog} ->
            catalog_targets(catalog)

          _ ->
            []
        end
    end
  end

  defp catalog_targets(catalog) do
    Enum.flat_map(catalog.entries, fn entry ->
      reference_replica = if entry.kind == :space, do: entry.replica, else: catalog.space

      [
        {entry.replica, entry.genesis},
        {entry.replica, entry.creation},
        {reference_replica, entry.reference}
      ]
    end)
  end

  defp authority_refusals(state, histories) do
    [{state.review.space, state.review.bootstrap_id} | accepted_targets(state)]
    |> Enum.filter(fn {replica, id} ->
      case histories[replica] do
        nil -> false
        log -> Map.has_key?(Authority.analyze(schema_for(replica), log).reasons, id)
      end
    end)
    |> Enum.uniq()
  end

  defp authority_witnesses(refused, histories) do
    refused
    |> Enum.group_by(&elem(&1, 0), &elem(&1, 1))
    |> Enum.map(fn {replica, ids} ->
      %{
        replica: replica,
        frontier: Log.frontier(Map.fetch!(histories, replica)),
        op_ids: sorted(ids)
      }
    end)
    |> Enum.sort_by(& &1.replica)
  end

  defp merge_security_block(%{reason: :authority_changed} = previous, _current),
    do: previous

  defp merge_security_block(previous, %{reason: :authority_changed} = current),
    do: %{current | triggers: if(previous, do: previous.triggers, else: [])}

  defp merge_security_block(previous, nil), do: previous
  defp merge_security_block(_previous, current), do: current

  defp graph_block(context) do
    heads = binding_heads(context)
    catalog_heads = catalog_heads(context)

    forks =
      catalog_heads |> Enum.filter(&(length(&1.catalogs) > 1)) |> Enum.flat_map(& &1.catalogs)

    forks =
      Enum.reduce(context.bindings, forks, fn {_id, binding}, acc ->
        if binding.parent == nil do
          acc
        else
          context.catalogs
          |> Map.values()
          |> Enum.filter(&(&1.envelope.catalog.binding == binding.parent))
          |> Enum.reduce(acc, fn node, values ->
            if node.id != binding.prior and
                 catalog_ancestor?(binding.prior, node.id, context.catalogs),
               do: [node.id, binding.prior | values],
               else: values
          end)
        end
      end)

    pending =
      context.catalogs
      |> Map.values()
      |> Enum.filter(&(&1.pending != []))
      |> Enum.map(& &1.id)

    cond do
      length(heads) > 2 -> block(:control_history_limit, heads, forks, [], [], pending)
      length(heads) > 1 or forks != [] -> block(:catalog_fork, heads, forks, [], [], pending)
      true -> nil
    end
  end

  defp binding_heads(context) do
    parents =
      context.bindings
      |> Map.values()
      |> Enum.reject(&is_nil(&1.parent))
      |> MapSet.new(& &1.parent)

    context.bindings |> Map.keys() |> Enum.reject(&MapSet.member?(parents, &1)) |> sorted()
  end

  defp catalog_heads(context) do
    context.catalogs
    |> Map.values()
    |> Enum.group_by(& &1.envelope.catalog.binding)
    |> Enum.map(fn {binding, nodes} ->
      parents = MapSet.new(nodes, & &1.envelope.catalog.previous)

      %{
        binding: binding,
        catalogs:
          nodes |> Enum.reject(&MapSet.member?(parents, &1.id)) |> Enum.map(& &1.id) |> sorted()
      }
    end)
    |> Enum.sort_by(& &1.binding)
  end

  defp routes(%{state: %{accepted: nil}}), do: []
  defp routes(%{state: %{blocked: blocked}}) when not is_nil(blocked), do: []

  defp routes(context) do
    accepted = context.state.accepted
    node = Map.fetch!(context.catalogs, accepted.catalog)
    binding = Map.fetch!(context.bindings, accepted.binding)

    Enum.map(node.envelope.catalog.entries, fn entry ->
      %{
        replica: entry.replica,
        kind: entry.kind,
        schema: entry.schema,
        root: entry.root,
        genesis: entry.genesis,
        creation: entry.creation,
        reference: entry.reference,
        binding: binding.id,
        catalog: node.id,
        revision: node.envelope.catalog.revision,
        origin: context.bootstrap.origin,
        path: entry.route,
        url: context.bootstrap.origin <> entry.route,
        service_id: entry.service_id,
        service_key: entry.service_key,
        realm: TransportCatalog.service_realm(entry.service_id)
      }
    end)
  end

  defp overflow(context, original) do
    existing =
      MapSet.new(
        Enum.map(original.catalogs, &{:catalog, &1.id}) ++
          Enum.map(original.rotations, &{:rotation, &1.id})
      )

    count = MapSet.size(existing)
    bytes = Enum.reduce(original.catalogs ++ original.rotations, 0, &(&2 + byte_size(&1.json)))

    additions =
      (Enum.map(context.catalog_records, &Map.put(&1, :kind, :catalog)) ++
         Enum.map(context.rotation_records, &Map.put(&1, :kind, :rotation)))
      |> Enum.reject(&MapSet.member?(existing, {&1.kind, &1.id}))
      |> Enum.sort_by(&{&1.kind, &1.id})

    additions_bytes = Enum.reduce(additions, 0, &(&2 + byte_size(&1.json)))

    if count + length(additions) > @max_artifacts or bytes + additions_bytes > @max_total_bytes do
      Enum.map(additions, fn artifact ->
        %{
          kind: artifact.kind,
          id: artifact.id,
          digest: digest(artifact.json),
          bytes: byte_size(artifact.json)
        }
      end)
    end
  end

  defp histories!(raws, source) when is_list(raws) do
    if not proper_list?(raws), do: refuse(history_reason(source))

    duplicates = raws |> Enum.map(&Map.get(&1, :replica)) |> duplicate?()
    if duplicates, do: refuse(history_reason(source))

    scans = Enum.map(raws, &scan_history(&1))

    cond do
      Enum.any?(scans, &match?({:invalid, _}, &1)) ->
        refuse(history_reason(source))

      Enum.any?(scans, &match?({:unsupported, _}, &1)) ->
        refuse(unsupported_reason(source))

      true ->
        decoded = Enum.map(scans, fn {:ok, value} -> value end)
        missing = decoded |> Enum.flat_map(& &1.missing) |> sorted()

        if missing != [],
          do:
            refuse(
              if(source == :stored, do: :trust_recovery_required, else: :trust_pending),
              missing
            )

        logs = Map.new(decoded, &{&1.raw.replica, &1.log})
        raws = decoded |> Enum.map(& &1.raw) |> Enum.sort_by(& &1.replica)
        %{logs: logs, raws: raws}
    end
  end

  defp histories!(_raws, source), do: refuse(history_reason(source))

  defp scan_history(history) do
    with true <- fields?(history, @history_fields),
         true <- text?(history.replica),
         true <- proper_list?(history.frames),
         true <- proper_list?(history.rejected) do
      accepted = Enum.map(history.frames, &scan_frame(&1, history.replica, :accepted))
      rejected = Enum.map(history.rejected, &scan_rejected(&1, history.replica))

      cond do
        Enum.any?(accepted ++ rejected, &match?({:invalid, _}, &1)) ->
          {:invalid, history.replica}

        duplicate_scan_ids?(accepted) or duplicate_scan_ids?(rejected) ->
          {:invalid, history.replica}

        Enum.any?(accepted ++ rejected, &match?({:unsupported, _}, &1)) ->
          {:unsupported, history.replica}

        true ->
          build_scanned_history(history.replica, accepted, rejected)
      end
    else
      _ -> {:invalid, nil}
    end
  rescue
    _ -> {:invalid, nil}
  end

  defp scan_frame(frame, replica, mode) do
    cond do
      not is_map(frame) or Enum.sort(Map.keys(frame)) != Enum.sort(@frame_fields) ->
        {:invalid, nil}

      not closed_wire_term?(frame["body"], 64) or not closed_wire_term?(frame["cap"], 64) ->
        {:unsupported, Map.get(frame, "id")}

      true ->
        with {:ok, op} <- Wire.decode_op(frame),
             true <- canonical_b64?(frame["author"], op.author),
             true <- canonical_b64?(frame["sig"], op.sig),
             true <- op.replica == replica do
          valid = Op.valid?(op)

          case {mode, valid} do
            {expected, valid?}
            when (expected == :accepted and valid?) or
                   (expected == :rejected and not valid?) ->
              if portable_frame_size?(frame),
                do: {:ok, op, frame},
                else: {:unsupported, op.id}

            _ ->
              {:invalid, op.id}
          end
        else
          {:error, :malformed_op} -> {:unsupported, Map.get(frame, "id")}
          _ -> {:invalid, Map.get(frame, "id")}
        end
    end
  rescue
    _ -> {:invalid, nil}
  end

  defp scan_rejected(value, replica) do
    if fields?(value, [:frame, :reason]) and value.reason == :bad_signature,
      do: scan_frame(value.frame, replica, :rejected),
      else: {:invalid, nil}
  end

  defp build_scanned_history(replica, accepted, rejected) do
    accepted_ops = Enum.map(accepted, fn {:ok, op, _frame} -> op end)
    rejected_ops = Enum.map(rejected, fn {:ok, op, _frame} -> op end)
    ids = MapSet.new(accepted_ops, & &1.id)
    missing = accepted_ops |> Enum.flat_map(& &1.deps) |> Enum.reject(&MapSet.member?(ids, &1))
    ops = Map.new(accepted_ops, &{&1.id, &1})
    referenced = accepted_ops |> Enum.flat_map(& &1.deps) |> MapSet.new()
    quarantine = rejected_ops |> Enum.map(&%{op: &1, reason: :bad_signature}) |> Enum.reverse()
    log = %Log{replica: replica, ops: ops, referenced: referenced, quarantine: quarantine}

    raw = %{
      replica: replica,
      frames:
        accepted
        |> Enum.map(fn {:ok, op, frame} -> {op.id, frame} end)
        |> Enum.sort()
        |> Enum.map(&elem(&1, 1)),
      rejected:
        rejected
        |> Enum.map(fn {:ok, op, frame} -> {op.id, %{frame: frame, reason: :bad_signature}} end)
        |> Enum.sort()
        |> Enum.map(&elem(&1, 1))
    }

    cond do
      missing != [] ->
        {:ok, %{raw: raw, log: log, missing: sorted(missing)}}

      Log.verify_authenticity(log) != :ok ->
        {:invalid, replica}

      match?({:ok, _}, CatalogCutoff.derive(log)) ->
        {:ok, %{raw: raw, log: log, missing: []}}

      true ->
        {:unsupported, replica}
    end
  end

  defp merge_histories!(saved, incoming) do
    if not is_list(incoming), do: refuse(:invalid_verified_history)

    incoming_replicas =
      Enum.map(incoming, fn history ->
        if not is_map(history), do: refuse(:invalid_verified_history)
        Map.get(history, :replica)
      end)

    if duplicate?(incoming_replicas), do: refuse(:invalid_verified_history)

    saved
    |> Enum.reduce(%{}, &Map.put(&2, &1.replica, &1))
    |> then(fn acc ->
      Enum.reduce(incoming, acc, fn history, values ->
        require_fields!(history, @history_fields, :invalid_verified_history)

        Map.update(values, history.replica, history, fn prior ->
          %{
            replica: history.replica,
            frames: merge_frame_lists!(prior.frames, history.frames, & &1),
            rejected: merge_frame_lists!(prior.rejected, history.rejected, & &1.frame)
          }
        end)
      end)
    end)
    |> Map.values()
  end

  defp merge_frame_lists!(left, right, frame) do
    Enum.reduce([left, right], %{}, fn list, acc ->
      if not proper_list?(list), do: refuse(:invalid_verified_history)

      ids =
        Enum.map(list, fn item ->
          if not is_map(item), do: refuse(:invalid_verified_history)
          raw = frame.(item)
          if not is_map(raw), do: refuse(:invalid_verified_history)
          Map.get(raw, "id")
        end)

      if duplicate?(ids), do: refuse(:invalid_verified_history)

      Enum.reduce(list, acc, fn item, values ->
        id = Map.get(frame.(item), "id")

        case values[id] do
          nil ->
            Map.put(values, id, item)

          previous ->
            if equivalent_frame?(frame.(previous), frame.(item)),
              do: values,
              else: refuse(:invalid_verified_history, [id])
        end
      end)
    end)
    |> Map.values()
  end

  defp equivalent_frame?(left, right) do
    left == right
  end

  defp reviewed_bootstrap!(review, log, initial?) do
    {:ok, observed} = CatalogBootstrap.observe(log)
    ids = observed.bootstraps |> Enum.map(& &1.id) |> sorted()
    selected = Enum.find(observed.bootstraps, &(&1.id == review.bootstrap_id))

    if selected == nil do
      if Map.has_key?(Log.ops(log), review.bootstrap_id) do
        reason = Authority.analyze(Space, log).reasons[review.bootstrap_id]
        refuse(:catalog_authority_refused, [review.bootstrap_id], reason)
      else
        refuse(:trust_pending, [review.bootstrap_id])
      end
    end

    record = selected.record

    if record.space != review.space or record.space_root != review.space_root,
      do: refuse(:wrong_catalog_scope)

    if initial? and ids != review.observed_bootstrap_ids,
      do: refuse(:catalog_fork, ids)

    replacement =
      case Authority.continuation_profile(log) do
        {:ok, profile} ->
          profile.root == record.space_root and profile.profile_genesis == record.profile_genesis and
            profile.profile_id == record.profile_id

        _ ->
          false
      end

    if initial? and not replacement, do: refuse(:wrong_catalog_scope)
    {%{id: selected.id, record: record}, ids, replacement}
  end

  defp current_bootstrap!(_review, nil), do: refuse(:trust_recovery_required)

  defp current_bootstrap!(review, log) do
    op = Log.ops(log)[review.bootstrap_id] || refuse(:trust_recovery_required)

    record =
      case op do
        %Op{kind: :command, body: {:catalog_bootstrap_v1, [value]}} ->
          case TransportCatalog.normalize_bootstrap(value) do
            {:ok, normalized} -> normalized
            _ -> refuse(:trust_recovery_required)
          end

        _ ->
          refuse(:trust_recovery_required)
      end

    if record.space != review.space or record.space_root != review.space_root or
         Authority.root(log) != review.space_root,
       do: refuse(:trust_recovery_required)

    Enum.each(review.observed_bootstrap_ids, fn id ->
      case Log.ops(log)[id] do
        %Op{kind: :command, body: {:catalog_bootstrap_v1, [_]}} -> :ok
        _ -> refuse(:trust_recovery_required)
      end
    end)

    ids =
      case CatalogBootstrap.observe(log) do
        {:ok, observed} -> observed.bootstraps |> Enum.map(& &1.id) |> sorted()
        _ -> refuse(:invalid_verified_history)
      end

    replacement =
      case Authority.continuation_profile(log) do
        {:ok, profile} ->
          profile.root == record.space_root and profile.profile_genesis == record.profile_genesis and
            profile.profile_id == record.profile_id

        _ ->
          false
      end

    {record, ids, replacement}
  end

  defp catalog_fact_histories(catalog, histories) do
    targets =
      Enum.flat_map(catalog.entries, fn entry ->
        reference_replica = if entry.kind == :space, do: entry.replica, else: catalog.space

        [
          {entry.replica, entry.genesis},
          {entry.replica, entry.creation},
          {reference_replica, entry.reference}
        ]
      end)

    Enum.reduce(Enum.group_by(targets, &elem(&1, 0), &elem(&1, 1)), histories, fn
      {replica, ids}, acc ->
        case histories[replica] do
          nil ->
            acc

          log ->
            if Enum.all?(ids, &Map.has_key?(Log.ops(log), &1)) do
              Map.put(acc, replica, causal_slice!(log, ids))
            else
              acc
            end
        end
    end)
  end

  defp causal_slice!(log, frontier) do
    ops = Log.ops(log)
    ids = dependency_closure!(ops, frontier, MapSet.new())
    selected = Map.take(ops, MapSet.to_list(ids))
    slice = Log.from_ops(log.replica, selected)
    if Log.verify_authenticity(slice) != :ok, do: refuse(:trust_recovery_required)
    slice
  end

  defp dependency_closure!(_ops, [], seen), do: seen

  defp dependency_closure!(ops, [id | rest], seen) do
    if MapSet.member?(seen, id) do
      dependency_closure!(ops, rest, seen)
    else
      op = ops[id] || refuse(:trust_recovery_required)
      dependency_closure!(ops, op.deps ++ rest, MapSet.put(seen, id))
    end
  end

  defp validate_state_shape!(state) do
    require_fields!(state, @state_fields, :trust_recovery_required)
    if state.version != 1, do: refuse(:trust_recovery_required)
    review = validate_review!(state.review)

    if not proper_list?(state.histories) or not proper_list?(state.catalogs) or
         not proper_list?(state.rotations) or not proper_list?(state.cutoff_proofs),
       do: refuse(:trust_recovery_required)

    if Enum.map(state.histories, &Map.get(&1, :replica)) !=
         state.histories |> Enum.map(&Map.get(&1, :replica)) |> sorted(),
       do: refuse(:trust_recovery_required)

    validate_records!(state.catalogs)
    validate_records!(state.rotations)
    validate_proof_index_shape!(state.cutoff_proofs)

    count = length(state.catalogs) + length(state.rotations)
    bytes = Enum.reduce(state.catalogs ++ state.rotations, 0, &(&2 + byte_size(&1.json)))
    if count > @max_artifacts or bytes > @max_total_bytes, do: refuse(:trust_recovery_required)
    validate_accepted!(state.accepted)
    validate_block!(state.blocked)
    %{state | review: review}
  end

  defp validate_proof_index_shape!(proofs) do
    keys =
      Enum.map(proofs, fn proof ->
        require_fields!(proof, [:cutoff, :history], :trust_recovery_required)
        validate_cutoff!(proof.cutoff)
        require_fields!(proof.history, @history_fields, :trust_recovery_required)
        {proof.cutoff.replica, proof.cutoff.log_digest}
      end)

    if keys != Enum.sort(Enum.uniq(keys)), do: refuse(:trust_recovery_required)
  end

  defp validate_records!(records) do
    ids =
      Enum.map(records, fn record ->
        require_fields!(record, [:id, :json], :trust_recovery_required)
        if not id?(record.id) or not is_binary(record.json), do: refuse(:trust_recovery_required)
        record.id
      end)

    if ids != sorted(ids), do: refuse(:trust_recovery_required)
  end

  defp validate_accepted!(nil), do: :ok

  defp validate_accepted!(accepted) do
    require_fields!(accepted, @accepted_fields, :trust_recovery_required)

    if not id?(accepted.binding) or not id?(accepted.catalog) or not safe?(accepted.generation) or
         not safe?(accepted.revision),
       do: refuse(:trust_recovery_required)
  end

  defp validate_block!(nil), do: :ok

  defp validate_block!(value) do
    require_fields!(value, @block_fields, :trust_recovery_required)

    if value.reason not in [:catalog_fork, :authority_changed, :control_history_limit],
      do: refuse(:trust_recovery_required)

    for name <- [:bindings, :catalogs, :bootstrap_ids, :op_ids, :pending_proof_ids] do
      ids = Map.fetch!(value, name)

      if not proper_list?(ids) or not Enum.all?(ids, &id?/1) or
           ids != sorted(Enum.uniq(ids)),
         do: refuse(:trust_recovery_required)
    end

    if not proper_list?(value.triggers) or length(value.triggers) > 32,
      do: refuse(:trust_recovery_required)

    Enum.each(value.triggers, fn trigger ->
      require_fields!(trigger, [:kind, :id, :digest, :bytes], :trust_recovery_required)

      if trigger.kind not in [:catalog, :rotation] or not id?(trigger.id) or
           not id?(trigger.digest) or not safe?(trigger.bytes) or trigger.bytes == 0 or
           trigger.bytes > @max_artifact_bytes,
         do: refuse(:trust_recovery_required)
    end)

    trigger_keys = Enum.map(value.triggers, &{&1.kind, &1.id})
    if trigger_keys != Enum.sort(Enum.uniq(trigger_keys)), do: refuse(:trust_recovery_required)

    if not proper_list?(value.authority_witnesses), do: refuse(:trust_recovery_required)

    replicas =
      Enum.map(value.authority_witnesses, fn witness ->
        require_fields!(witness, [:replica, :frontier, :op_ids], :trust_recovery_required)

        if not text?(witness.replica) or not proper_list?(witness.frontier) or
             not proper_list?(witness.op_ids) or not Enum.all?(witness.frontier, &id?/1) or
             not Enum.all?(witness.op_ids, &id?/1) or witness.frontier != sorted(witness.frontier) or
             witness.frontier != sorted(Enum.uniq(witness.frontier)) or
             witness.op_ids != sorted(Enum.uniq(witness.op_ids)),
           do: refuse(:trust_recovery_required)

        witness.replica
      end)

    if replicas != sorted(Enum.uniq(replicas)), do: refuse(:trust_recovery_required)

    witness_ids = value.authority_witnesses |> Enum.flat_map(& &1.op_ids) |> sorted()

    empty_indexes =
      value.bindings == [] and value.catalogs == [] and value.bootstrap_ids == [] and
        value.pending_proof_ids == []

    if (value.reason == :authority_changed and
          (value.authority_witnesses == [] or not empty_indexes)) or
         (value.reason != :authority_changed and value.authority_witnesses != []) or
         (value.reason == :catalog_fork and value.triggers != []) or
         (value.reason == :control_history_limit and value.triggers != [] and
            (not empty_indexes or value.op_ids != [])) or
         witness_ids != value.op_ids,
       do: refuse(:trust_recovery_required)
  end

  defp validate_decision_shape!(decision) do
    if decision.reason != nil and decision.reason not in reason_values(),
      do: refuse(:trust_recovery_required)

    require_fields!(decision.detail, @detail_fields, :trust_recovery_required)

    if not ids?(decision.detail.ids) or not ids?(decision.detail.pending_proof_ids) or
         (decision.detail.core_reason != nil and not is_atom(decision.detail.core_reason)) or
         not is_boolean(decision.replacement_configured),
       do: refuse(:trust_recovery_required)

    require_fields!(decision.observed, @observed_fields, :trust_recovery_required)

    if not ids?(decision.observed.bootstrap_ids) or
         not ids?(decision.observed.binding_heads) or
         not proper_list?(decision.observed.catalog_heads),
       do: refuse(:trust_recovery_required)

    catalog_head_keys =
      Enum.map(decision.observed.catalog_heads, fn head ->
        require_fields!(head, @catalog_head_fields, :trust_recovery_required)
        if not id?(head.binding) or not ids?(head.catalogs), do: refuse(:trust_recovery_required)
        head.binding
      end)

    if catalog_head_keys != sorted(Enum.uniq(catalog_head_keys)),
      do: refuse(:trust_recovery_required)

    if not proper_list?(decision.routes), do: refuse(:trust_recovery_required)
    Enum.each(decision.routes, &validate_route_shape!/1)

    blocked_reason = decision.next.blocked && decision.next.blocked.reason

    if (blocked_reason != nil and
          (decision.kind != :retain_blocked or decision.reason != blocked_reason or
             decision.routes != [])) or
         (blocked_reason == nil and decision.kind == :retain_blocked),
       do: refuse(:trust_recovery_required)
  end

  defp validate_route_shape!(route) do
    require_fields!(route, @route_fields, :trust_recovery_required)

    valid =
      text?(route.replica) and route.kind in [:space, :thread] and
        route.schema in [:treehouse_space_v1, :treehouse_thread_v1] and
        bytes?(route.root, 32) and id?(route.genesis) and id?(route.creation) and
        id?(route.reference) and id?(route.binding) and id?(route.catalog) and
        safe?(route.revision) and text?(route.origin) and text?(route.path) and
        text?(route.url) and text?(route.service_id) and bytes?(route.service_key, 32) and
        text?(route.realm)

    if not valid, do: refuse(:trust_recovery_required)
  end

  defp validate_page!(page) do
    require_fields!(page, @page_fields, :malformed_catalog)

    if not Enum.all?(
         [page.catalogs, page.rotations, page.histories, page.cutoff_proofs],
         &proper_list?/1
       ),
       do: refuse(:malformed_catalog)

    if length(page.catalogs) + length(page.rotations) > 32,
      do: refuse(:control_history_limit)

    if not Enum.all?(page.catalogs ++ page.rotations, &is_binary/1),
      do: refuse(:malformed_catalog)
  end

  defp validate_review!(review) do
    require_fields!(review, @review_fields, :malformed_catalog)

    valid =
      review.version == 1 and review.product == :treehouse and text?(review.space) and
        Continuation.family(review.space) == {:bounded, :space} and bytes?(review.space_root, 32) and
        id?(review.bootstrap_id) and review.disposition == :pin_exact_observed_bootstrap and
        proper_list?(review.observed_bootstrap_ids) and
        Enum.all?(review.observed_bootstrap_ids, &id?/1) and
        review.observed_bootstrap_ids == sorted(review.observed_bootstrap_ids) and
        review.bootstrap_id in review.observed_bootstrap_ids

    if valid, do: review, else: refuse(:malformed_catalog)
  end

  defp validate_token!(token) do
    require_fields!(token, @token_fields, :malformed_catalog)

    if safe?(token.trust_revision) and safe?(token.history_generation),
      do: token,
      else: refuse(:malformed_catalog)
  end

  defp validate_cutoff!(cutoff) do
    require_fields!(cutoff, [:replica, :frontier, :log_digest], :malformed_catalog)

    if not text?(cutoff.replica) or not id?(cutoff.log_digest) or
         not proper_list?(cutoff.frontier) or not Enum.all?(cutoff.frontier, &id?/1) or
         cutoff.frontier != sorted(cutoff.frontier),
       do: refuse(:malformed_catalog)
  end

  defp ensure_history_subset!(proof, current, digest) do
    current_ops = Log.ops(current)

    if Enum.any?(Log.ops(proof), fn {id, op} -> current_ops[id] != op end),
      do: refuse(:recovery_incomplete, [digest])

    rejected = MapSet.new(Log.quarantine(current), &{&1.op, &1.reason})

    if Enum.any?(Log.quarantine(proof), &(not MapSet.member?(rejected, {&1.op, &1.reason}))),
      do: refuse(:recovery_incomplete, [digest])
  end

  defp inventory_extends?(before, next_entries) do
    Enum.all?(before, fn entry ->
      case Enum.find(next_entries, &(&1.replica == entry.replica)) do
        nil ->
          false

        next ->
          Enum.all?([:root, :genesis, :creation, :reference, :kind, :schema], fn key ->
            Map.fetch!(entry, key) == Map.fetch!(next, key)
          end)
      end
    end)
  end

  defp catalog_ancestor?(older, newer, catalogs) do
    Stream.unfold(newer, fn
      nil -> nil
      id -> {id, get_in(catalogs, [id, :envelope, :catalog, :previous])}
    end)
    |> Enum.take(@max_artifacts + 1)
    |> Enum.member?(older)
  end

  defp parse_json_value(json) do
    with {:ok, raw} <- Jason.decode(json),
         true <- closed_wire_term?(raw, 64),
         {:ok, value} <- Wire.decode_value(raw),
         do: value,
         else: (_ -> nil)
  end

  defp closed_wire_term?(_value, depth) when depth < 0, do: false

  defp closed_wire_term?(["map", pairs], depth) when is_list(pairs) and depth > 0 do
    Enum.all?(pairs, fn
      [key, value] ->
        closed_wire_term?(key, depth - 1) and closed_wire_term?(value, depth - 1)

      _ ->
        false
    end) and
      canonical_wire_terms_unique?(Enum.map(pairs, &hd/1))
  end

  defp closed_wire_term?([kind, values], depth)
       when kind in ["list", "tuple"] and is_list(values) and depth > 0,
       do: Enum.all?(values, &closed_wire_term?(&1, depth - 1))

  defp closed_wire_term?(["mapset", values], depth) when is_list(values) and depth > 0,
    do:
      Enum.all?(values, &closed_wire_term?(&1, depth - 1)) and
        canonical_wire_terms_unique?(values)

  defp closed_wire_term?(["delegation", value], depth) when is_map(value) and depth > 0 do
    required = ~w(id replica issuer audience parent_id ops roles live sig)
    keys = Map.keys(value)

    Enum.sort(keys) in [Enum.sort(required), Enum.sort(["expires_epoch" | required])] and
      is_binary(value["id"]) and is_binary(value["replica"]) and
      canonical_b64_text?(value["issuer"]) and canonical_b64_text?(value["audience"]) and
      canonical_b64_text?(value["sig"]) and
      (is_nil(value["parent_id"]) or is_binary(value["parent_id"])) and
      is_list(value["ops"]) and
      Enum.all?(value["ops"], &(is_binary(&1) and Map.has_key?(@cutoff_atom_by_name, &1))) and
      is_list(value["roles"]) and
      Enum.all?(value["roles"], &(is_binary(&1) and Map.has_key?(@cutoff_atom_by_name, &1))) and
      is_boolean(value["live"]) and
      (not Map.has_key?(value, "expires_epoch") or safe?(value["expires_epoch"]))
  end

  defp closed_wire_term?(["bin", encoded], _depth) when is_binary(encoded) do
    case Base.decode64(encoded) do
      {:ok, bytes} -> Base.encode64(bytes) == encoded
      _ -> false
    end
  end

  defp closed_wire_term?(["int", value], _depth) when is_integer(value), do: safe?(value)

  defp closed_wire_term?(["int", value], _depth) when is_binary(value) do
    case Integer.parse(value) do
      {integer, ""} ->
        integer > @max_safe_integer and integer <= @max_canonical_integer and
          Integer.to_string(integer) == value

      _ ->
        false
    end
  end

  defp closed_wire_term?(["atom", value], _depth) when is_binary(value),
    do: Map.has_key?(@cutoff_atom_by_name, value)

  defp closed_wire_term?(["bool", value], _depth) when is_boolean(value), do: true
  defp closed_wire_term?(["nil"], _depth), do: true
  defp closed_wire_term?(_, _depth), do: false

  defp canonical_wire_terms_unique?(terms) do
    Enum.reduce_while(terms, MapSet.new(), fn term, seen ->
      case Wire.decode_value(term) do
        {:ok, value} ->
          key = Canonical.term(value)

          if MapSet.member?(seen, key),
            do: {:halt, false},
            else: {:cont, MapSet.put(seen, key)}

        _ ->
          {:halt, false}
      end
    end)
    |> then(&is_struct(&1, MapSet))
  rescue
    _ -> false
  end

  defp issue(
         kind,
         expected,
         next,
         reason,
         replacement,
         bootstrap_ids,
         binding_heads,
         catalog_heads,
         routes
       ) do
    %{
      kind: kind,
      expected: expected,
      next: next,
      reason: reason,
      detail:
        detail(
          next.blocked && next.blocked.op_ids,
          nil,
          next.blocked && next.blocked.pending_proof_ids
        ),
      replacement_configured: replacement,
      observed: %{
        bootstrap_ids: sorted(bootstrap_ids),
        binding_heads: sorted(binding_heads),
        catalog_heads: catalog_heads
      },
      routes: routes
    }
  end

  defp block(reason, bindings, catalogs, bootstrap_ids, op_ids, pending_ids, witnesses \\ []) do
    %{
      reason: reason,
      bindings: sorted(bindings),
      catalogs: sorted(catalogs),
      bootstrap_ids: sorted(bootstrap_ids),
      op_ids: sorted(op_ids),
      pending_proof_ids: sorted(pending_ids),
      triggers: [],
      authority_witnesses: witnesses
    }
  end

  defp protect(fun) do
    fun.()
  rescue
    _ -> %{kind: :reject, reason: :malformed_catalog, detail: detail()}
  catch
    {:catalog_trust_refusal, reason, detail} -> %{kind: :reject, reason: reason, detail: detail}
  end

  defp protect_route(fun) do
    fun.()
  rescue
    _ -> %{ok: false, reason: :trust_recovery_required}
  catch
    {:catalog_trust_refusal, _reason, _detail} -> %{ok: false, reason: :trust_recovery_required}
  end

  defp refuse(reason, ids \\ [], core_reason \\ nil, pending_ids \\ []),
    do: throw({:catalog_trust_refusal, reason, detail(ids, core_reason, pending_ids)})

  defp detail(ids \\ [], core_reason \\ nil, pending_ids \\ []),
    do: %{
      ids: sorted(ids || []),
      core_reason: core_reason,
      pending_proof_ids: sorted(pending_ids || [])
    }

  defp require_fields!(value, keys, reason) do
    if not fields?(value, keys), do: refuse(reason)
  end

  defp fields?(value, keys), do: is_map(value) and Enum.sort(Map.keys(value)) == Enum.sort(keys)
  defp proper_list?(value), do: is_list(value)

  defp ids?(value),
    do: proper_list?(value) and Enum.all?(value, &id?/1) and value == sorted(Enum.uniq(value))

  defp safe?(value), do: is_integer(value) and value >= 0 and value <= @max_safe_integer
  defp text?(value), do: is_binary(value) and byte_size(value) > 0 and String.valid?(value)
  defp bytes?(value, count), do: is_binary(value) and byte_size(value) == count
  defp id?(value), do: ContinuationCertificate.id?(value)

  defp reason_values do
    [
      :malformed_catalog,
      :control_history_limit,
      :wrong_catalog_scope,
      :trust_pending,
      :invalid_catalog_signature,
      :invalid_possession,
      :catalog_authority_refused,
      :invalid_catalog_transition,
      :catalog_rollback,
      :catalog_fork,
      :recovery_incomplete,
      :carrier_pending,
      :authority_changed,
      :invalid_verified_history,
      :unsupported_cutoff,
      :trust_recovery_required,
      :stale_trust_snapshot,
      :trust_persistence_failed
    ]
  end

  defp sorted(values), do: values |> Enum.uniq() |> Enum.sort()
  defp duplicate?(values), do: length(values) != length(Enum.uniq(values))

  defp duplicate_scan_ids?(scans) do
    ids =
      Enum.map(scans, fn
        {:ok, op, _frame} -> op.id
        {_status, id} -> id
      end)

    duplicate?(ids)
  end

  defp canonical_b64?(encoded, bytes),
    do: is_binary(encoded) and Base.encode64(bytes) == encoded

  defp canonical_b64_text?(encoded) when is_binary(encoded) do
    case Base.decode64(encoded) do
      {:ok, bytes} -> Base.encode64(bytes) == encoded
      _ -> false
    end
  end

  defp canonical_b64_text?(_encoded), do: false

  defp portable_frame_size?(frame) do
    case Jason.encode(%{"type" => "push", "ops" => [frame]}) do
      {:ok, encoded} -> byte_size(encoded) <= 64_000
      _ -> false
    end
  end

  defp history_reason(:stored), do: :trust_recovery_required
  defp history_reason(:incoming), do: :invalid_verified_history
  defp unsupported_reason(:stored), do: :trust_recovery_required
  defp unsupported_reason(:incoming), do: :unsupported_cutoff
  defp digest(bytes), do: :crypto.hash(:sha256, bytes) |> Base.url_encode64(padding: false)

  defp schema_for(replica) do
    case Continuation.family(replica) do
      {:bounded, :space} -> Treehouse.Space
      {:bounded, :thread} -> Treehouse.Thread
      _ -> refuse(:invalid_verified_history)
    end
  end
end
