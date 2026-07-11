defmodule Township.ReadModel do
  @moduledoc """
  Structured inputs for the Township instrument panels.

  Matter state, authority verdicts, and graph evidence are projections of the
  supplied log. Vouch bodies remain caller-held attestation evidence, outside
  `Township.Matter`. Optional realm labels affect only delegation-graph labels.
  """

  alias Lattice.{Attestation, Authority, Identity, Log}
  alias Lattice.Graph.ReplicaSnapshot
  alias Township.{Matter, ReplayPayload}

  @member_commands [:admit, :remove_member]
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
  def replay(%Log{} = log), do: ReplayPayload.build(log)

  defp state_view(state) do
    %{
      "title" => state.title,
      "summary" => state.summary,
      "posts" => state.posts,
      "members" => Enum.sort(state.members),
      "clerk_locked" => state.clerk_locked?
    }
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
