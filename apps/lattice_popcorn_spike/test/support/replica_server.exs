Code.require_file("../../browser/lib/durable.ex", __DIR__)

defmodule LatticePopcornSpike.ReplicaServer do
  @moduledoc """
  Loopback demo fixture behind Gateway, not a production enrollment service.
  The root can enroll at most two public keys and revoke their :post delegation.
  Re-enrollment never renews a revoked delegation. Browser keys never reach here.
  Structurally valid denied commands remain auditable but never materialize.
  """
  use GenServer
  alias Lattice.{Authority, BrowserLogStore, Identity, Log, Op, Sync}
  alias Lattice.Authority.Delegation
  alias Lattice.Carrier.Wire
  alias LatticeBrowser.{Durable, Notes}

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  def init(_) do
    root = Identity.generate("demo-root")
    replica = Authority.bind_replica("popcorn-durable-notes", root.pub)
    g = Delegation.genesis(root, replica, ops: [:post], roles: [])
    op = Op.new(root, replica, [], :authority, {:genesis, g, %{}})
    {:ok, %{root: root, genesis: g, log: Log.append!(Log.new(replica), op), grants: %{}}}
  end

  def handle_call(:state, _, state), do: {:reply, snapshot(state), state}

  def handle_call({:revoke, pub}, _, state) do
    case Map.fetch(state.grants, pub) do
      {:ok, grant} ->
        if Authority.revoked?(state.log, grant.id) do
          {:reply, snapshot(state), state}
        else
          if Log.size(state.log) >= 32 do
            {:reply, %{error: "log_full"}, state}
          else
            op =
              Op.new(
                state.root,
                state.log.replica,
                Log.frontier(state.log),
                :authority,
                {:revoke, grant.id}
              )

            state = %{state | log: Log.append!(state.log, op)}
            {:reply, snapshot(state), state}
          end
        end

      :error ->
        {:reply, %{error: "unknown_identity"}, state}
    end
  end

  def handle_call({:lattice_call, %{payload: payload}}, _, state) do
    {result, next} = request(payload, state)
    {:reply, result, next}
  end

  defp request(%{"action" => "enroll", "public_key" => encoded}, state) when is_binary(encoded) do
    with {:ok, pub} <- Base.decode64(encoded), true <- byte_size(pub) == 32 do
      cond do
        Map.has_key?(state.grants, encoded) ->
          {{:ok, snapshot(state)}, state}

        map_size(state.grants) >= 2 or Log.size(state.log) >= 32 ->
          {{:error, :demo_full}, state}

        true ->
          grant =
            Delegation.new(state.root, state.log.replica, pub,
              ops: [:post],
              parent_id: state.genesis.id
            )

          op =
            Op.new(
              state.root,
              state.log.replica,
              Log.frontier(state.log),
              :authority,
              {:grant, grant}
            )

          state = %{
            state
            | log: Log.append!(state.log, op),
              grants: Map.put(state.grants, encoded, grant)
          }

          {{:ok, snapshot(state)}, state}
      end
    else
      _ -> {{:error, :invalid_identity}, state}
    end
  end

  defp request(%{"action" => "sync", "ops" => encoded}, state)
       when is_list(encoded) and length(encoded) <= 32 do
    with {:ok, ops} <- Wire.decode_ops(encoded),
         true <- Enum.all?(ops, &(Op.valid?(&1) and &1.replica == state.log.replica)),
         true <- Enum.all?(ops, &(Log.has?(state.log, &1.id) or note_op?(&1))),
         {log, report} = Sync.deliver(state.log, ops),
         true <- report.rejected == [] and report.quarantined == [] and report.pending == [],
         true <- Log.size(log) <= 32 do
      next = %{state | log: log}
      analysis = Authority.analyze(Notes, log)
      # Structural receipt is explicitly distinct from semantic acceptance.
      accepted = Enum.reject(report.accepted, &MapSet.member?(analysis.quarantine, &1))
      {{:ok, Map.put(snapshot(next), "accepted", accepted)}, next}
    else
      _ -> {{:error, :invalid_sync}, state}
    end
  end

  defp request(_, state), do: {{:error, :invalid_request}, state}

  defp note_op?(%Op{kind: :command, body: {:post, [text]}}) when is_binary(text),
    do: byte_size(text) in 1..256

  defp note_op?(_), do: false

  defp snapshot(state) do
    %{
      "log" => BrowserLogStore.dump_payload(state.log),
      "view" => Durable.view(%{identity: state.root, log: state.log})
    }
  end
end
