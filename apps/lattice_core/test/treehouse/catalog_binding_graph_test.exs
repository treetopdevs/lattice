defmodule Treehouse.CatalogBindingGraphTest do
  @moduledoc """
  Plan 316 PR 4a resolver tests for `Treehouse.CatalogBindingGraph`. Every scenario in
  `Treehouse.CatalogBindingGraphScenarios` runs here with persisted accepted and blocked
  state between deliveries; each intermediate delivery is asserted against its hand-written
  label-space expectation (heads, closed, closed-out, nodes, refused, raw, refusals, pending
  cutoffs, fork kinds, decision). Disposable seeded keys only; no route, no trust.
  """
  use ExUnit.Case, async: true

  alias Treehouse.CatalogBindingGraph, as: G
  alias Treehouse.CatalogBindingGraphFixtures, as: F
  alias Treehouse.CatalogBindingGraphScenarios, as: S

  @base F.base()

  for scenario <- S.all(@base) do
    @scenario scenario
    test @scenario.name do
      @base
      |> S.run(@scenario)
      |> Enum.with_index(1)
      |> Enum.each(fn {r, i} ->
        assert r.label_view == r.expect,
               "#{@scenario.name}, delivery #{i}:\n" <>
                 inspect(r.label_view, pretty: true, limit: :infinity)
      end)
    end
  end
end
