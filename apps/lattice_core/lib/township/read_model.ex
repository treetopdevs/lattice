defmodule Township.ReadModel do
  @moduledoc """
  Structured inputs for the Township instrument panels.

  Matter state, authority verdicts, and graph evidence are projections of the
  supplied log. Vouch bodies remain caller-held attestation evidence, outside
  `Township.Matter`. Optional realm labels affect only delegation-graph labels.
  """

  alias Lattice.{Attestation, Authority, Identity, Log, Op}
  alias Lattice.Graph.ReplicaSnapshot
  alias Township.Matter

  @member_commands [:admit, :remove_member]
  @replay_fields [
    {"title", "Title"},
    {"summary", "Summary"},
    {"posts", "Deliberation"},
    {"members", "Members"},
    {"clerk_locked", "Clerk locked"}
  ]

  @type labels :: %{optional(String.t()) => String.t()}
  @type denied_member_mutation :: %{
          op_id: String.t(),
          command: :admit | :remove_member,
          member: term(),
          reason: atom()
        }

  @type t :: %{
          threads: map(),
          roles: map(),
          members: map(),
          attest: map(),
          trust_graph: map(),
          op_dag: map()
        }

  @doc "Derive the current Township instrument inputs from a matter log and caller evidence."
  @spec observe(Log.t(), keyword()) :: t()
  def observe(%Log{} = log, opts \\ []) do
    opts =
      Keyword.validate!(opts,
        labels: %{},
        vouches: [],
        attestation: Lattice.Attestation.Stub
      )

    labels = Keyword.fetch!(opts, :labels)
    vouches = Keyword.fetch!(opts, :vouches)
    attestation = Keyword.fetch!(opts, :attestation)
    state = Lattice.state(Matter, log)
    state_view = state_view(state)
    analysis = Authority.analyze(Matter, log)
    receipt_free? = Attestation.receipt_free?(attestation)

    %{
      threads: %{
        title: state_view["title"],
        summary: state_view["summary"],
        posts: state_view["posts"],
        clerk_locked?: state_view["clerk_locked"]
      },
      roles: %{
        holders: fingerprint_holders(analysis.holders),
        quarantine: analysis.quarantine |> MapSet.to_list() |> Enum.sort(),
        reasons: analysis.reasons,
        audit: analysis.audit
      },
      members: %{
        current: state_view["members"],
        denied: denied_member_mutations(log, analysis.reasons)
      },
      attest: %{
        tally: Attestation.tally(attestation, vouches),
        receipt_free?: receipt_free?,
        status: if(receipt_free?, do: :real, else: :stubbed)
      },
      trust_graph: trust_graph(log, labels),
      op_dag: ReplicaSnapshot.build(Matter, log)
    }
  end

  @doc "Build the JSON-safe causal replay payload for the Township instrument."
  @spec replay(Log.t()) :: map()
  def replay(%Log{} = log) do
    ordered_ops = Log.topo_ops(log)
    graph = ReplicaSnapshot.build(Matter, log)

    %{
      "schema" => "township-causal-replay-v1",
      "nodes" => replay_nodes(graph.nodes, log),
      "edges" => Enum.map(graph.edges, &stringify_keys/1),
      "frames" => replay_frames(log, ordered_ops),
      "fields" => replay_fields(ordered_ops)
    }
  end

  defp replay_nodes(nodes, log) do
    Enum.map(nodes, fn node ->
      {:ok, op} = Log.fetch(log, node.id)

      node
      |> Map.put(:field, operation_field(op))
      |> stringify_keys()
    end)
  end

  defp replay_frames(log, ordered_ops) do
    ordered_ops
    |> Enum.with_index()
    |> Enum.map(fn {head, index} ->
      prefix = Enum.take(ordered_ops, index + 1)
      sub_log = Log.from_ops(log.replica, Map.new(prefix, &{&1.id, &1}))
      frontier = Log.frontier(sub_log)
      analysis = Authority.analyze(Matter, sub_log)

      %{
        "index" => index,
        "head" => head.id,
        "visible_ids" => sub_log |> Log.op_ids() |> Enum.sort(),
        "frontier" => frontier,
        "state" => Matter |> Lattice.state_at(log, frontier) |> state_view(),
        "holders" => json_holders(analysis.holders),
        "quarantine" => json_reasons(analysis.reasons)
      }
    end)
  end

  defp replay_fields(ordered_ops) do
    writers =
      Enum.reduce(ordered_ops, %{}, fn op, acc ->
        case operation_field(op) do
          nil -> acc
          field -> Map.update(acc, field, [op.id], &(&1 ++ [op.id]))
        end
      end)

    Enum.map(@replay_fields, fn {id, label} ->
      %{"id" => id, "label" => label, "writers" => Map.get(writers, id, [])}
    end)
  end

  defp operation_field(%Op{kind: :command, body: {command, args}}) when is_list(args) do
    case Matter.__apply_command__(command, args) |> Enum.map(&elem(&1, 0)) |> Enum.uniq() do
      [field] -> replay_field_id(field)
      _other -> nil
    end
  rescue
    ArgumentError -> nil
  end

  defp operation_field(%Op{}), do: nil

  defp replay_field_id(field) do
    field
    |> Atom.to_string()
    |> String.trim_trailing("?")
  end

  defp state_view(state) do
    %{
      "title" => state.title,
      "summary" => state.summary,
      "posts" => state.posts,
      "members" => Enum.sort(state.members),
      "clerk_locked" => state.clerk_locked?
    }
  end

  defp json_holders(holders) do
    Map.new(holders, fn {role, pub} ->
      {Atom.to_string(role), pub && Identity.fingerprint(pub)}
    end)
  end

  defp json_reasons(reasons) do
    Map.new(reasons, fn {id, reason} -> {id, Atom.to_string(reason)} end)
  end

  defp stringify_keys(map) do
    Map.new(map, fn {key, value} -> {Atom.to_string(key), value} end)
  end

  defp fingerprint_holders(holders) do
    Map.new(holders, fn {role, pub} ->
      {role, pub && Identity.fingerprint(pub)}
    end)
  end

  @spec denied_member_mutations(Log.t(), %{String.t() => atom()}) ::
          [denied_member_mutation()]
  defp denied_member_mutations(log, reasons) do
    log
    |> Log.topo_ops()
    |> Enum.flat_map(fn op ->
      with {:ok, reason} <- Map.fetch(reasons, op.id),
           {:ok, command, member} <- member_mutation(op) do
        [%{op_id: op.id, command: command, member: member, reason: reason}]
      else
        _not_denied_member_mutation -> []
      end
    end)
  end

  defp member_mutation(%{kind: :command, body: {command, [member]}})
       when command in @member_commands,
       do: {:ok, command, member}

  defp member_mutation(_op), do: :error

  defp trust_graph(log, labels) when is_map(labels) do
    events = delegation_events(log)

    nodes =
      events
      |> Enum.flat_map(fn {_kind, delegation} -> [delegation.issuer, delegation.audience] end)
      |> Enum.uniq()
      |> Enum.map(fn pub ->
        fingerprint = Identity.fingerprint(pub)
        label = if name = labels[fingerprint], do: "#{name} #{fingerprint}", else: fingerprint
        %{id: fingerprint, kind: "realm", label: label}
      end)

    edges =
      Enum.map(events, fn {kind, delegation} ->
        %{
          from: Identity.fingerprint(delegation.issuer),
          to: Identity.fingerprint(delegation.audience),
          kind: delegation_edge_kind(kind, delegation)
        }
      end)

    %{nodes: nodes, edges: edges}
  end

  defp delegation_events(log) do
    log
    |> Log.topo_ops()
    |> Enum.filter(&(&1.kind == :authority))
    |> Enum.flat_map(fn op ->
      case op.body do
        {:genesis, delegation, _policies} -> [{"genesis", delegation}]
        {:grant, delegation} -> [{"grant", delegation}]
        {:transfer, role, delegation, _tick} -> [{"transfer:#{role}", delegation}]
        {:succeed, role, delegation, _tick} -> [{"succeed:#{role}", delegation}]
        _other -> []
      end
    end)
  end

  defp delegation_edge_kind(kind, delegation) do
    roles =
      if MapSet.size(delegation.roles) > 0 do
        " roles=[#{delegation.roles |> Enum.sort() |> Enum.join(",")}]"
      else
        ""
      end

    "#{kind}#{roles} ops=[#{delegation.ops |> Enum.sort() |> Enum.join(",")}]"
  end
end
