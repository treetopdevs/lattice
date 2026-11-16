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
  not the C10 R04-successor case, so C10 to C15 stay open. Once a replacement op exists the
  graph, not a `CatalogTrust` block, decides what is served, so an old-key catalog fork cannot
  stop an accepted replacement.
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

  @doc "Wrap a bare `CatalogTrust` state as an installed state with nothing served yet."
  @spec wrap(map()) :: map()
  def wrap(trust),
    do: %{trust: trust, binding: @empty_binding, extra: %{catalogs: []}, routes: []}

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
      _ -> mirrored(installed, decision, trust, extra)
    end
  end

  # --- no replacement op: CatalogTrust's decision, plus the mirrored watermark --------------

  defp mirrored(installed, decision, trust, extra) do
    binding = mirror(installed.binding, trust.accepted, decision.routes)
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

  defp mirror(binding, nil, _routes), do: binding

  defp mirror(%{accepted: previous} = binding, accepted, routes) do
    cumulative = (previous && Map.get(previous, :routes, %{})) || %{}
    added = Map.new(routes, &{&1.path, &1.replica})
    %{binding | accepted: Map.put(accepted, :routes, Map.merge(cumulative, added))}
  end

  # --- a replacement op exists: the graph decides --------------------------------------------

  defp composed(installed, decision, trust, extra, {logs, space, ops}) do
    {ready, waiting} = ready(extra.catalogs, ops)

    case graph_input(installed, trust, ready, {logs, space}) do
      {:ok, input} ->
        result = CatalogBindingGraph.resolve(input)
        advanced = CatalogBindingGraph.advance(installed.binding, result)
        outcome(installed, decision, trust, extra, {result, advanced}, waiting)

      :error ->
        %{kind: :reject, reason: :trust_recovery_required, detail: detail()}
    end
  end

  defp outcome(installed, decision, trust, extra, {result, advanced}, waiting) do
    binding = Map.take(advanced, [:accepted, :frozen])
    routes = serve(result, advanced, installed)
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

  # Sidecar catalogs whose binding is a held replacement op reach the graph; the rest wait.
  defp ready(jsons, ops) do
    held = MapSet.new(ops)

    {ready, waiting} =
      Enum.split_with(jsons, fn json ->
        case TransportCatalog.decode_catalog_json(json) do
          {:ok, %{catalog: %{binding: binding}}} -> MapSet.member?(held, binding)
          _ -> false
        end
      end)

    {ready, length(waiting)}
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
