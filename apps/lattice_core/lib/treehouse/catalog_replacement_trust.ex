defmodule Treehouse.CatalogReplacementTrust do
  @moduledoc """
  Plan 316 row 316: a composed evaluator that lets a client which already trusts a Treehouse
  catalog accept a replacement catalog signed by an authorized admin, without the old catalog
  signer's key. It has no production caller yet and nothing dials the routes it returns.

  It is built by composition in a new file. `Treehouse.CatalogTrust` still owns everything
  that has no replacement in it (row 381 keeps the internal hook open). This module adds three
  things around it:

    * a sidecar of replacement-bound catalogs, which `CatalogTrust` refuses as `trust_pending`;
    * `Treehouse.CatalogBindingGraph.resolve/1` and `advance/2` as the authority on what is
      accepted and served once the Space history holds a `replace_catalog_v1` op; and
    * a route builder that takes the origin, service id and service key from the serving
      binding's graph node, not from the bootstrap.

  `evaluate/1` takes `%{installed, expected, incoming}` as `CatalogTrust.evaluate/1` does. The
  installed state is `%{trust, binding: %{accepted, frozen}, extra: %{catalogs: [json]},
  routes}`; build the first one with `prepare_installation/1`. A catalog whose binding is
  neither the bootstrap nor a held rotation is replacement-bound and is kept in the sidecar
  (so a first catalog may arrive before its op). Everything else goes to `CatalogTrust`, and
  its `:reject` passes through. With no `replace_catalog_v1` op in the Space history the
  `CatalogTrust` decision is returned (as `trust_decision`) with the watermark mirrored, so a
  Space without a replacement behaves as before. With one, the graph decides what is accepted
  and served, over the sidecar catalogs whose binding is a held replacement op only: a catalog
  bound to an unheld id waits in the sidecar and cannot pin the client. The result is
  `%{kind, reason, refused, next, routes, served_origin}`; `next` is the state to persist and
  `routes` is what may be served now (none while frozen). `reason` is `:trust_pending` when a
  sidecar catalog is waiting for its op and nothing else explains the result.

  A page that cannot be scanned is judged by `CatalogTrust`; an exception in the composed path
  is a `malformed_catalog` reject that changes nothing.

  Limits, all deliberate: a rotation under a replacement goes to `CatalogTrust`, which refuses
  the page as `trust_pending` (no decoder for it exists here); the sidecar has no byte budget
  (row 355) and no saved-state validation (row 395); an incomplete Space closure serves
  nothing new; and the replacement-authority check is the graph's, which for a leased admin is
  not the C10 R04-successor case, so C10 to C15 stay open.

  Block rule (D-689). The mere presence of a replacement-shaped op never widens what is served.
  Composition engages only when the resolver treats an op as a replacement node or as raw
  refusal evidence; a malformed or unauthorized op that is neither changes nothing. While
  `CatalogTrust` is blocked (authority change, fork, control history limit) its decision stands
  and nothing is served, except that a replacement the graph honors, whose first catalog it
  accepts with the serving node bound to that replacement, supersedes the block, so an old-key
  catalog fork cannot stop an accepted replacement. Routes under the bootstrap or a rotation
  binding are never served while blocked, and the graph's watermark on a replacement binding
  is never overwritten by `CatalogTrust`'s own accepted catalog.

  A sidecar catalog bound to a held replacement op is admitted only if its signature verifies
  against that op's claimed catalog key, once per catalog id; an unverifiable variant is dropped
  (the graph input is keyed by the signature-free catalog id). `wrap/1` carries `CatalogTrust`'s
  accepted watermark and cumulative routes into the graph state.
  """

  alias Lattice.Carrier.Wire
  alias Lattice.{Log, Op}

  alias Treehouse.{
    CatalogBindingGraph,
    CatalogBootstrap,
    CatalogJSON,
    CatalogTrust,
    TransportCatalog
  }

  @empty_binding %{accepted: nil, frozen: false}

  @doc "Prepare the first installed state; as `CatalogTrust.prepare_installation/1`, wrapped."
  @spec prepare_installation(map()) :: map()
  def prepare_installation(input) do
    case CatalogTrust.prepare_installation(input) do
      %{next: trust} = decision -> %{decision | next: wrap(trust)}
      decision -> decision
    end
  end

  @doc """
  Wrap a bare `CatalogTrust` state as an installed state with nothing served yet. Its accepted
  watermark (binding, catalog, and the cumulative route table of every catalog on the accepted
  chain, D-881) is carried into the graph state, so a later replacement is judged against every
  route the client already accepted.
  """
  @spec wrap(map()) :: map()
  def wrap(trust) do
    binding = %{@empty_binding | accepted: watermark(trust)}
    %{trust: trust, binding: binding, extra: %{catalogs: []}, routes: []}
  end

  # The cumulative route table is every route of every catalog on the accepted chain, walked as
  # `CatalogTrust`'s accepted support is: the accepted catalog's `previous` chain, then for each
  # rotation from the accepted binding up to the bootstrap, its prior catalog's `previous` chain.
  # If two catalogs map one route to different replicas, the newer catalog's replica is kept. A
  # link the trust state does not hold ends that branch.
  defp watermark(%{accepted: %{catalog: id, binding: binding} = accepted} = trust) do
    catalogs =
      for %{id: cid, json: json} <- trust.catalogs,
          {:ok, %{catalog: catalog}} <- [TransportCatalog.decode_catalog_json(json)],
          into: %{},
          do: {cid, catalog}

    rotations =
      for %{id: rid, json: json} <- trust.rotations,
          {:ok, %{rotation: rotation}} <- [decode_rotation(json)],
          into: %{},
          do: {rid, rotation}

    priors = rotation_priors(binding, rotations, MapSet.new())

    routes =
      Enum.reduce([id | priors], {%{}, MapSet.new()}, fn start, acc ->
        chain_routes(start, catalogs, acc)
      end)
      |> elem(0)

    Map.put(accepted, :routes, routes)
  end

  defp watermark(_trust), do: nil

  defp rotation_priors(binding, rotations, seen) do
    case rotations[binding] do
      %{prior_catalog: prior, parent: parent} ->
        if MapSet.member?(seen, binding),
          do: [],
          else: [prior | rotation_priors(parent, rotations, MapSet.put(seen, binding))]

      nil ->
        []
    end
  end

  defp chain_routes(nil, _catalogs, acc), do: acc

  defp chain_routes(id, catalogs, {routes, seen} = acc) do
    case {MapSet.member?(seen, id), catalogs[id]} do
      {false, %{} = catalog} ->
        routes = Enum.reduce(catalog.entries, routes, &Map.put_new(&2, &1.route, &1.replica))
        chain_routes(catalog.previous, catalogs, {routes, MapSet.put(seen, id)})

      _ ->
        acc
    end
  end

  @spec evaluate(term()) :: map()
  def evaluate(%{
        installed: %{trust: _, extra: %{catalogs: held}} = installed,
        expected: expected,
        incoming: incoming
      }) do
    {legacy, bound} = split(installed, incoming)
    extra = %{catalogs: (held ++ bound) |> Enum.uniq() |> Enum.sort()}

    case CatalogTrust.evaluate(%{
           installed: installed.trust,
           expected: expected,
           incoming: legacy
         }) do
      %{next: trust} = decision -> settle(installed, decision, trust, extra)
      reject -> reject
    end
  end

  # Anything else is not this module's input; CatalogTrust refuses it as it always has.
  def evaluate(input), do: CatalogTrust.evaluate(input)

  defp settle(installed, decision, trust, extra) do
    with {:ok, logs} <- logs(trust.histories),
         %Log{} = space <- logs[trust.review.space],
         [_ | _] = ops <- replace_ids(space) do
      try do
        composed(installed, decision, trust, extra, {logs, space, ops})
      rescue
        _ -> malformed()
      end
    else
      _ -> mirrored(installed, decision, trust, extra, [])
    end
  end

  # --- no replacement op: CatalogTrust's decision, plus the mirrored watermark --------------

  defp mirrored(installed, decision, trust, extra, ops) do
    binding = mirror(installed.binding, trust, decision.routes, ops)
    next = %{installed | trust: trust, binding: binding, extra: extra, routes: decision.routes}
    waiting? = extra.catalogs != []

    kind =
      if decision.kind == :unchanged and extra != installed.extra,
        do: :propose,
        else: decision.kind

    decision
    |> Map.put(:trust_decision, decision)
    |> Map.merge(%{
      kind: kind,
      reason: decision.reason || if(waiting?, do: :trust_pending),
      next: next,
      refused: %{},
      served_origin: origin(decision.routes)
    })
  end

  defp mirror(binding, %{accepted: nil}, _routes, _ops), do: binding

  defp mirror(%{accepted: previous} = binding, trust, routes, ops) do
    if previous != nil and previous.binding in ops do
      # A watermark the graph holds on a replacement binding is the graph's; CatalogTrust's own
      # accepted catalog never overwrites it.
      binding
    else
      # The accepted chain's routes too, so a route moved by several catalogs on one page stays
      # reserved (D-881).
      %{routes: chain} = accepted = watermark(trust)
      cumulative = (previous && Map.get(previous, :routes, %{})) || %{}
      added = Map.new(routes, &{&1.path, &1.replica})
      routes = cumulative |> Map.merge(chain) |> Map.merge(added)
      %{binding | accepted: %{accepted | routes: routes}}
    end
  end

  # --- a replacement op exists: the graph decides --------------------------------------------

  defp composed(installed, decision, trust, extra, {logs, space, ops}) do
    {ready, waiting, kept} = ready(extra.catalogs, ops, catalog_keys(space))
    extra = %{extra | catalogs: kept}

    case graph_input(installed, trust, ready, {logs, space}) do
      {:ok, input} ->
        result = CatalogBindingGraph.resolve(input)
        advanced = CatalogBindingGraph.advance(installed.binding, result)
        routes = serve(result, advanced, installed)

        cond do
          not engaged?(result) ->
            mirrored(installed, decision, trust, extra, ops)

          blocked?(trust) and not supersedes?(result, advanced, routes) ->
            installed
            |> mirrored(decision, trust, extra, ops)
            |> Map.put(:refused, refused(result))

          true ->
            outcome(installed, decision, trust, extra, {result, advanced, routes}, waiting)
        end

      :error ->
        %{kind: :reject, reason: :trust_recovery_required, detail: detail()}
    end
  end

  defp outcome(installed, decision, trust, extra, {result, advanced, routes}, waiting) do
    binding = Map.take(advanced, [:accepted, :frozen])
    stored = if advanced.serving == nil, do: installed.routes, else: routes
    next = %{trust: trust, binding: binding, extra: extra, routes: stored}

    %{
      kind: if(next == installed, do: :unchanged, else: :propose),
      reason: reason(result) || if(waiting > 0, do: :trust_pending),
      refused: refused(result),
      next: next,
      routes: routes,
      served_origin: origin(routes),
      expected: decision.expected,
      trust_decision: decision
    }
  end

  # A replace-shaped op only engages composition when the resolver treats it as a replacement
  # node or as raw refusal evidence. A malformed or unauthorized op that is neither changes
  # nothing. An error result (a held op with an incomplete closure, too many heads) still engages.
  defp engaged?({:ok, graph}) do
    Enum.any?(graph.nodes, fn {_id, node} -> node.kind == :replacement end) or
      map_size(graph.raw_evidence) > 0
  end

  defp engaged?(_error), do: true

  defp blocked?(trust), do: Map.get(trust, :blocked) != nil

  # A CatalogTrust block is superseded only by the serving catalog of a replacement node the graph
  # honors (the first catalog of that replacement is accepted). A bootstrap or rotation binding,
  # a replacement without its catalog, or any error never serves while CatalogTrust is blocked.
  defp supersedes?({:ok, graph}, %{serving: serving}, [_ | _]) when serving != nil do
    with %{binding: binding} <- graph.catalogs[serving],
         %{kind: :replacement} <- graph.nodes[binding] do
      true
    else
      _ -> false
    end
  end

  defp supersedes?(_result, _advanced, _routes), do: false

  defp reason({:ok, %{decision: %{block: %{reason: reason}}}}), do: reason
  defp reason({:ok, %{decision: %{reason: reason}}}), do: reason
  defp reason({:error, reason, _detail}), do: reason

  defp refused({:ok, %{raw_evidence: raw}}), do: raw
  defp refused(_), do: %{}

  defp malformed, do: %{kind: :reject, reason: :malformed_catalog, detail: detail()}
  defp detail, do: %{ids: [], core_reason: nil, pending_proof_ids: []}

  # The serving catalog's routes from its graph node; on a pending delivery the stored table,
  # and only while it is still the accepted catalog's.
  defp serve(_result, %{serving: nil}, _installed), do: []

  defp serve({:ok, graph}, %{serving: serving, accepted: accepted}, installed) do
    with %{binding: binding} = catalog <- graph.catalogs[serving],
         %{} = node <- graph.nodes[binding] do
      build(serving, catalog, node)
    else
      _ -> stored(installed, accepted, serving)
    end
  end

  defp serve(_error, %{serving: serving, accepted: accepted}, installed),
    do: stored(installed, accepted, serving)

  defp stored(installed, %{catalog: serving}, serving), do: installed.routes
  defp stored(_installed, _accepted, _serving), do: []

  defp build(id, catalog, node) do
    for entry <- catalog.entries do
      %{
        replica: entry.replica,
        kind: entry.kind,
        schema: entry.schema,
        root: entry.root,
        genesis: entry.genesis,
        creation: entry.creation,
        reference: entry.reference,
        binding: catalog.binding,
        catalog: id,
        revision: catalog.revision,
        origin: node.origin,
        path: entry.route,
        url: node.origin <> entry.route,
        service_id: entry.service_id,
        service_key: entry.service_key,
        realm: TransportCatalog.service_realm(entry.service_id)
      }
    end
  end

  defp origin([%{origin: origin} | _]), do: origin
  defp origin([]), do: nil

  # --- the graph's input, rebuilt from the retained evidence ---------------------------------

  defp graph_input(installed, trust, ready, {logs, space}) do
    with {:ok, %{bootstraps: found}} <- CatalogBootstrap.observe(space),
         %{} = bootstrap <- Enum.find(found, &(&1.id == trust.review.bootstrap_id)),
         {:ok, catalogs} <- catalogs(Enum.map(trust.catalogs, & &1.json) ++ ready),
         {:ok, rotations} <- rotations(trust.rotations) do
      {:ok,
       %{
         bootstrap: bootstrap,
         space: space,
         rotations: rotations,
         catalogs: catalogs,
         proven_cutoffs:
           Enum.map(trust.cutoff_proofs, &Map.take(&1.cutoff, [:replica, :frontier, :log_digest])),
         accepted: installed.binding.accepted,
         histories: Map.delete(logs, trust.review.space)
       }}
    else
      _ -> :error
    end
  end

  defp logs(histories) do
    Enum.reduce_while(histories, {:ok, %{}}, fn history, {:ok, acc} ->
      case restore(history) do
        {:ok, log} -> {:cont, {:ok, Map.put(acc, history.replica, log)}}
        :error -> {:halt, :error}
      end
    end)
  end

  defp restore(%{replica: replica, frames: frames}) do
    ops =
      for frame <- frames do
        {:ok, %Op{} = op} = Wire.decode_op(frame)
        op
      end

    log = Log.from_ops(replica, Map.new(ops, &{&1.id, &1}))
    if Log.verify_authenticity(log) == :ok, do: {:ok, log}, else: :error
  rescue
    _ -> :error
  end

  defp replace_ids(space) do
    for {id, %Op{kind: :command, body: {:replace_catalog_v1, _}}} <- Log.ops(space), do: id
  end

  # Sidecar catalogs whose binding is a held replacement op reach the graph, and only after their
  # signature verifies against that op's catalog key: an unverifiable variant is dropped from the
  # sidecar for good, and a catalog id is admitted once. The graph input is keyed by catalog id,
  # which excludes the signature, so a forged variant would otherwise overwrite the authentic one.
  # A catalog bound to an op that is not held waits, unverified, until its op arrives.
  defp ready(jsons, ops, keys) do
    held = MapSet.new(ops)

    {bound, waiting} =
      Enum.split_with(jsons, fn json ->
        case TransportCatalog.decode_catalog_json(json) do
          {:ok, %{catalog: %{binding: binding}}} -> MapSet.member?(held, binding)
          _ -> false
        end
      end)

    ready =
      bound
      |> Enum.filter(&verified?(&1, keys))
      |> Enum.uniq_by(fn json ->
        {:ok, envelope} = TransportCatalog.decode_catalog_json(json)
        TransportCatalog.catalog_id(envelope.catalog)
      end)

    {ready, length(waiting), Enum.sort(ready ++ waiting)}
  end

  defp verified?(json, keys) do
    with {:ok, %{catalog: %{binding: binding}} = envelope} <-
           TransportCatalog.decode_catalog_json(json),
         {:ok, key} <- Map.fetch(keys, binding) do
      TransportCatalog.verify_catalog(envelope, key) == :ok
    else
      _ -> false
    end
  end

  # The catalog key each replacement op claims, for ops of the command's arity (claim and two
  # possession proofs, as the TS decoder requires) whose claim decodes. A sidecar catalog bound to
  # an op of any other arity has no key and is dropped (D-881).
  defp catalog_keys(space) do
    for {id, %Op{kind: :command, body: {:replace_catalog_v1, [claim, _, _]}}} <- Log.ops(space),
        {:ok, %{new_catalog_key: key}} <- [TransportCatalog.normalize_replacement_claim(claim)],
        into: %{},
        do: {id, key}
  end

  defp catalogs(jsons) do
    Enum.reduce_while(jsons, {:ok, %{}}, fn json, {:ok, acc} ->
      case TransportCatalog.decode_catalog_json(json) do
        {:ok, envelope} ->
          {:cont, {:ok, Map.put(acc, TransportCatalog.catalog_id(envelope.catalog), envelope)}}

        _ ->
          {:halt, :error}
      end
    end)
  end

  defp rotations(records) do
    Enum.reduce_while(records, {:ok, %{}}, fn %{id: id, json: json}, {:ok, acc} ->
      case decode_rotation(json) do
        {:ok, envelope} -> {:cont, {:ok, Map.put(acc, id, envelope)}}
        :error -> {:halt, :error}
      end
    end)
  end

  # No public rotation JSON decoder exists, so this follows
  # `TransportCatalog.decode_catalog_json/1`: the closed JSON reader, then the wire value
  # decoder, then the rotation's own normalizer. It only reads rotations `CatalogTrust`
  # already accepted and retained, and the ids of incoming ones to place a catalog.
  defp decode_rotation(json) do
    with {:ok, raw} <- CatalogJSON.decode(json),
         {:ok, %{rotation: rotation} = envelope} <- Wire.decode_value(raw),
         {:ok, _} <- TransportCatalog.normalize_rotation(rotation) do
      {:ok, envelope}
    else
      _ -> :error
    end
  rescue
    _ -> :error
  end

  # --- partition: the legacy part to CatalogTrust, replacement-bound catalogs to the sidecar -

  defp split(_installed, incoming) when not is_map(incoming), do: {incoming, []}

  defp split(installed, incoming) do
    known =
      MapSet.new(
        [installed.trust.review.bootstrap_id] ++
          Enum.map(installed.trust.rotations, & &1.id) ++ incoming_rotation_ids(incoming)
      )

    {legacy, bound} =
      Enum.split_with(incoming.catalogs, fn json ->
        case TransportCatalog.decode_catalog_json(json) do
          {:ok, %{catalog: %{binding: binding}}} -> MapSet.member?(known, binding)
          _ -> true
        end
      end)

    {%{incoming | catalogs: legacy}, bound}
  rescue
    # A page that cannot be scanned is CatalogTrust's to refuse, whole.
    _ -> {incoming, []}
  end

  defp incoming_rotation_ids(incoming) do
    for json <- incoming.rotations, {:ok, envelope} <- [decode_rotation(json)] do
      TransportCatalog.rotation_id(envelope)
    end
  rescue
    _ -> []
  end
end
