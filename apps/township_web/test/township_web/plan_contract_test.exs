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

    assert build_map =~ ~r/Plan 123 adds the\s+Township LiveView instrument/
    assert build_map =~ "apps/township_web"
    assert build_map =~ "connected `/township` LiveView"
    assert build_map =~ "plans 023-130"

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

    assert build_map =~ "Plan 124 adds the Vue 3.5 causal-replay island"
    assert build_map =~ "plans 023-130"
    assert build_map =~ "Broader participant controls and a server-push carrier feed remain"
    refute build_map =~ "live controls, carrier/PubSub feeds, and the Vue graph island remain"

    assert agents =~ "Vue 3.5 causal-replay island"
    assert package["devDependencies"]["vue"] == "3.5.39"
    assert package["devDependencies"]["@dagrejs/dagre"] == "3.0.0"
  end

  test "Plan 126 records a pull-only carrier projection without reclaiming app or exit gates" do
    plan =
      File.read!(Path.join(@repo_root, "plans/126-township-read-only-carrier-projection-g1.md"))

    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    package = @repo_root |> Path.join("package.json") |> File.read!() |> Jason.decode!()

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ "periodic request/response feed, not server push"
    assert plan =~ "No carrier `push/2`, `live/2`"
    assert plan =~ "No stable carrier listener/server extraction"
    assert plan =~ "No Tauri onboarding/cap-persistence change"
    assert plan =~ "No receipt-free primitive, W4 change, G1/Phase G completion"

    assert plans_index =~
             "| 126 | Township read-only carrier projection | P1 | L | 125 | DONE |"

    assert build_map =~ ~r/Plan\s+126 adds the supervised pull-only carrier projection/
    assert build_map =~ "periodic request/response polling"
    assert build_map =~ "arrival-verified fresh or stale snapshots through `TownshipWeb.PubSub`"
    assert build_map =~ "Broader participant controls and a server-push carrier feed remain"

    assert build_map =~
             ~r/does not change or\s+newly prove Tauri onboarding\/cap persistence/

    assert build_map =~ ~r/mobile secure-store custody, or real app\s+convergence/
    assert build_map =~ "plans 023-130"
    refute build_map =~ "Plan 126 completes G1"
    refute build_map =~ "Plan 126 makes W4 receipt-free"

    assert package["scripts"]["township:instrument:live-e2e"] ==
             "npx --no-install playwright test --config playwright.township-live.config.mjs"
  end
end
