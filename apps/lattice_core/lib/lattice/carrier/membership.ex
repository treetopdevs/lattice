defmodule Lattice.Carrier.Membership do
  @moduledoc """
  Minimal participant/frontier acknowledgement state for carrier-driven compaction GC.

  This does not compact logs; it answers whether a frontier has been acknowledged
  by every current participant.
  """

  defstruct current: MapSet.new(), left: MapSet.new(), acks: %{}

  @type t :: %__MODULE__{
          current: MapSet.t(String.t()),
          left: MapSet.t(String.t()),
          acks: %{String.t() => [String.t()]}
        }

  @spec new([String.t()]) :: t()
  def new(realms), do: %__MODULE__{current: MapSet.new(realms)}

  @spec left(t()) :: MapSet.t(String.t())
  def left(%__MODULE__{left: left}), do: left

  @spec ack(t(), String.t(), [String.t()]) :: t()
  def ack(%__MODULE__{} = membership, realm, frontier) do
    %{membership | acks: Map.put(membership.acks, realm, normalize(frontier))}
  end

  @spec leave(t(), String.t()) :: t()
  def leave(%__MODULE__{} = membership, realm) do
    %{
      membership
      | current: MapSet.delete(membership.current, realm),
        left: MapSet.put(membership.left, realm)
    }
  end

  @spec stable_frontier?(t(), [String.t()]) :: boolean()
  def stable_frontier?(%__MODULE__{} = membership, frontier) do
    frontier = normalize(frontier)

    Enum.all?(membership.current, fn realm ->
      Map.get(membership.acks, realm) == frontier
    end)
  end

  defp normalize(frontier), do: frontier |> Enum.uniq() |> Enum.sort()
end
