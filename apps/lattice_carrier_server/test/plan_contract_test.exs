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
    assert build_map =~ ~r/broader participant controls remain/i
    assert build_map =~ "plans 023-133"

    assert build_map =~
             ~r/Plan 128 does not change or newly prove Tauri onboarding\/cap persistence/

    refute build_map =~ "Plan 127 completes G1"
    refute build_map =~ "Plan 127 completes Phase G"
    refute build_map =~ "Plan 127 makes W4 receipt-free"

    assert agents =~ "`apps/lattice_carrier_server`"
    assert agents =~ "Supervised read-only Cowboy carrier server"

    assert readme =~ "`apps/lattice_carrier_server` owns"
    assert readme =~ "transport identity, not a participant identity"
    assert readme =~ ~r/not a production\s+deployment/

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
    assert build_map =~ ~r/request\/response\s+relay,\s+not server push/
    assert build_map =~ ~r/broader participant controls remain/i
    assert build_map =~ "plans 023-133"

    assert build_map =~
             ~r/Plan 128 does not change or newly prove Tauri onboarding\/cap persistence/

    refute build_map =~ "Plan 128 completes G1"
    refute build_map =~ "Plan 128 completes Phase G"
    refute build_map =~ "Plan 128 makes W4 receipt-free"

    assert agents =~ "opt-in durable client-signed relay"
    assert readme =~ "Opt-in client-signed relay realms"
    assert readme =~ "explicit one-op relay request"
    assert readme =~ ~r/availability frame contains no operation/i

    assert claude =~ "Plan 128 adds an opt-in client-signed relay"

    assert claude =~
             "does not add `/township` write controls, server push, or participant custody"

    assert poc_status =~ "## Checkpoint: Durable Client-Signed Carrier Relay"
    assert poc_status =~ "persisted before acknowledgement"
    assert poc_status =~ "semantic authority remains a materialization-time decision"
  end

  test "Plan 129 records packaged Tauri stable-relay convergence without expanding custody or mobile claims" do
    plan =
      File.read!(Path.join(@repo_root, "plans/129-packaged-tauri-stable-relay-convergence-g1.md"))

    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    claude = File.read!(Path.join(@repo_root, "CLAUDE.md"))
    poc_status = File.read!(Path.join(@repo_root, "docs/lattice_poc_status.md"))
    path_to_real = File.read!(Path.join(@repo_root, "docs/path_to_real.md"))

    mobile_strategy =
      File.read!(Path.join(@repo_root, "docs/township_mobile_secure_store_strategy.md"))

    shell_package =
      @repo_root
      |> Path.join("clients/township-tauri-shell/package.json")
      |> File.read!()
      |> Jason.decode!()

    old_smoke =
      File.read!(
        Path.join(
          @repo_root,
          "clients/township-tauri-shell/test/tauri_packaged_onboarding_smoke.ts"
        )
      )

    new_smoke =
      File.read!(
        Path.join(
          @repo_root,
          "clients/township-tauri-shell/test/tauri_stable_relay_onboarding_smoke.ts"
        )
      )

    assert plan =~ "Packaged Tauri stable-relay convergence"
    assert plan =~ "No server push"
    assert plan =~ "No new native key command, secure-store implementation"
    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ ~r/## Completion claim\s+Complete for this scoped increment/

    assert plans_index =~
             "| 129 | Packaged Tauri stable-relay convergence | P1 | L | 128, 118-120 | DONE |"

    assert build_map =~ "Plan 129 connects the packaged desktop Tauri onboarding ceremony"
    assert build_map =~ "exact Sim-generated operation"
    assert build_map =~ "mobile secure-store strategy remains unchanged"
    assert build_map =~ "plans 023-133"
    refute build_map =~ "Plan 129 completes Phase G"
    refute build_map =~ "Plan 129 makes W4 receipt-free"

    assert claude =~ "Plan 129 connects the packaged Tauri app to the stable relay"
    assert poc_status =~ "## Checkpoint: Packaged Tauri Stable-Relay Convergence"
    assert path_to_real =~ ~r/Plan 129 closes the\s+packaged desktop write-boundary gap/
    assert mobile_strategy =~ "Plan 129 reuses this custody strategy unchanged"

    assert shell_package["scripts"]["stable:relay:contract"] ==
             "tsx test/township_stable_relay.ts"

    assert shell_package["scripts"]["tauri:stable-relay:onboarding:smoke"] ==
             "tsx test/tauri_stable_relay_onboarding_smoke.ts"

    assert shell_package["scripts"]["app:convergence"] =~ "stable:relay:contract"

    assert shell_package["scripts"]["app:convergence"] =~
             "tauri:stable-relay:onboarding:smoke"

    refute old_smoke =~ "submission: \"relay\""
    assert new_smoke =~ "submission: \"relay\""
  end

  test "Plan 130 records the first participant handoff without moving custody or overclaiming Phase G" do
    plan =
      File.read!(Path.join(@repo_root, "plans/130-liveview-tauri-participant-post-handoff-g1.md"))

    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    claude = File.read!(Path.join(@repo_root, "CLAUDE.md"))
    readme = File.read!(Path.join(@repo_root, "README.md"))
    poc_status = File.read!(Path.join(@repo_root, "docs/lattice_poc_status.md"))
    path_to_real = File.read!(Path.join(@repo_root, "docs/path_to_real.md"))

    mobile_strategy =
      File.read!(Path.join(@repo_root, "docs/township_mobile_secure_store_strategy.md"))

    root_package = @repo_root |> Path.join("package.json") |> File.read!() |> Jason.decode!()

    shell_package =
      @repo_root
      |> Path.join("clients/township-tauri-shell/package.json")
      |> File.read!()
      |> Jason.decode!()

    flagship = File.read!(Path.join(@repo_root, "scripts/lattice_verify_flagship.sh"))
    workflow = File.read!(Path.join(@repo_root, ".github/workflows/flagship.yml"))
    ubuntu_gate = File.read!(Path.join(@repo_root, "tests/e2e/township_action_handoff.spec.ts"))

    packaged_gate =
      File.read!(
        Path.join(
          @repo_root,
          "clients/township-tauri-shell/test/tauri_action_handoff_smoke.ts"
        )
      )

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ "one versioned, unsigned `post` intent"
    assert plan =~ "No server-initiated notification"
    assert plan =~ "Full release verification passed on 2026-07-12"
    assert plan =~ ~r/336 tests and 25\s+properties/
    assert plan =~ "positive `no_capability` quarantine control"
    assert plan =~ "final exact-diff review returned `PROCEED`"
    assert plan =~ "focused follow-up returned `PROCEED` and marked the prior medium resolved"
    assert plan =~ ~r/## Completion claim\s+Complete for this scoped increment/

    assert plans_index =~
             "| 130 | LiveView-to-Tauri participant post handoff | P1 | L | 129, 123, 126 | DONE |"

    assert build_map =~ "Plan 130 adds the first participant post handoff"
    assert build_map =~ "unsigned request"
    assert build_map =~ "plans 023-133"
    refute build_map =~ "Plan 130 completes G1"
    refute build_map =~ "Plan 130 completes Phase G"
    refute build_map =~ "Plan 130 makes W4 receipt-free"

    assert claude =~ "Plan 130 adds the first participant post handoff"
    assert claude =~ "Phoenix never receives participant keys"
    assert claude =~ "Read-oriented LiveView/Vue instrument"

    assert readme =~
             "fresh carrier-backed `/township` instrument may prepare one unsigned post request"

    assert poc_status =~ "## Checkpoint: LiveView-to-Tauri Participant Post Handoff"
    assert poc_status =~ ~r/full\s+release matrix passed with 336 tests and 25 properties/
    assert path_to_real =~ "Plan 130 closes the first participant-loop gap"
    assert mobile_strategy =~ "Plan 130 reuses this custody strategy unchanged"

    assert root_package["scripts"]["township:action-handoff:e2e"] ==
             "scripts/township_action_handoff_e2e.sh"

    assert shell_package["scripts"]["tauri:action-handoff:smoke"] ==
             "tsx test/tauri_action_handoff_smoke.ts"

    assert shell_package["scripts"]["app:convergence"] =~ "tauri:action-handoff:smoke"
    assert flagship =~ "npm run township:action-handoff:e2e"
    assert workflow =~ "npm --prefix clients/township-tauri-shell ci"
    assert ubuntu_gate =~ "#participant-post-handoff"
    assert ubuntu_gate =~ "assert.deepEqual(authoredFrame, oracle.expectedPost"
    assert ubuntu_gate =~ "data-quarantined-count"
    assert ubuntu_gate =~ "VERIFY_READY authority"
    assert packaged_gate =~ "assertLaunchServicesRoutesTownshipSchemeToBundle"
    assert packaged_gate =~ "action-intent-dev-submit:synced"
    assert packaged_gate =~ "assertTraceRedacted"

    assert plan =~
             ~r/The Ubuntu gate drives the visible\s+Use request, Post, and Sync controls/

    assert plan =~
             ~r/the packaged macOS gate uses the native-gated development\s+control/
  end

  test "Plan 131 makes both real packaged macOS convergence proofs mandatory in CI" do
    plan =
      File.read!(Path.join(@repo_root, "plans/131-packaged-macos-convergence-ci-gate-g1.md"))

    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    claude = File.read!(Path.join(@repo_root, "CLAUDE.md"))
    readme = File.read!(Path.join(@repo_root, "README.md"))
    poc_status = File.read!(Path.join(@repo_root, "docs/lattice_poc_status.md"))
    path_to_real = File.read!(Path.join(@repo_root, "docs/path_to_real.md"))

    mobile_strategy =
      File.read!(Path.join(@repo_root, "docs/township_mobile_secure_store_strategy.md"))

    workflow = File.read!(Path.join(@repo_root, ".github/workflows/flagship.yml"))

    stable_smoke =
      File.read!(
        Path.join(
          @repo_root,
          "clients/township-tauri-shell/test/tauri_stable_relay_onboarding_smoke.ts"
        )
      )

    action_smoke =
      File.read!(
        Path.join(
          @repo_root,
          "clients/township-tauri-shell/test/tauri_action_handoff_smoke.ts"
        )
      )

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ ~r/actual\s+`Township\.app` bundle/
    assert plan =~ "A platform skip, prebuilt stale bundle, mocked native IPC surface"
    assert plan =~ "No new carrier message, subscription, notification, or server-push protocol"
    assert plan =~ "No G1/Phase G completion and no receipt-free W4 claim"
    assert plan =~ "Hosted run `29180961767`"

    assert plan =~
             "final exact-diff review covered the complete `802437a8..85b2b3bd` implementation range"

    assert plan =~ ~r/returned\s+`PROCEED` with no blocker,\s+high, or medium finding/
    assert plan =~ ~r/## Completion claim\s+Complete for this scoped increment/

    assert plans_index =~
             "| 131 | Packaged macOS convergence CI gate | P1 | S | 129, 130 | DONE |"

    assert build_map =~ "Plan 131 makes both packaged macOS convergence proofs CI-enforced"
    assert build_map =~ "plans 023-133"
    refute build_map =~ "Plan 131 completes Phase G"
    refute build_map =~ "Plan 131 makes W4 receipt-free"

    assert claude =~ "Plan 131 makes the packaged macOS gates mandatory in CI"
    assert readme =~ "Both packaged macOS convergence smokes are mandatory in flagship CI"
    assert poc_status =~ "## Checkpoint: Packaged macOS Convergence CI Gate"
    assert path_to_real =~ "Plan 131 closes the packaged-proof CI gap"
    assert mobile_strategy =~ "Plan 131 reuses this custody strategy unchanged"

    assert workflow =~ "Install Tauri Linux prerequisites"
    assert workflow =~ "libwebkit2gtk-4.1-dev"
    assert workflow =~ "libxdo-dev"
    assert workflow =~ "libayatana-appindicator3-dev"
    assert workflow =~ "librsvg2-dev"

    assert workflow =~ "\n  packaged_macos:\n"
    packaged_job = workflow |> String.split("\n  packaged_macos:\n", parts: 2) |> List.last()

    assert packaged_job =~ "runs-on: macos-15-intel"
    assert packaged_job =~ "timeout-minutes: 90"
    assert packaged_job =~ "actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830"
    assert packaged_job =~ "MIX_ENV=test mix compile"
    assert packaged_job =~ "MIX_ENV=test mix esbuild.install --if-missing"
    assert packaged_job =~ "package-lock.json"
    assert packaged_job =~ ~r/run: \|\s+npm ci\s+.*npm --prefix clients\/lattice-client ci/s
    assert packaged_job =~ "npm --prefix clients/lattice-client run build"
    assert packaged_job =~ "npx --no-install playwright install chromium"
    assert packaged_job =~ "npm run tauri:stable-relay:onboarding:smoke"
    assert packaged_job =~ "npm run tauri:action-handoff:smoke"
    refute packaged_job =~ "continue-on-error"
    refute packaged_job =~ "TOWNSHIP_SKIP_ACTION_APP_BUILD"

    assert stable_smoke =~ "process.platform !== \"darwin\""
    assert stable_smoke =~ "Packaged Tauri stable-relay onboarding smoke passed"
    assert action_smoke =~ "process.platform !== \"darwin\""
    assert action_smoke =~ "Packaged Tauri action-handoff smoke passed"
  end

  test "Plan 132 defines an authenticated availability hint without pushed-op materialization" do
    plan =
      File.read!(Path.join(@repo_root, "plans/132-authenticated-carrier-availability-feed-g1.md"))

    projection_script =
      File.read!(Path.join(@repo_root, "scripts/township_action_handoff_live.exs"))

    action_smoke =
      File.read!(
        Path.join(
          @repo_root,
          "clients/township-tauri-shell/test/tauri_action_handoff_smoke.ts"
        )
      )

    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    readme = File.read!(Path.join(@repo_root, "README.md"))
    claude = File.read!(Path.join(@repo_root, "CLAUDE.md"))
    poc_status = File.read!(Path.join(@repo_root, "docs/lattice_poc_status.md"))

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ "The pushed frame is a liveness hint, never state transfer"
    assert plan =~ "Generation cannot move backward"
    assert plan =~ "at most 64"
    assert plan =~ "frontier_truncated"
    assert plan =~ "Plan 133 must add TypeScript"
    assert plan =~ "No server-pushed operation/state materialization"
    assert plan =~ "No complete G1/Phase G claim and no receipt-free W4 claim"
    assert plan =~ "Hosted run `29188555667` passed"

    Code.ensure_loaded!(LatticeCarrierServer.Holder)

    assert function_exported?(LatticeCarrierServer.Holder, :subscribe, 2)
    assert function_exported?(LatticeCarrierServer.Holder, :acknowledge, 3)
    assert function_exported?(LatticeCarrierServer.Holder, :unsubscribe, 2)

    assert projection_script =~ "feed: :server_push"
    assert projection_script =~ "poll_interval_ms: 60_000"
    refute projection_script =~ "poll_interval_ms: 250"
    assert action_smoke =~ "baselineFeedGeneration"
    assert action_smoke =~ "data-refresh-trigger"
    assert action_smoke =~ "data-feed-generation"
    assert action_smoke =~ "RELAY_READY restart"

    assert plans_index =~
             "| 132 | Authenticated carrier availability feed | P1 | XL | 128, 131 | DONE |"

    assert build_map =~ "Plan 132 adds an authenticated bounded `ops_available` hint"
    assert build_map =~ "verified pull remains the only materialization path"
    assert build_map =~ "Plan 133 adds the direct typed TypeScript availability subscription"
    assert build_map =~ "plans 023-133"

    assert readme =~ "Authenticated `subscribe` / `unsubscribe`"
    assert readme =~ ~r/verified pull remains the only\s+materialization path/
    assert claude =~ "Plan 132 replaces fast polling as the normal convergence trigger"
    assert claude =~ "Plan 133 adds direct TypeScript availability subscriptions"
    assert poc_status =~ "## Checkpoint: Authenticated Carrier Availability Feed"
    assert poc_status =~ "Restarted subscriptions are re-proven by a second pushed generation"
  end

  test "Plan 133 defines a direct TypeScript availability feed with a real live gate" do
    plan =
      File.read!(
        Path.join(@repo_root, "plans/133-direct-typescript-carrier-availability-feed-g1.md")
      )

    client_source =
      File.read!(Path.join(@repo_root, "clients/lattice-client/src/carrier.ts"))

    client_package =
      @repo_root
      |> Path.join("clients/lattice-client/package.json")
      |> File.read!()
      |> Jason.decode!()

    shell_package =
      @repo_root
      |> Path.join("clients/township-tauri-shell/package.json")
      |> File.read!()
      |> Jason.decode!()

    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    workflow = File.read!(Path.join(@repo_root, ".github/workflows/flagship.yml"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    poc_status = File.read!(Path.join(@repo_root, "docs/lattice_poc_status.md"))

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ ~r/latest availability plus at most one waiting\s+consumer/
    assert plan =~ ~r/does not claim wire-level browser\/Node WebSocket\s+backpressure/

    assert plan =~ "no test-controlled `pull` is invoked"
    assert plan =~ ~r/may keep an\s+`advertise` request in flight/

    assert plan =~
             ~r/does not yet turn the Tauri\/Vue application into a reactive\s+feed consumer/

    assert plan =~ "No mobile secure-store implementation change"
    assert plan =~ "complete G1/Phase G"
    assert plan =~ "receipt-free W4"
    assert plan =~ "Full local regression passed on 2026-07-12"
    assert plan =~ ~r/374\s+tests and 25 properties/
    assert plan =~ ~r/focused unsubscribe\s+diagnosis returned `VERDICT FIX`/
    assert plan =~ "Final exact-worktree Claude review returned `PROCEED`"
    assert plan =~ ~r/no blocker, high, or medium finding/
    assert plan =~ "Hosted run `29192642981` passed"
    assert plan =~ ~r/## Completion claim\s+Complete for this scoped increment/

    assert client_source =~ "export interface CarrierAvailability"
    assert client_source =~ "export interface CarrierAvailabilitySubscription"
    assert client_source =~ "subscribeAvailability()"

    assert File.exists?(Path.join(@repo_root, "clients/lattice-client/test/carrier_feed.ts"))

    assert File.exists?(
             Path.join(
               @repo_root,
               "clients/township-tauri-shell/test/township_carrier_feed.ts"
             )
           )

    assert client_package["scripts"]["carrier:feed"] == "tsx test/carrier_feed.ts"
    assert shell_package["scripts"]["feed:contract"] == "tsx test/township_carrier_feed.ts"
    assert workflow =~ "TS carrier availability feed contract"
    assert workflow =~ "npm run carrier:feed"
    assert workflow =~ "npm run feed:contract"

    assert plans_index =~
             "| 133 | Direct TypeScript carrier availability feed | P1 | L | 132 | DONE |"

    assert build_map =~ "Plan 133 adds the direct typed TypeScript availability subscription"
    assert build_map =~ "Reactive Tauri/Vue feed consumption remains separately gated"
    assert build_map =~ "direct-TypeScript gate CI-enforced"

    refute build_map =~
             "Hosted execution of that new hard step remains the Plan 133 closure gate"

    refute build_map =~
             "clients/lattice-client/src/{codec,identity,township,local_log,tauri_bridge,carrier}.ts"

    assert poc_status =~ "## Checkpoint: Direct TypeScript Carrier Availability Feed"
    assert poc_status =~ "No reactive Tauri/Vue app feed loop"
    assert poc_status =~ "Full local regression is green"
    assert poc_status =~ "Final exact-worktree Claude review is green"
    assert poc_status =~ "Hosted implementation run `29192642981` is green"
    assert poc_status =~ "Plan 133 status is `DONE`"
  end

  test "Plan 134 defines a verified reactive feed in the packaged Tauri app" do
    plan =
      File.read!(
        Path.join(@repo_root, "plans/134-reactive-packaged-tauri-availability-feed-g1.md")
      )

    client_source = File.read!(Path.join(@repo_root, "clients/lattice-client/src/carrier.ts"))
    feed_source = File.read!(Path.join(@repo_root, "clients/township-tauri-shell/src/township_feed.ts"))
    app_source = File.read!(Path.join(@repo_root, "clients/township-tauri-shell/src/App.vue"))

    shell_package =
      @repo_root
      |> Path.join("clients/township-tauri-shell/package.json")
      |> File.read!()
      |> Jason.decode!()

    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    workflow = File.read!(Path.join(@repo_root, ".github/workflows/flagship.yml"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    poc_status = File.read!(Path.join(@repo_root, "docs/lattice_poc_status.md"))

    mobile_strategy =
      File.read!(Path.join(@repo_root, "docs/township_mobile_secure_store_strategy.md"))

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ "Reactive refresh never submits or compacts the authored outbox"
    assert plan =~ "Every pulled frame is verified before conversion or persistence"
    assert plan =~ "No mobile secure-store implementation change"
    assert plan =~ "No complete G1/Phase G claim and no receipt-free W4 claim"
    assert plan =~ "onState(state: TownshipFeedState): void"
    assert plan =~ "document.querySelector"
    assert plan =~ "document.querySelectorAll"
    assert plan =~ "textContent"
    assert plan =~ "DOM-derived SHA-256"
    assert plan =~ "timeout-minutes: 90"
    assert plan =~ "manual Sync path is deliberately co-scoped"
    assert plan =~ "Full local regression passed"
    assert plan =~ "375 tests plus 25 properties"
    assert plan =~ "Final exact-worktree Claude review returned `PROCEED`"
    assert plan =~ "Hosted implementation run `29210581826` is green"
    assert plan =~ "`bfe8bcf2c2d3e7276ba92922f6e991922992b1c2`"
    assert plan =~ "`Verify flagship artifact` completed in 3m28s"
    assert plan =~ "`Unit + property suite` completed in 4m34s"
    assert plan =~ "`Packaged macOS convergence` completed in 8m16s"
    assert plan =~ "Complete for this scoped increment"
    refute plan =~ "Hosted acceptance remains pending"

    assert client_source =~ "verifier: Verifier"
    assert client_source =~ "verifyCarrierOp"
    assert feed_source =~ "export function createTownshipFeedController"
    assert feed_source =~ "export async function refreshTownshipFromCarrier"
    assert app_source =~ "carrier-feed-status"
    assert app_source =~ "matter-render-status"
    assert app_source =~ "township-proceedings"
    assert app_source =~ "crypto.subtle.digest"
    assert app_source =~ "postDigests"
    refute app_source =~ ~r/posts:\s*Array\.from\(/
    assert app_source =~ "createTownshipFeedController"
    assert app_source =~ "townshipPreviewFromOps"

    assert File.exists?(Path.join(@repo_root, "clients/township-tauri-shell/test/township_feed.ts"))

    assert File.exists?(
             Path.join(
               @repo_root,
               "clients/township-tauri-shell/test/tauri_carrier_feed_smoke.ts"
             )
           )

    assert shell_package["scripts"]["feed:app:contract"] == "tsx test/township_feed.ts"

    assert shell_package["scripts"]["tauri:feed:smoke"] ==
             "tsx test/tauri_carrier_feed_smoke.ts"

    assert shell_package["scripts"]["app:convergence"] =~ "tauri:feed:smoke"
    assert workflow =~ "TS reactive Township feed controller"
    assert workflow =~ "Verify packaged reactive carrier feed"
    assert workflow =~ "timeout-minutes: 90"

    assert plans_index =~
             "| 134 | Reactive packaged Tauri availability feed | P1 | XL | 133, 129, 130 | DONE |"

    assert build_map =~ "Plan 134 adds the packaged Tauri/Vue reactive availability feed"
    assert build_map =~ "Reactive refresh never submits or compacts the authored outbox"
    assert build_map =~ "Full local Plan 134 regression is green"
    assert build_map =~ "Hosted Plan 134 run `29210581826` is green"
    refute build_map =~ "hosted Plan 134 result pending"
    refute build_map =~ "Plan 134 completes G1"
    refute build_map =~ "Plan 134 completes Phase G"
    refute build_map =~ "Plan 134 completes W4"
    assert poc_status =~ "## Checkpoint: Reactive Packaged Tauri Availability Feed"
    assert poc_status =~ "Full local regression is green at 375 tests plus 25 properties"
    assert poc_status =~ "Final exact-worktree Claude review is green"
    assert poc_status =~ "Hosted implementation run `29210581826` is green"
    assert poc_status =~ "Plan 134 status is `DONE`"
    refute poc_status =~ "Hosted acceptance remains pending"
    assert mobile_strategy =~ "Plan 134 leaves this custody strategy unchanged"
  end
end
