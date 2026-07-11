defmodule LatticeCarrierServer.PlanContractTest do
  use ExUnit.Case, async: true

  @repo_root Path.expand("../../..", __DIR__)

  test "Plan 127 records the stable read-only server without claiming deployment or custody" do
    plan =
      File.read!(Path.join(@repo_root, "plans/127-stable-read-only-carrier-server-g1.md"))

    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    agents = File.read!(Path.join(@repo_root, "AGENTS.md"))
    readme = File.read!(Path.join(@repo_root, "README.md"))
    claude = File.read!(Path.join(@repo_root, "CLAUDE.md"))
    poc_status = File.read!(Path.join(@repo_root, "docs/lattice_poc_status.md"))
    package = @repo_root |> Path.join("package.json") |> File.read!() |> Jason.decode!()

    assert plan =~ "stable read-only server boundary, not a participant realm"
    assert plan =~ "No server-initiated subscription/push protocol"
    assert plan =~ "No Tauri onboarding/cap-persistence change"

    assert plans_index =~
             ~r/\| 127 \| Stable read-only carrier server boundary \| P1 \| L \| 125, 126 \| (?:IN PROGRESS|DONE) \|/

    assert build_map =~ "`apps/lattice_carrier_server`"
    assert build_map =~ "Plan 127 adds the stable supervised read-only carrier server"
    assert build_map =~ "authenticated frontier and pull"
    assert build_map =~ "production deployment remains"
    assert build_map =~ "Write controls and a server-push carrier feed remain"
    assert build_map =~ "plans 023-127"

    assert build_map =~
             ~r/Plan 127 does not change or newly prove Tauri onboarding\/cap persistence/

    refute build_map =~ "Plan 127 completes G1"
    refute build_map =~ "Plan 127 completes Phase G"
    refute build_map =~ "Plan 127 makes W4 receipt-free"

    assert agents =~ "`apps/lattice_carrier_server`"
    assert agents =~ "Supervised read-only Cowboy carrier server"

    assert readme =~ "`apps/lattice_carrier_server` owns"
    assert readme =~ "transport identity, not a participant identity"
    assert readme =~ "not a production deployment"

    assert claude =~ "Plan 127 adds the stable read-only carrier server"
    assert claude =~ "does not add server push, participant custody, or production deployment"

    assert poc_status =~ "## Checkpoint: Stable Read-Only Carrier Server"
    assert poc_status =~ "authenticated frontier and missing-op pull"
    assert poc_status =~ "does not prove autonomous polling in the browser"

    assert package["scripts"]["township:instrument:server-e2e"] ==
             "npx --no-install playwright test --config playwright.township-server.config.mjs"
  end
end
