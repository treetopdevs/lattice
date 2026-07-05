defmodule Lattice.Crdt.CausalList do
  @moduledoc """
  Causal-order list (state-based CvRDT), RGA-style.

  Each element is inserted with a unique `id` (its insert op's id) and an ordering
  `sort_key`. Elements are laid out by `{sort_key, id}`; deletes are tombstones.
  In Lattice reduction the sort key is `{causal_height, op_id}`, so:

    * an element that causally follows another sorts after it (height is strictly
      greater along a causal chain), preserving intended order;
    * concurrent inserts get a deterministic, identical order on every realm
      (op-id tiebreak).

  Merge unions elements (ids are content hashes, so identical id ⇒ identical
  content) and unions tombstones — commutative, associative, idempotent.
  """

  defstruct elements: %{}, tombstones: MapSet.new()

  @type id :: term()
  @type element :: %{value: term(), sort_key: term()}
  @type t :: %__MODULE__{elements: %{id() => element()}, tombstones: MapSet.t(id())}

  @spec new() :: t()
  def new, do: %__MODULE__{}

  @doc "Insert `value` with unique `id` and ordering `sort_key`."
  @spec insert(t(), id(), term(), term()) :: t()
  def insert(%__MODULE__{} = list, id, value, sort_key) do
    %{list | elements: Map.put_new(list.elements, id, %{value: value, sort_key: sort_key})}
  end

  @doc "Tombstone the element with `id` (idempotent; safe if id unknown)."
  @spec delete(t(), id()) :: t()
  def delete(%__MODULE__{} = list, id), do: %{list | tombstones: MapSet.put(list.tombstones, id)}

  @doc "Join two lists."
  @spec merge(t(), t()) :: t()
  def merge(%__MODULE__{} = a, %__MODULE__{} = b) do
    %__MODULE__{
      elements: Map.merge(a.elements, b.elements),
      tombstones: MapSet.union(a.tombstones, b.tombstones)
    }
  end

  @doc "Live entries (id + value) in causal order."
  @spec entries(t()) :: [%{id: id(), value: term()}]
  def entries(%__MODULE__{elements: elements, tombstones: tombstones}) do
    elements
    |> Enum.reject(fn {id, _el} -> MapSet.member?(tombstones, id) end)
    |> Enum.sort_by(fn {id, %{sort_key: key}} -> {key, id} end)
    |> Enum.map(fn {id, %{value: value}} -> %{id: id, value: value} end)
  end

  @doc "Ordered list of values."
  @spec value(t()) :: [term()]
  def value(%__MODULE__{} = list), do: list |> entries() |> Enum.map(& &1.value)
end
