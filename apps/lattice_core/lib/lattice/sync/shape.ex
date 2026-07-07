defmodule Lattice.Sync.Shape do
  @moduledoc "Partial-sync selectors. Selected ops are expanded to dependency closure."

  defstruct [:mode, args: []]

  @type t :: %__MODULE__{mode: :all | :commands, args: term()}

  @spec all() :: t()
  def all, do: %__MODULE__{mode: :all}

  @spec commands([atom()]) :: t()
  def commands(names) when is_list(names),
    do: %__MODULE__{mode: :commands, args: MapSet.new(names)}

  @spec selected?(t(), Lattice.Op.t()) :: boolean()
  def selected?(%__MODULE__{mode: :all}, _op), do: true

  def selected?(%__MODULE__{mode: :commands, args: names}, %{kind: :command, body: {name, _args}}) do
    MapSet.member?(names, name)
  end

  def selected?(%__MODULE__{mode: :commands, args: names}, %{kind: :command, body: {name}}) do
    MapSet.member?(names, name)
  end

  def selected?(%__MODULE__{mode: :commands}, %{kind: :authority}), do: true
  def selected?(%__MODULE__{mode: :commands}, %{kind: :tombstone}), do: true
  def selected?(%__MODULE__{}, _op), do: false
end
