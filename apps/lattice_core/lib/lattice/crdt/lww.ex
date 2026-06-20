defmodule Lattice.Crdt.Lww do
  @moduledoc """
  Last-Writer-Wins register (state-based CvRDT).

  A write carries a `tag`; merge keeps the write with the greatest tag, breaking
  exact ties by the greater value (Erlang term order) so the join is commutative,
  associative, and idempotent even under pathological equal tags. In Lattice
  reduction the tag is `{causal_height, op_id}`, which respects causality (a write
  that causally follows another has a strictly greater height) and is deterministic
  for concurrent writes (op-id tiebreak). These are exactly the CRDT laws the
  property suite checks.
  """

  defstruct value: nil, tag: nil, present?: false

  @type tag :: term()
  @type t :: %__MODULE__{value: term(), tag: tag(), present?: boolean()}

  @spec new() :: t()
  def new, do: %__MODULE__{}

  @doc "Record a write with an ordering `tag`."
  @spec put(t(), term(), tag()) :: t()
  def put(%__MODULE__{present?: false}, value, tag),
    do: %__MODULE__{value: value, tag: tag, present?: true}

  def put(%__MODULE__{} = lww, value, tag) do
    merge(lww, %__MODULE__{value: value, tag: tag, present?: true})
  end

  @doc "Join two registers (commutative, associative, idempotent)."
  @spec merge(t(), t()) :: t()
  def merge(%__MODULE__{present?: false}, b), do: b
  def merge(a, %__MODULE__{present?: false}), do: a

  def merge(%__MODULE__{} = a, %__MODULE__{} = b) do
    cond do
      a.tag > b.tag -> a
      b.tag > a.tag -> b
      # Equal tags: deterministic tiebreak on value so merge stays commutative.
      a.value >= b.value -> a
      true -> b
    end
  end

  @doc "Read the register, falling back to `default` if never written."
  @spec value(t(), term()) :: term()
  def value(%__MODULE__{present?: false}, default), do: default
  def value(%__MODULE__{value: value}, _default), do: value
end
