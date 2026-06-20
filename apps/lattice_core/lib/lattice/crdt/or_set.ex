defmodule Lattice.Crdt.OrSet do
  @moduledoc """
  Observed-Remove Set (state-based CvRDT), add-wins under concurrency.

  Every add tags its element with a unique tag (the add op's id). A remove is an
  *observed* remove: it retires only the tags it has actually seen. Concurrent
  adds carry tags the remover never observed, so they survive — the add-wins rule.

  Merge is union of per-element add-tags and union of the retired-tag set: trivially
  commutative, associative, idempotent. In Lattice reduction the "observed tags" of
  a remove op are the add-tags for that element that lie in the remove's causal
  ancestry, which makes the result independent of delivery order.
  """

  defstruct adds: %{}, removed: MapSet.new()

  @type tag :: term()
  @type t :: %__MODULE__{adds: %{term() => MapSet.t(tag())}, removed: MapSet.t(tag())}

  @spec new() :: t()
  def new, do: %__MODULE__{}

  @doc "Add `elem` tagged with a unique `tag`."
  @spec add(t(), term(), tag()) :: t()
  def add(%__MODULE__{} = set, elem, tag) do
    %{set | adds: Map.update(set.adds, elem, MapSet.new([tag]), &MapSet.put(&1, tag))}
  end

  @doc """
  Observed remove: retire exactly the given `observed_tags`. This is the form used
  by reduction, where `observed_tags` are the causally-visible add-tags.
  """
  @spec remove(t(), [tag()] | MapSet.t(tag())) :: t()
  def remove(%__MODULE__{} = set, observed_tags) do
    %{set | removed: MapSet.union(set.removed, MapSet.new(observed_tags))}
  end

  @doc "Convenience remove that retires all currently-present tags of `elem`."
  @spec remove_elem(t(), term()) :: t()
  def remove_elem(%__MODULE__{} = set, elem) do
    remove(set, Map.get(set.adds, elem, MapSet.new()))
  end

  @doc "Join two sets."
  @spec merge(t(), t()) :: t()
  def merge(%__MODULE__{} = a, %__MODULE__{} = b) do
    %__MODULE__{
      adds: Map.merge(a.adds, b.adds, fn _elem, t1, t2 -> MapSet.union(t1, t2) end),
      removed: MapSet.union(a.removed, b.removed)
    }
  end

  @doc "Tags currently observed for `elem` (used to compute observed removes)."
  @spec tags_for(t(), term()) :: MapSet.t(tag())
  def tags_for(%__MODULE__{adds: adds}, elem), do: Map.get(adds, elem, MapSet.new())

  @doc "Current membership: elements with at least one surviving add-tag."
  @spec value(t()) :: MapSet.t(term())
  def value(%__MODULE__{adds: adds, removed: removed}) do
    for {elem, tags} <- adds,
        MapSet.size(MapSet.difference(tags, removed)) > 0,
        into: MapSet.new() do
      elem
    end
  end

  @doc "Membership as a sorted list (stable display order)."
  @spec to_list(t()) :: [term()]
  def to_list(%__MODULE__{} = set), do: set |> value() |> Enum.sort()
end
