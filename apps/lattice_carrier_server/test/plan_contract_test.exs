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

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ "stable read-only server boundary, not a participant realm"
    assert plan =~ "No server-initiated subscription/push protocol"
    assert plan =~ "No Tauri onboarding/cap-persistence change"
    assert plan =~ ~r/## Completion claim\s+Complete for this scoped increment/

    assert plans_index =~
             "| 127 | Stable read-only carrier server boundary | P1 | L | 125, 126 | DONE |"

    assert build_map =~ "`apps/lattice_carrier_server`"
    assert build_map =~ "Plan 127 adds the stable supervised read-only carrier server"
    assert build_map =~ "authenticated frontier and pull"
    assert build_map =~ "production deployment remains"
    assert build_map =~ "Write controls and a server-push carrier feed remain"
    assert build_map =~ "plans 023-128"

    assert build_map =~
             ~r/Plan 128 does not change or newly prove Tauri onboarding\/cap persistence/

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

  test "Plan 128 records durable client-signed relay without claiming UI writes or server push" do
    plan =
      File.read!(Path.join(@repo_root, "plans/128-durable-client-signed-carrier-relay-g1.md"))

    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    agents = File.read!(Path.join(@repo_root, "AGENTS.md"))
    readme = File.read!(Path.join(@repo_root, "README.md"))
    claude = File.read!(Path.join(@repo_root, "CLAUDE.md"))
    poc_status = File.read!(Path.join(@repo_root, "docs/lattice_poc_status.md"))

    assert plan =~ "The client signs and the server relays"
    assert plan =~ "No server-initiated notification/subscription"
    assert plan =~ "No `/township` write control"
    assert plan =~ "No change or new claim for Tauri onboarding/cap persistence"
    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ ~r/## Completion claim\s+Complete for this scoped increment/

    assert plans_index =~
             "| 128 | Durable client-signed carrier relay | P1 | L | 127 | DONE |"

    assert build_map =~ "Plan 128 adds the opt-in durable client-signed relay"
    assert build_map =~ "request/response relay, not server push"
    assert build_map =~ "Write controls and a server-push carrier feed remain"
    assert build_map =~ "plans 023-128"

    assert build_map =~
             ~r/Plan 128 does not change or newly prove Tauri onboarding\/cap persistence/

    refute build_map =~ "Plan 128 completes G1"
    refute build_map =~ "Plan 128 completes Phase G"
    refute build_map =~ "Plan 128 makes W4 receipt-free"

    assert agents =~ "opt-in durable client-signed relay"
    assert readme =~ "Opt-in client-signed relay realms"
    assert readme =~ "request/response relay is not server push"

    assert claude =~ "Plan 128 adds an opt-in client-signed relay"

    assert claude =~
             "does not add `/township` write controls, server push, or participant custody"

    assert poc_status =~ "## Checkpoint: Durable Client-Signed Carrier Relay"
    assert poc_status =~ "persisted before acknowledgement"
    assert poc_status =~ "semantic authority remains a materialization-time decision"
  end
end
