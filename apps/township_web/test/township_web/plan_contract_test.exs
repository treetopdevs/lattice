defmodule TownshipWeb.PlanContractTest do
  use ExUnit.Case, async: true

  @repo_root Path.expand("../../../..", __DIR__)

  test "Plan 123 records the connected read-only instrument without claiming Phase G completion" do
    plan = File.read!(Path.join(@repo_root, "plans/123-township-liveview-instrument-g1.md"))
    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    package = @repo_root |> Path.join("package.json") |> File.read!() |> Jason.decode!()

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ "Phoenix 1.8.9"
    assert plan =~ "LiveView 1.1.32"
    assert plan =~ "npm run township:instrument:e2e"
    assert plan =~ "does not close Phase G or G1"

    assert build_map =~ "Plan 123 adds the Township LiveView instrument"
    assert build_map =~ "apps/township_web"
    assert build_map =~ "connected `/township` LiveView"
    assert build_map =~ "tracked **per plan"
    assert build_map =~ "plans/README.md"

    assert plans_index =~
             "| 123 | Township LiveView instrument | P1 | L | 122 | DONE |"

    assert package["scripts"]["township:instrument:e2e"] ==
             "npx --no-install playwright test --config playwright.township.config.mjs"
  end

  test "Plan 124 records the Vue causal replay without claiming a live or complete G1" do
    plan = File.read!(Path.join(@repo_root, "plans/124-township-vue-causal-replay-g1.md"))
    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    agents = File.read!(Path.join(@repo_root, "AGENTS.md"))
    package = @repo_root |> Path.join("package.json") |> File.read!() |> Jason.decode!()

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ "`Township.ReadModel.replay/1`"
    assert plan =~ "server-derived causal replay"
    assert plan =~ "carrier/PubSub feeds and write controls still remain"

    assert plans_index =~
             "| 124 | Township Vue causal replay island | P1 | L | 123 | DONE |"

    assert build_map =~ "Plan 124 adds server-derived causal replay through a Vue 3.5 canvas"
    assert build_map =~ "tracked **per plan"
    assert build_map =~ "plans/README.md"
    assert build_map =~ "Live controls and carrier/PubSub feeds remain"
    refute build_map =~ "live controls, carrier/PubSub feeds, and the Vue graph island remain"

    assert agents =~ "Vue 3.5 causal-replay island"
    assert package["devDependencies"]["vue"] == "3.5.39"
    assert package["devDependencies"]["@dagrejs/dagre"] == "3.0.0"
  end
end
