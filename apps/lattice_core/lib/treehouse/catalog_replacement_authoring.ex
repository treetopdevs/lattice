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

  Retained rotations and catalogs pass an interim structural mirror of the `CatalogTrust`
  resolver (chain, step, key separation, both signatures, prior/previous presence, binding,
  inventory, cutoff and service-pair agreement) before they can become nodes or heads; any
  failure refuses, so nothing is signed over evidence Stage B rejects structurally.

  Non-claim: the binding-graph coverage here is interim. It does not observe catalog entry
  facts against retained histories, apply D-276 node eligibility (an on-Space replacement
  failing the intrinsic checks is still treated as a node), the D-275 closing rule (an old-key
  rotation of a closed binding is still chained), or the full §4 refusal precedence; those are
  Stage B resolver semantics owned by plan 316 PR 4, whose binding-graph function replaces this
  mirror once it lands (row 354).
  """

  alias Lattice.{Authority, Dag, Identity, Log, Op}
  alias Lattice.Authority.Delegation
  alias Lattice.Carrier.Wire
  alias Treehouse.{CatalogBootstrap, CatalogCutoff, MemberContinuityAuthoring, Space}
  alias Treehouse.TransportCatalog

  @request_fields ~w(author nonce parents prior_catalogs generation new_catalog_key new_service_id new_service_key new_origin entries replica_logs rotations catalogs)a
  @attempt_fields ~w(attempt_id request claim claim_bytes catalog_possession_bytes service_possession_bytes author cap frozen_frontier)a
  @zero <<0::512>>
  @max_safe_integer 9_007_199_254_740_991
  @max_artifacts 1_024
  @extended_keys ~w(root genesis creation reference kind schema)a

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
         :ok <- current_profile(log, bootstrap),
         {:ok, author, holder_epoch, cap} <- holder(log, request.author),
         {:ok, epoch, basis} <- epoch(log),
         :ok <- replacement_authority(log, holder_epoch, cap, epoch),
         :ok <- inherited_provenance(log, bootstrap.record.space_root),
         {:ok, inventory} <- inventory(log, request, bootstrap),
         {:ok, cutoffs} <- cutoffs(log, request),
         {:ok, claim} <-
           claim(log, request, bootstrap, {author, holder_epoch, cap}, {epoch, basis}, deps,
             inventory: inventory,
             cutoffs: cutoffs
           ),
         :ok <- coverage(log, claim, request, bootstrap),
         claim_bytes = TransportCatalog.replacement_claim_bytes(claim),
         :ok <- nonce_unused(log, bootstrap, claim.nonce),
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

  # Plan 316 §3 step 4: Stage B compares the claim's profile fields with the continuation pin
  # selected at the action's strict prefix, which is this frozen log. A bootstrap honored under
  # an earlier pin must not lend the claim stale fields (`wrong_catalog_scope`).
  defp current_profile(log, bootstrap) do
    case Authority.continuation_profile(log) do
      {:ok, %{profile_genesis: genesis, profile_id: id}}
      when genesis == bootstrap.record.profile_genesis and id == bootstrap.record.profile_id ->
        :ok

      _ ->
        {:error, :wrong_catalog_scope}
    end
  end

  # Plan 316 §3 step 4 resolver-specific predicates on the selected acquisition: its delegation
  # grants `replace_catalog_v1`, is not live and carries a finite lease unexpired at the claim
  # epoch. A root holder or a live/unleased capability Core would honor is refused here
  # (`catalog_authority_refused`). An acquisition whose op carries no delegation is refused.
  defp replacement_authority(log, holder_epoch, cap, epoch) do
    case acquisition_delegation(Map.get(log.ops, holder_epoch)) do
      %Delegation{id: ^cap, live: false, expires_epoch: expires} = d
      when is_integer(expires) and expires >= epoch ->
        if :replace_catalog_v1 in d.ops, do: :ok, else: {:error, :catalog_authority_refused}

      _ ->
        {:error, :catalog_authority_refused}
    end
  end

  # Plan 316 §3 step 4 inherited provenance (C11, row 335): `replace_catalog_v1` must be in
  # every honored `:admin` ceiling from the latest root-issued acquisition to the current one.
  # Core honors each hop on its own, so a narrowed ceiling followed by a transfer that
  # attenuates an older, broader cap restores a permission Stage B refuses
  # (`catalog_authority_refused`). An acquisition whose delegation is unreadable refuses.
  defp inherited_provenance(log, root) do
    delegations =
      for record <- Authority.acquisitions(Space, log, :admin) do
        case acquisition_delegation(Map.get(log.ops, record.op_id)) do
          %Delegation{id: id} = d when id == record.delegation_id -> d
          _ -> nil
        end
      end

    since_root =
      delegations
      |> Enum.reverse()
      |> Enum.split_while(&(&1 != nil and &1.issuer != root))
      |> then(fn
        {later, [%Delegation{} = rooted | _]} -> [rooted | later]
        _ -> nil
      end)

    if is_list(since_root) and Enum.all?(since_root, &(:replace_catalog_v1 in &1.ops)),
      do: :ok,
      else: {:error, :catalog_authority_refused}
  end

  defp acquisition_delegation(%Op{kind: :authority, body: body}) do
    case body do
      {:transfer, _role, %Delegation{} = d, _tick} -> d
      {:succeed, _role, %Delegation{} = d, _tick} -> d
      {:grant, %Delegation{} = d} -> d
      {:genesis, %Delegation{} = d, _policies} -> d
      _ -> nil
    end
  end

  defp acquisition_delegation(_), do: nil

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

  # The Space entry is the one a first catalog under the new binding can carry:
  # `TransportCatalog.normalize_catalog/1` requires its reference to be the bootstrap.
  defp inventory(log, request, bootstrap) do
    entries = request.entries

    if Enum.all?(entries, &service_entry?(&1, request)) and
         Enum.any?(entries, &match?(%{kind: :space}, &1)) and
         Enum.all?(entries, &(&1.kind != :space or space_entry?(&1, log, bootstrap))),
       do: {:ok, TransportCatalog.inventory_id(entries)},
       else: {:error, :application_invalid_catalog}
  rescue
    _ -> {:error, :application_invalid_catalog}
  end

  defp space_entry?(entry, log, bootstrap),
    do: entry.replica == log.replica and Map.get(entry, :reference) == bootstrap.id

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
  # rotation that resolves under the Stage B structural rules. A cited but unknown node is
  # `trust_pending`: the caller must supply the retained evidence before authoring.
  #
  # Retained rotations and catalogs are hostile until resolved: each one must pass the same
  # structural checks `CatalogTrust` applies (chain, generation/revision step, key separation,
  # both signatures, prior/previous catalog presence, binding, inventory and cutoff agreement)
  # before it may become a node, a held catalog or a head. Any failure refuses the whole
  # preflight, so a replacement is never signed over evidence Stage B would reject. Entry-fact
  # observation against the retained histories stays with the PR 4 resolver (row 354).
  defp coverage(log, claim, request, bootstrap) do
    record = bootstrap.record

    root = %{
      bootstrap.id => %{
        generation: 0,
        key: record.catalog_key,
        parents: [],
        inventory: nil,
        service: {record.service_id, record.service_key}
      }
    }

    with :ok <- artifact_budget(request),
         {:ok, rotations} <- rotation_envelopes(log, request.rotations, bootstrap),
         {:ok, catalogs} <- catalog_envelopes(log, request.catalogs, bootstrap),
         {:ok, nodes} <-
           resolve_graph(Map.merge(replacement_nodes(log, bootstrap), root), rotations, catalogs),
         :ok <- known_parents(nodes),
         {catalog_heads, held} = catalog_heads(catalogs),
         :ok <- cover_parents(claim.parents, nodes),
         :ok <- cover_generation(claim, nodes),
         :ok <- held_priors(claim, held),
         :ok <- cover_service(claim, nodes),
         :ok <- extends_priors(claim, request.entries, catalogs) do
      cover(expected_priors(claim.parents, catalog_heads), claim.prior_catalogs)
    end
  end

  # `CatalogTrust` refuses more than @max_artifacts retained artifacts as
  # `control_history_limit`. Its per-artifact and total JSON byte budgets are not mirrored
  # here (row 355): the preflight receives normalized maps, not the artifact JSON.
  defp artifact_budget(request) do
    if length(request.catalogs) + length(request.rotations) > @max_artifacts,
      do: {:error, :control_history_limit},
      else: :ok
  end

  # Step 5 (D-277): against each parent binding, a changed service key needs a changed ID.
  defp cover_service(claim, nodes) do
    if Enum.all?(claim.parents, &service_rotates?(claim, Map.fetch!(nodes, &1).service)),
      do: :ok,
      else: {:error, :invalid_catalog_transition}
  end

  defp service_rotates?(claim, {service_id, service_key}) do
    claim.new_service_key == service_key or claim.new_service_id != service_id
  end

  # Step 5 (D-277): the first catalog's entries extend every cited non-nil prior catalog.
  defp extends_priors(claim, entries, catalogs) do
    if Enum.all?(claim.prior_catalogs, fn
         %{catalog: nil} -> true
         %{catalog: id} -> inventory_extends?(Map.fetch!(catalogs, id).catalog.entries, entries)
       end),
       do: :ok,
       else: {:error, :invalid_catalog_transition}
  end

  defp expected_priors(parents, catalog_heads) do
    Enum.flat_map(parents, fn parent ->
      case Map.get(catalog_heads, parent, []) do
        [] -> [%{binding: parent, catalog: nil}]
        catalogs -> for catalog <- catalogs, do: %{binding: parent, catalog: catalog}
      end
    end)
  end

  defp rotation_envelopes(log, rotations, bootstrap) do
    Enum.reduce_while(rotations, {:ok, %{}}, fn envelope, {:ok, acc} ->
      with true <-
             is_map(envelope) and
               Enum.sort(Map.keys(envelope)) == [:new_signature, :old_signature, :rotation] and
               signature?(envelope.old_signature) and signature?(envelope.new_signature),
           {:ok, rotation} <- TransportCatalog.normalize_rotation(envelope.rotation) do
        if rotation.space == log.replica and rotation.bootstrap == bootstrap.id,
          do:
            {:cont,
             {:ok,
              Map.put(acc, TransportCatalog.rotation_id(envelope), %{
                envelope
                | rotation: rotation
              })}},
          else: {:halt, {:error, :wrong_catalog_scope}}
      else
        _ -> {:halt, {:error, :malformed_catalog}}
      end
    end)
  rescue
    _ -> {:error, :malformed_catalog}
  end

  # A catalog id covers the payload only. As in `CatalogTrust.artifacts!/6`, a repeated id must
  # carry the identical signature; any differing copy (even a second valid one) refuses.
  defp catalog_envelopes(log, catalogs, bootstrap) do
    Enum.reduce_while(catalogs, {:ok, %{}}, fn envelope, {:ok, acc} ->
      with true <-
             is_map(envelope) and Enum.sort(Map.keys(envelope)) == [:catalog, :signature] and
               signature?(envelope.signature),
           {:ok, catalog} <- TransportCatalog.normalize_catalog(envelope.catalog) do
        id = TransportCatalog.catalog_id(catalog)

        cond do
          catalog.space != log.replica or catalog.bootstrap != bootstrap.id ->
            {:halt, {:error, :wrong_catalog_scope}}

          Map.has_key?(acc, id) and acc[id].signature != envelope.signature ->
            {:halt, {:error, :invalid_catalog_signature}}

          true ->
            {:cont, {:ok, Map.put(acc, id, %{envelope | catalog: catalog})}}
        end
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
           %{
             generation: claim.generation,
             key: claim.new_catalog_key,
             parents: claim.parents,
             inventory: claim.inventory_digest,
             service: {claim.new_service_id, claim.new_service_key}
           }}
  end

  defp honored_at_prefix?(log, id) do
    ids = Dag.reachable(log.ops, [id])
    prefix = Log.from_ops(log.replica, Map.take(log.ops, MapSet.to_list(ids)))
    Authority.analyze(Space, prefix).reasons[id] == nil
  end

  # Same traversal as `CatalogTrust.graph!/6`: every catalog in id order, then every rotation.
  defp resolve_graph(nodes, rotations, catalogs) do
    graph = %{nodes: nodes, rotations: rotations, catalogs: catalogs, ready: MapSet.new()}

    graph =
      Enum.reduce(Enum.sort(Map.keys(catalogs)), graph, &resolve_catalog(&1, &2, MapSet.new()))

    graph =
      Enum.reduce(Enum.sort(Map.keys(rotations)), graph, &resolve_binding(&1, &2, MapSet.new()))

    reserve_routes(catalogs)
    {:ok, graph.nodes}
  catch
    {:catalog_refusal, reason} -> {:error, reason}
  end

  # `CatalogTrust.validate_route_history!/1`: across every held catalog a route names one
  # replica. The resolver exempts entry-pending catalogs; without entry observation (row 354)
  # this mirror holds every catalog to it, which can only refuse more.
  defp reserve_routes(catalogs) do
    catalogs
    |> Enum.sort_by(&elem(&1, 0))
    |> Enum.reduce(%{}, fn {_id, %{catalog: catalog}}, used ->
      Enum.reduce(catalog.entries, used, fn entry, routes ->
        case Map.get(routes, entry.route) do
          nil -> Map.put(routes, entry.route, entry.replica)
          replica when replica == entry.replica -> routes
          _other -> refuse(:invalid_catalog_transition)
        end
      end)
    end)
  end

  defp resolve_catalog(id, graph, visiting) do
    cond do
      MapSet.member?(graph.ready, id) -> graph
      not Map.has_key?(graph.catalogs, id) -> refuse(:trust_pending)
      MapSet.member?(visiting, {:catalog, id}) -> refuse(:invalid_catalog_transition)
      true -> resolve_unready_catalog(id, graph, MapSet.put(visiting, {:catalog, id}))
    end
  end

  defp resolve_unready_catalog(id, graph, visiting) do
    envelope = Map.fetch!(graph.catalogs, id)
    catalog = envelope.catalog
    graph = resolve_binding(catalog.binding, graph, visiting)
    binding = Map.fetch!(graph.nodes, catalog.binding)

    case TransportCatalog.verify_catalog(envelope, binding.key) do
      :ok -> :ok
      {:error, reason} -> refuse(reason)
    end

    if Enum.any?(catalog.entries, &({&1.service_id, &1.service_key} != binding.service)),
      do: refuse(:wrong_catalog_scope)

    graph = resolve_catalog_parent(catalog, binding, graph, visiting)
    %{graph | ready: MapSet.put(graph.ready, id)}
  end

  defp resolve_catalog_parent(%{previous: nil} = catalog, binding, graph, _visiting) do
    if binding.inventory != nil and
         TransportCatalog.inventory_id(catalog.entries) != binding.inventory,
       do: refuse(:invalid_catalog_transition)

    graph
  end

  defp resolve_catalog_parent(catalog, _binding, graph, visiting) do
    graph = resolve_catalog(catalog.previous, graph, visiting)
    previous = Map.fetch!(graph.catalogs, catalog.previous).catalog

    if previous.binding != catalog.binding or catalog.revision != previous.revision + 1 or
         not safe?(previous.revision + 1) or
         not inventory_extends?(previous.entries, catalog.entries),
       do: refuse(:invalid_catalog_transition)

    graph
  end

  defp resolve_binding(id, graph, visiting) do
    cond do
      Map.has_key?(graph.nodes, id) -> graph
      not Map.has_key?(graph.rotations, id) -> refuse(:trust_pending)
      MapSet.member?(visiting, {:binding, id}) -> refuse(:invalid_catalog_transition)
      true -> resolve_rotation(id, graph, MapSet.put(visiting, {:binding, id}))
    end
  end

  defp resolve_rotation(id, graph, visiting) do
    envelope = Map.fetch!(graph.rotations, id)
    rotation = envelope.rotation
    graph = resolve_binding(rotation.parent, graph, visiting)
    parent = Map.fetch!(graph.nodes, rotation.parent)

    if rotation.generation != parent.generation + 1 or not safe?(parent.generation + 1) or
         rotation.new_catalog_key == parent.key or
         rotation.new_catalog_key == elem(parent.service, 1),
       do: refuse(:invalid_catalog_transition)

    verify_rotation(envelope, parent.key)
    graph = resolve_catalog(rotation.prior_catalog, graph, visiting)
    prior = Map.fetch!(graph.catalogs, rotation.prior_catalog).catalog

    if prior.binding != rotation.parent or
         TransportCatalog.inventory_id(prior.entries) != rotation.inventory_digest or
         Enum.map(rotation.cutoffs, & &1.replica) != Enum.map(prior.entries, & &1.replica),
       do: refuse(:invalid_catalog_transition)

    node = %{
      generation: rotation.generation,
      key: rotation.new_catalog_key,
      parents: [rotation.parent],
      inventory: rotation.inventory_digest,
      service: parent.service
    }

    %{graph | nodes: Map.put(graph.nodes, id, node)}
  end

  defp verify_rotation(envelope, parent_key) do
    rotation = envelope.rotation

    cond do
      not Identity.verify(
        parent_key,
        TransportCatalog.rotation_bytes(rotation),
        envelope.old_signature
      ) ->
        refuse(:invalid_catalog_signature)

      not Identity.verify(
        rotation.new_catalog_key,
        TransportCatalog.rotation_possession_bytes(rotation),
        envelope.new_signature
      ) ->
        refuse(:invalid_possession)

      true ->
        :ok
    end
  end

  defp refuse(reason), do: throw({:catalog_refusal, reason})

  defp inventory_extends?(before, next_entries) do
    Enum.all?(before, fn entry ->
      case Enum.find(next_entries, &(&1.replica == entry.replica)) do
        nil -> false
        next -> Map.take(entry, @extended_keys) == Map.take(next, @extended_keys)
      end
    end)
  end

  defp safe?(value), do: is_integer(value) and value >= 0 and value <= @max_safe_integer

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

  # Plan 316 §4 precedence: an unknown parent is the intrinsic step-5 failure, reported before
  # the step-7 sibling (`catalog_fork`) for an omitted head.
  defp cover_parents(parents, nodes) do
    if Enum.all?(parents, &Map.has_key?(nodes, &1)),
      do: cover(heads(nodes), parents),
      else: {:error, :invalid_catalog_transition}
  end

  # Step 5: each prior entry names a cited parent and, unless `nil`, a catalog held under it.
  defp held_priors(claim, held) do
    cond do
      Enum.any?(claim.prior_catalogs, &(&1.binding not in claim.parents)) ->
        {:error, :invalid_catalog_transition}

      Enum.any?(claim.prior_catalogs, fn %{binding: binding, catalog: catalog} ->
        catalog != nil and not MapSet.member?(held, {binding, catalog})
      end) ->
        {:error, :trust_pending}

      true ->
        :ok
    end
  end

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

  # Every retained catalog has resolved; heads are those no other catalog under the same binding
  # names as `previous`.
  defp catalog_heads(catalogs) do
    verified = Enum.map(catalogs, fn {id, envelope} -> {id, envelope.catalog} end)
    previous = MapSet.new(verified, fn {_id, catalog} -> {catalog.binding, catalog.previous} end)

    heads =
      verified
      |> Enum.reject(fn {id, catalog} -> MapSet.member?(previous, {catalog.binding, id}) end)
      |> Enum.group_by(fn {_id, catalog} -> catalog.binding end, &elem(&1, 0))
      |> Map.new(fn {binding, ids} -> {binding, Enum.sort(ids)} end)

    {heads, MapSet.new(verified, fn {id, catalog} -> {catalog.binding, id} end)}
  end

  # The journal is caller-owned and may be lost or belong to another device, so a nonce already
  # carried by a retained replacement of this Space and bootstrap that Core honored at its
  # strict prefix (the same eligibility as a binding node) is reused regardless of the journal.
  # A raw, unauthorized proposal reserves nothing. No retained claim can equal a new one
  # byte-for-byte (its deps would include that op).
  defp nonce_unused(log, bootstrap, nonce) do
    reused? =
      Enum.any?(log.ops, fn
        {id, %Op{kind: :command, body: {:replace_catalog_v1, [claim | _]}}} ->
          match?(
            {:ok, %{nonce: ^nonce, space: space, bootstrap: boot}}
            when space == log.replica and boot == bootstrap.id,
            TransportCatalog.normalize_replacement_claim(claim)
          ) and honored_at_prefix?(log, id)

        _ ->
          false
      end)

    if reused?, do: {:error, :attempt_nonce_reused}, else: :ok
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
  defp signature?(value), do: is_binary(value) and byte_size(value) == 64
end
