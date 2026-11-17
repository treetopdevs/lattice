defmodule Lattice.Audit.Backlog do
  @moduledoc """
  A bounded backlog of Audit records owed by one authority process (row 313).

  `Lattice.CapStore` and `Lattice.Topology` write their Audit records from
  inside `handle_call`. Before row 313 they used `Lattice.Audit.record/2`, so an
  Audit restart exited the authority process and wiped every cap and tab, which
  live only in memory. Each of those processes now keeps one `Backlog` in its
  state and writes through it.

  This is a plain struct with functions, not a process. It never arms timers
  and never reads the mailbox; the owning GenServer does that.

  Semantics, following the row 310 LiveOps pattern (D-238, D-240, D-249, D-253):

    * A record is written on time only when nothing is owed (no queued record
      and no unwritten gap), so the per-source order is kept. An on-time
      record is byte-identical to the pre-row-313 one.
    * Otherwise, or when `Lattice.Audit.try_record/2` reports
      `{:error, :unavailable}`, the record is queued and gets
      `audit_deferred: true`, `audit_source: source` and `audit_seq: n` when it
      is replayed. `audit_seq` is a per-source counter assigned at enqueue; it
      orders records within one source only.
    * When the queue holds `limit` records, a further record is dropped and
      counted in the `:backlog_full` gap. The owner uses `full?/1` to refuse
      authority-increasing actions before that happens to their own record.
    * A flush writes each nonzero gap as one `:audit_gap` record
      (`%{source: module, dropped: n, reason: :backlog_full | :reset}`) before
      any queued record, then the queue oldest first, and stops at the first
      `{:error, :unavailable}`. A stalled Audit (timeout) still exits the
      caller (D-238).

  Nothing here is durable: a crash of the owning process loses the backlog.
  """

  alias Lattice.Audit

  @default_limit 10_000
  @default_retry_ms 1_000
  @default_allowance 500
  @gap_reasons [:backlog_full, :reset]

  @enforce_keys [:source, :limit]
  defstruct source: nil,
            limit: @default_limit,
            queue: :queue.new(),
            size: 0,
            seq: 0,
            gap: %{backlog_full: 0, reset: 0}

  @typedoc "A per-source bounded Audit backlog."
  @type t :: %__MODULE__{
          source: module(),
          limit: non_neg_integer(),
          queue: :queue.queue({atom(), map()}),
          size: non_neg_integer(),
          seq: non_neg_integer(),
          gap: %{backlog_full: non_neg_integer(), reset: non_neg_integer()}
        }

  @typedoc "The result of one `flush/2` pass."
  @type flush_result :: %{flushed: non_neg_integer(), outcome: :ok | :more | :unavailable}

  @doc """
  Returns an empty backlog for `source`.

  The queue limit is read from `:lattice_core, :authority_audit_backlog_limit`
  (default 10_000) when this runs, so a changed env takes effect at the next
  `new/1` (process start or `discard_into_gap/2`).
  """
  @spec new(module()) :: t()
  def new(source) when is_atom(source) do
    limit = Application.get_env(:lattice_core, :authority_audit_backlog_limit, @default_limit)
    %__MODULE__{source: source, limit: limit}
  end

  @doc """
  Records one Audit event through the backlog.

  Returns `{:written, t}` when Audit took it on time, `{:deferred, t}` when it
  was queued, and `{:dropped, t}` when the queue was full; a dropped record
  adds 1 to the `:backlog_full` gap.
  """
  @spec record(t(), atom(), map()) :: {:written | :deferred | :dropped, t()}
  def record(%__MODULE__{} = t, type, metadata) when is_atom(type) and is_map(metadata) do
    if owed?(t) do
      enqueue(t, type, metadata)
    else
      case Audit.try_record(type, metadata) do
        {:ok, _record} -> {:written, t}
        {:error, :unavailable} -> enqueue(t, type, metadata)
      end
    end
  end

  @doc "True when the queue holds `limit` records, so the next record would be dropped."
  @spec full?(t()) :: boolean()
  def full?(%__MODULE__{size: size, limit: limit}), do: size >= limit

  @doc """
  Writes owed records to Audit, at most `allowance` of them (default 500).

  Gap records go first, one per nonzero reason, and count toward the
  allowance and toward `flushed`. Queued records follow, oldest first. Stops
  at the first `{:error, :unavailable}`. `outcome` is `:ok` when nothing is
  owed afterwards, `:more` when the allowance ran out with records still
  owed, and `:unavailable` when Audit was not there.
  """
  @spec flush(t(), non_neg_integer()) :: {t(), flush_result()}
  def flush(%__MODULE__{} = t, allowance \\ @default_allowance) do
    case flush_gaps(t, allowance, @gap_reasons, 0) do
      {t, flushed, :unavailable} ->
        {t, %{flushed: flushed, outcome: :unavailable}}

      {t, flushed, :ok} ->
        {t, written, outcome} = flush_queue(t, allowance - flushed, 0)
        {t, %{flushed: flushed + written, outcome: outcome}}
    end
  end

  @doc """
  Flushes until nothing is owed or a pass makes no progress.

  The work is bounded by the queue limit plus the gap records, so a reset
  cannot spin on an unbounded backlog (row 314).
  """
  @spec drain(t()) :: t()
  def drain(%__MODULE__{} = t) do
    if owed?(t) do
      case flush(t) do
        {t, %{flushed: 0}} -> t
        {t, %{outcome: :ok}} -> t
        {t, _result} -> drain(t)
      end
    else
      t
    end
  end

  @doc """
  Discards every queued record into the `:reset` gap and returns a fresh
  backlog built by `new/1` that carries the gap counts and the `audit_seq`
  counter (D-241).
  """
  @spec discard_into_gap(t(), :reset) :: t()
  def discard_into_gap(%__MODULE__{} = t, :reset) do
    gap = Map.update!(t.gap, :reset, &(&1 + t.size))
    %{new(t.source) | gap: gap, seq: t.seq}
  end

  @doc """
  Returns `%{pending: n, gap: g}`: `n` queued records and `g` the total number
  of records counted in unwritten gaps.
  """
  @spec status(t()) :: %{pending: non_neg_integer(), gap: non_neg_integer()}
  def status(%__MODULE__{} = t), do: %{pending: t.size, gap: gap_total(t)}

  @doc "True while any queued record or unwritten gap is owed to Audit."
  @spec owed?(t()) :: boolean()
  def owed?(%__MODULE__{} = t), do: t.size > 0 or gap_total(t) > 0

  @doc """
  The retry interval, in milliseconds, for an owner whose Audit was
  unavailable. Read from `:lattice_core, :authority_audit_retry_ms` at runtime
  (default 1_000) so tests can hold the timer off (D-257).
  """
  @spec retry_ms() :: non_neg_integer()
  def retry_ms,
    do: Application.get_env(:lattice_core, :authority_audit_retry_ms, @default_retry_ms)

  defp enqueue(%__MODULE__{} = t, type, metadata) do
    if full?(t) do
      {:dropped, %{t | gap: Map.update!(t.gap, :backlog_full, &(&1 + 1))}}
    else
      seq = t.seq + 1

      metadata =
        metadata
        |> Map.put(:audit_deferred, true)
        |> Map.put(:audit_source, t.source)
        |> Map.put(:audit_seq, seq)

      {:deferred, %{t | queue: :queue.in({type, metadata}, t.queue), size: t.size + 1, seq: seq}}
    end
  end

  defp flush_gaps(t, _allowance, [], flushed), do: {t, flushed, :ok}

  defp flush_gaps(t, allowance, [reason | rest], flushed) do
    dropped = Map.fetch!(t.gap, reason)

    cond do
      dropped == 0 ->
        flush_gaps(t, allowance, rest, flushed)

      flushed >= allowance ->
        {t, flushed, :ok}

      true ->
        metadata = %{source: t.source, dropped: dropped, reason: reason}

        case Audit.try_record(:audit_gap, metadata) do
          {:ok, _record} ->
            t = %{t | gap: Map.put(t.gap, reason, 0)}
            flush_gaps(t, allowance, rest, flushed + 1)

          {:error, :unavailable} ->
            {t, flushed, :unavailable}
        end
    end
  end

  # Queued records wait while any gap is unwritten (D-249).
  defp flush_queue(t, allowance, written) do
    cond do
      gap_total(t) > 0 ->
        {t, written, :more}

      t.size == 0 ->
        {t, written, :ok}

      allowance <= 0 ->
        {t, written, :more}

      true ->
        {:value, {type, metadata}} = :queue.peek(t.queue)

        case Audit.try_record(type, metadata) do
          {:ok, _record} ->
            t = %{t | queue: :queue.drop(t.queue), size: t.size - 1}
            flush_queue(t, allowance - 1, written + 1)

          {:error, :unavailable} ->
            {t, written, :unavailable}
        end
    end
  end

  defp gap_total(%__MODULE__{gap: gap}), do: gap.backlog_full + gap.reset
end
