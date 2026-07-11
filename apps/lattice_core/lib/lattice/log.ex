defmodule Lattice.Log do
  @moduledoc """
  Append-only, per-Replica op store with causal frontier tracking.

  A `Log` is an immutable value: appending or accepting returns a new `Log`. This
  gives clean copy semantics for partition simulation — two realms simply hold two
  diverging `Log` values that `Lattice.Sync` later reconciles.

  `accept/3` is the single op-application path shared by live delivery and
  post-partition sync (design invariant 1). It performs only *structural*
  validation:

    * replica match,
    * idempotency (re-accepting a known op is a no-op),
    * signature + content-hash integrity (a tampered op is quarantined here —
      behavior 4),
    * dependency availability (an op whose `deps` are not yet present is reported
      `:missing_deps` so the caller can buffer and retry).

  *Semantic* validity — whether an op's capability proof authorizes it, whether an
  authoritative op was authored by the holder-at-its-causal-position, whether a
  delegation was revoked — is deliberately **not** decided here. That depends on
  concurrent ops that may arrive later, so it is computed deterministically at
  reduction time by `Lattice.Authority`/`Lattice.Reduce` over the whole op set.
  Nothing is dropped: structurally-rejected ops are retained in `quarantine` and
  are auditable (design invariant 4).

  Persistence: `dump/2` / `restore/1` serialize the whole log to disk for the
  realm death-and-resurrection test (behavior 14).
  """

  alias Lattice.{Dag, Op}

  defstruct replica: nil, ops: %{}, referenced: MapSet.new(), quarantine: []

  @type quarantine_entry :: %{op: Op.t(), reason: atom()}
  @type t :: %__MODULE__{
          replica: String.t(),
          ops: %{Op.id() => Op.t()},
          referenced: MapSet.t(Op.id()),
          quarantine: [quarantine_entry()]
        }

  @spec new(String.t()) :: t()
  def new(replica) when is_binary(replica), do: %__MODULE__{replica: replica}

  @doc "Build a log directly from an op map (recomputes the referenced set). Used for causal slices in time travel."
  @spec from_ops(String.t(), %{Op.id() => Op.t()}) :: t()
  def from_ops(replica, ops) when is_binary(replica) and is_map(ops) do
    referenced =
      Enum.reduce(ops, MapSet.new(), fn {_id, op}, acc ->
        MapSet.union(acc, MapSet.new(op.deps))
      end)

    %__MODULE__{replica: replica, ops: ops, referenced: referenced}
  end

  @spec has?(t(), Op.id()) :: boolean()
  def has?(%__MODULE__{ops: ops}, id), do: Map.has_key?(ops, id)

  @spec structurally_quarantined?(t(), Op.id()) :: boolean()
  def structurally_quarantined?(%__MODULE__{quarantine: q}, id),
    do: Enum.any?(q, &(&1.op.id == id))

  @spec fetch(t(), Op.id()) :: {:ok, Op.t()} | :error
  def fetch(%__MODULE__{ops: ops}, id), do: Map.fetch(ops, id)

  @spec size(t()) :: non_neg_integer()
  def size(%__MODULE__{ops: ops}), do: map_size(ops)

  @spec ops(t()) :: %{Op.id() => Op.t()}
  def ops(%__MODULE__{ops: ops}), do: ops

  @spec op_ids(t()) :: MapSet.t(Op.id())
  def op_ids(%__MODULE__{ops: ops}), do: ops |> Map.keys() |> MapSet.new()

  @doc "Ops in canonical total order (see `Lattice.Dag`)."
  @spec topo_ops(t()) :: [Op.t()]
  def topo_ops(%__MODULE__{ops: ops}), do: Dag.topo_sort(ops)

  @doc "Current causal frontier: ids of ops that no other op depends on."
  @spec frontier(t()) :: [Op.id()]
  def frontier(%__MODULE__{ops: ops, referenced: referenced}) do
    ops |> Map.keys() |> Enum.reject(&MapSet.member?(referenced, &1)) |> Enum.sort()
  end

  @doc "Structurally-rejected ops with reasons, in arrival order, for audit."
  @spec quarantine(t()) :: [quarantine_entry()]
  def quarantine(%__MODULE__{quarantine: q}), do: Enum.reverse(q)

  @doc """
  Accept an op into the log.

  Returns:
    * `{:ok, log}` — accepted (or already present; idempotent)
    * `{:quarantined, log, reason}` — structurally invalid, retained for audit
    * `{:missing_deps, log, missing_ids}` — caller should buffer until deps arrive
    * `{:rejected, log, reason}` — wrong replica; not stored
  """
  @spec accept(t(), Op.t()) ::
          {:ok, t()}
          | {:quarantined, t(), atom()}
          | {:missing_deps, t(), [Op.id()]}
          | {:rejected, t(), atom()}
  def accept(%__MODULE__{} = log, %Op{} = op) do
    cond do
      op.replica != log.replica ->
        {:rejected, log, :wrong_replica}

      has?(log, op.id) ->
        {:ok, log}

      # Signature is checked BEFORE the quarantine guard so a genuine op can never be
      # blocked by a previously-quarantined forgery sharing its id (the id excludes
      # the signature, so a forgery can poison an id otherwise). Invalid ops are
      # quarantined idempotently.
      not Op.valid?(op) ->
        if structurally_quarantined?(log, op.id) do
          {:quarantined, log, :already_quarantined}
        else
          {:quarantined, quarantine_op(log, op, :bad_signature), :bad_signature}
        end

      true ->
        case missing_deps(log, op) do
          [] -> {:ok, insert(log, op)}
          missing -> {:missing_deps, log, missing}
        end
    end
  end

  @doc """
  Append a locally-authored op. Same path as `accept/2` but raises if the op is
  not acceptable, since a realm should never author an op it cannot append.
  """
  @spec append!(t(), Op.t()) :: t()
  def append!(%__MODULE__{} = log, %Op{} = op) do
    case accept(log, op) do
      {:ok, log} ->
        log

      {other, _log, reason} ->
        raise ArgumentError, "cannot append op (#{other}): #{inspect(reason)}"
    end
  end

  defp missing_deps(%__MODULE__{} = log, %Op{deps: deps}),
    do: Enum.reject(deps, &has?(log, &1))

  defp insert(%__MODULE__{} = log, %Op{} = op) do
    %{
      log
      | ops: Map.put(log.ops, op.id, op),
        referenced: MapSet.union(log.referenced, MapSet.new(op.deps))
    }
  end

  defp quarantine_op(%__MODULE__{} = log, %Op{} = op, reason) do
    %{log | quarantine: [%{op: op, reason: reason} | log.quarantine]}
  end

  # --- Persistence (behavior 14) -------------------------------------------

  @doc "Serialize the whole log deterministically (ops + structural quarantine) to disk."
  @spec dump(t(), Path.t()) :: :ok | {:error, term()}
  def dump(%__MODULE__{} = log, path) do
    File.write(path, :erlang.term_to_binary({:lattice_log_dump_v1, log}, [:deterministic]))
  end

  @doc "Restore a log previously written with `dump/2`."
  @spec restore(Path.t()) :: {:ok, t()} | {:error, term()}
  def restore(path) do
    with {:ok, bin} <- File.read(path),
         {:ok, term} <- safe_binary_to_term(bin),
         {:lattice_log_dump_v1, %__MODULE__{} = log} <- term do
      {:ok, log}
    else
      {:error, _} = err -> err
      _ -> {:error, :corrupt_dump}
    end
  end

  # `:safe` blocks atom/resource creation from a tampered dump; a dump referencing
  # unknown atoms (or otherwise unsafe terms) raises, which we map to an error.
  defp safe_binary_to_term(bin) do
    {:ok, :erlang.binary_to_term(bin, [:safe])}
  rescue
    _ -> {:error, :unsafe_dump}
  end
end
