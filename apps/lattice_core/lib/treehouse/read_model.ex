defmodule Treehouse.ReadModel do
  @moduledoc """
  Pure Treehouse observations from retained signed logs.

  A signed Space reference authorizes which Thread is presented; merely having
  another route/log cannot add membership or a reference. Missing history stays
  unavailable. This module does not authenticate or provision transport catalogs.
  """

  alias Lattice.{Authority, Log, Reduce}
  alias Lattice.Crdt.CausalList
  alias Treehouse.{Space, Thread}

  @doc "Project state, actual authority holders and retained operation counts."
  @spec observe(module(), Log.t()) :: map()
  def observe(module, %Log{} = log) when module in [Space, Thread] do
    analysis = Authority.analyze(module, log)
    {crdts, ops} = Reduce.reduce_crdts(module, log, quarantine: analysis.quarantine)

    posts =
      if module == Thread do
        for %{id: id, value: text} <- CausalList.entries(crdts.posts),
            do: %{id: id, author: Map.fetch!(ops, id).author, text: text}
      else
        []
      end

    %{
      replica: log.replica,
      initialization: if(module == Space, do: Space.initialization(log), else: :not_applicable),
      state: Reduce.reduce(module, log, quarantine: analysis.quarantine),
      holders: analysis.holders,
      quarantine: analysis.reasons,
      operation_count: map_size(ops),
      order: Enum.map(Log.topo_ops(log), & &1.id),
      posts: posts
    }
  end

  @doc "Resolve an authorized Thread reference without inventing missing history."
  @spec thread(Log.t(), String.t(), Log.t() | nil) :: {:ok, map()} | {:error, atom()}
  def thread(%Log{} = space, replica, log) do
    referenced? = Enum.any?(Lattice.state(Space, space).threads, &(&1["replica"] == replica))

    cond do
      not referenced? -> {:error, :thread_not_authorized}
      is_nil(log) -> {:error, :thread_unavailable}
      log.replica != replica -> {:error, :wrong_replica}
      true -> {:ok, observe(Thread, log)}
    end
  end
end
