defmodule LatticeBrowser.Notes do
  @moduledoc "Convergent demo notes, authorized exclusively by the signed v2 log."
  use Lattice.Replica

  state do
    field(:notes, merge: :causal_list)
  end

  command(:post, [:text], do: [{:notes, {:append, text}}])
end

defmodule LatticeBrowser.Durable do
  @moduledoc """
  Browser replica using the exact v2 Log/Authority/Reduce implementation.
  The trusted host atomically persists a seed and signed log in IndexedDB.
  This is not protection against XSS, storage rollback, or the browser owner.
  Cached state/verdicts are never trusted. The root is pinned at enrollment (TOFU).
  """
  alias Lattice.{Authority, BrowserLogStore, Identity, Log, Op, Reduce, Sync}
  alias Lattice.Carrier.Wire
  alias LatticeBrowser.Notes
  @max_ops 32

  @spec restore(nil | map()) :: {:ok, map()} | {:error, atom()}
  def restore(nil) do
    seed = Base.encode64(:crypto.strong_rand_bytes(32))
    {:ok, %{seed: seed, identity: Identity.from_seed("browser-replica", seed), log: nil}}
  end

  def restore(%{
        "schema" => "popcorn-replica-v1",
        "seed" => seed,
        "public_key" => pub,
        "log" => payload
      }) do
    with {:ok, bytes} <- Base.decode64(seed),
         true <- byte_size(bytes) == 32,
         identity = Identity.from_seed("browser-replica", seed),
         true <- Base.encode64(identity.pub) == pub,
         {:ok, log} <- restore_log(payload) do
      {:ok, %{seed: seed, identity: identity, log: log}}
    else
      _ -> {:error, :invalid_store}
    end
  rescue
    _ -> {:error, :invalid_store}
  end

  def restore(_), do: {:error, :invalid_store}

  @spec capsule(map()) :: map()
  def capsule(state) do
    %{
      "schema" => "popcorn-replica-v1",
      "seed" => state.seed,
      "public_key" => Base.encode64(state.identity.pub),
      "log" => if(state.log, do: BrowserLogStore.dump_payload(state.log), else: nil)
    }
  end

  @spec receive_log(map(), map()) :: {:ok, map()} | {:error, atom()}
  def receive_log(state, payload) do
    with {:ok, incoming} <- restore_log(payload),
         true <- not is_nil(incoming),
         true <- is_nil(state.log) or state.log.replica == incoming.replica,
         {:ok, merged} <- merge(state.log, incoming) do
      {:ok, %{state | log: merged}}
    else
      _ -> {:error, :invalid_replica_log}
    end
  end

  @spec post(map(), String.t()) :: {:ok, map(), Op.t()} | {:error, atom()}
  def post(%{log: %Log{} = log} = state, text)
      when is_binary(text) and byte_size(text) in 1..256 do
    cap = delegation(log, state.identity.pub)

    if Log.size(log) < @max_ops and not is_nil(cap) do
      # Offline writes are provisional: concurrent revocation can quarantine them.
      op =
        Op.new(state.identity, log.replica, Log.frontier(log), :command, {:post, [text]},
          cap: cap
        )

      next = Log.append!(log, op)

      case Map.get(Authority.analyze(Notes, next).reasons, op.id) do
        nil -> {:ok, %{state | log: next}, op}
        reason -> {:error, reason}
      end
    else
      {:error, :no_capability_or_log_full}
    end
  end

  def post(_, _), do: {:error, :invalid_post}

  @spec view(map()) :: map()
  def view(%{log: nil} = state),
    do: %{
      "public_key" => Base.encode64(state.identity.pub),
      "notes" => [],
      "op_ids" => [],
      "rejected" => %{}
    }

  def view(%{log: log} = state) do
    analysis = Authority.analyze(Notes, log)
    materialized = Reduce.reduce(Notes, log, quarantine: analysis.quarantine)

    %{
      "public_key" => Base.encode64(state.identity.pub),
      "replica" => log.replica,
      "notes" => materialized.notes,
      "op_ids" => Enum.sort(Map.keys(log.ops)),
      "frontier" => Log.frontier(log),
      "rejected" => Map.new(analysis.reasons, fn {id, reason} -> {id, Atom.to_string(reason)} end)
    }
  end

  @spec upload(map()) :: [map()]
  def upload(%{log: nil}), do: []
  def upload(%{log: log}), do: Wire.encode_ops(Log.topo_ops(log))

  @spec restore_log(nil | map()) :: {:ok, Log.t() | nil} | {:error, atom()}
  def restore_log(nil), do: {:ok, nil}

  def restore_log(%{"ops" => ops} = payload) when is_list(ops) and length(ops) <= @max_ops do
    # Wire intentionally uses existing atoms only. A cold browser VM has not
    # loaded the authority/replica vocabulary yet; load fixed trusted modules,
    # never create atoms from incoming strings.
    Code.ensure_loaded!(Authority)
    Code.ensure_loaded!(Notes)

    with {:ok, log} <- BrowserLogStore.restore_payload(payload),
         true <- Log.quarantine(log) == [],
         analysis = Authority.analyze(Notes, log),
         true <-
           Enum.any?(Log.topo_ops(log), fn op ->
             match?({:genesis, _, _}, op.body) and not MapSet.member?(analysis.quarantine, op.id)
           end) do
      {:ok, log}
    else
      _ -> {:error, :invalid_store}
    end
  rescue
    _ -> {:error, :invalid_store}
  end

  def restore_log(_), do: {:error, :invalid_store}

  defp merge(nil, log), do: {:ok, log}

  defp merge(log, incoming) do
    {merged, report} = Sync.deliver(log, Log.topo_ops(incoming))

    if Log.size(merged) <= @max_ops and report.rejected == [] and report.quarantined == [] and
         report.pending == [], do: {:ok, merged}, else: {:error, :invalid_store}
  end

  defp delegation(log, pub) do
    Log.topo_ops(log)
    |> Enum.find_value(fn
      %Op{body: {:grant, %{audience: ^pub, id: id}}} -> id
      _ -> nil
    end)
  end
end
