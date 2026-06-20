defmodule Lattice.Net do
  @moduledoc """
  Simulated transport between in-process realms.

  `Lattice.Net` is the *cache*, not the truth (design invariant 1): it decides only
  whether two realms can currently exchange ops/messages, and in what order they
  are delivered. It never validates or stores ops — that is the log's job.

  This is the seam the spec demands stay swappable: nothing in the public API
  assumes in-process locality, so a real AtomVM/WebSocket carrier can replace this
  module without touching application code (see `docs/path_to_real.md`).

  Capabilities:

    * `partition/3` / `heal/3` — cut and restore the link between two realms;
    * `connected?/3` — gate sync and live delivery;
    * a deterministic, seeded delivery queue (`enqueue/4` + `drain/2` /
      `deliver_one/1`) for scheduling live messages in a reproducible order.

  Wall clocks are never consulted (design invariant 5); ordering is by a logical
  sequence counter and an explicit seed.
  """

  defstruct partitions: MapSet.new(), queue: [], seq: 0, seed: 0

  @type realm :: String.t()
  @type t :: %__MODULE__{
          partitions: MapSet.t({realm(), realm()}),
          queue: [map()],
          seq: non_neg_integer(),
          seed: integer()
        }

  @spec new(keyword()) :: t()
  def new(opts \\ []), do: %__MODULE__{seed: Keyword.get(opts, :seed, 0)}

  @doc "Cut the link between realms `a` and `b`."
  @spec partition(t(), realm(), realm()) :: t()
  def partition(%__MODULE__{} = net, a, b),
    do: %{net | partitions: MapSet.put(net.partitions, link(a, b))}

  @doc "Restore the link between realms `a` and `b`."
  @spec heal(t(), realm(), realm()) :: t()
  def heal(%__MODULE__{} = net, a, b),
    do: %{net | partitions: MapSet.delete(net.partitions, link(a, b))}

  @doc "True if `a` and `b` can currently exchange traffic."
  @spec connected?(t(), realm(), realm()) :: boolean()
  def connected?(%__MODULE__{partitions: p}, a, b), do: not MapSet.member?(p, link(a, b))

  @doc "True if the realms are currently partitioned."
  @spec partitioned?(t(), realm(), realm()) :: boolean()
  def partitioned?(net, a, b), do: not connected?(net, a, b)

  @doc """
  Enqueue a message for delivery from `from` to `to`. The message is held even
  while partitioned and only becomes deliverable once the link is healed —
  modelling durable, connection-independent delivery.
  """
  @spec enqueue(t(), realm(), realm(), term()) :: t()
  def enqueue(%__MODULE__{} = net, from, to, payload) do
    entry = %{seq: net.seq, from: from, to: to, payload: payload}
    %{net | queue: [entry | net.queue], seq: net.seq + 1}
  end

  @doc """
  Deliver every message whose link is currently connected, in a deterministic
  order derived from the seed and sequence numbers. Returns `{net, delivered}`
  where `delivered` is the list of messages removed from the queue (in delivery
  order). Partitioned messages remain queued.
  """
  @spec drain(t(), (map() -> any())) :: {t(), [map()]}
  def drain(%__MODULE__{} = net, _fun \\ & &1) do
    {deliverable, held} =
      Enum.split_with(net.queue, fn %{from: f, to: t} -> connected?(net, f, t) end)

    ordered = Enum.sort_by(deliverable, &delivery_key(&1, net.seed))
    {%{net | queue: held}, ordered}
  end

  @doc "Pending (not-yet-delivered) message count."
  @spec pending(t()) :: non_neg_integer()
  def pending(%__MODULE__{queue: q}), do: length(q)

  # Deterministic delivery order: a seeded permutation of sequence numbers. Same
  # seed + same enqueue order => same delivery order, every run.
  defp delivery_key(%{seq: seq}, seed) do
    :erlang.phash2({seed, seq})
  end

  defp link(a, b) when a <= b, do: {a, b}
  defp link(a, b), do: {b, a}
end
