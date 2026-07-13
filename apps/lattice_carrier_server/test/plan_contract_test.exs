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

    feed_source =
      File.read!(Path.join(@repo_root, "clients/township-tauri-shell/src/township_feed.ts"))

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

    [_, plan134_tail] =
      String.split(
        poc_status,
        "## Checkpoint: Reactive Packaged Tauri Availability Feed",
        parts: 2
      )

    [plan134_checkpoint | _rest] = String.split(plan134_tail, "\n## Checkpoint:", parts: 2)

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

    assert File.exists?(
             Path.join(@repo_root, "clients/township-tauri-shell/test/township_feed.ts")
           )

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
    assert build_map =~ ~r/Plan 134 adds the packaged reactive\s+Tauri\/Vue feed loop/
    refute build_map =~ "hosted Plan 134 result pending"

    refute build_map =~
             "The active frontier remains **complete G1/Phase G**:\nreactive Tauri/Vue feed consumption"

    refute build_map =~ "No reactive Tauri/Vue app feed loop is\n  claimed"
    refute build_map =~ "Plan 134 completes G1"
    refute build_map =~ "Plan 134 completes Phase G"
    refute build_map =~ "Plan 134 completes W4"
    assert poc_status =~ "## Checkpoint: Reactive Packaged Tauri Availability Feed"
    assert poc_status =~ "Full local regression is green at 375 tests plus 25 properties"
    assert poc_status =~ "Final exact-worktree Claude review is green"
    assert poc_status =~ "Hosted implementation run `29210581826` is green"
    assert poc_status =~ "Plan 134 status is `DONE`"
    refute plan134_checkpoint =~ "Hosted acceptance remains pending"
    assert mobile_strategy =~ "Plan 134 leaves this custody strategy unchanged"
  end

  test "Plan 135 defines a versioned clerk status handoff across the app custody seam" do
    plan =
      File.read!(Path.join(@repo_root, "plans/135-versioned-clerk-status-action-handoff-g1.md"))

    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    poc_status = File.read!(Path.join(@repo_root, "docs/lattice_poc_status.md"))
    workflow = File.read!(Path.join(@repo_root, ".github/workflows/flagship.yml"))

    shell_package =
      @repo_root
      |> Path.join("clients/township-tauri-shell/package.json")
      |> File.read!()
      |> Jason.decode!()

    mobile_strategy =
      File.read!(Path.join(@repo_root, "docs/township_mobile_secure_store_strategy.md"))

    [_, plan135_tail] =
      String.split(
        poc_status,
        "## Checkpoint: Versioned Clerk Status Action Handoff",
        parts: 2
      )

    [plan135_checkpoint | _rest] = String.split(plan135_tail, "\n## Checkpoint:", parts: 2)

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ "v1 remains exactly post-only"

    assert plan =~
             ~s({"v":2,"id":"<32-lowercase-hex>","replica":"<replica>","command":{"command":"close_matter"}})

    assert plan =~ "Unknown versions and cross-version keys fail closed"
    assert plan =~ "Use request -> Sign close/reopen -> Sync outbox"
    assert plan =~ "No-cap resident refusal"
    assert plan =~ "zero native signatures and zero KV writes"
    assert plan =~ ~r/Relay is not a\s+dependency of author-only submission/
    assert plan =~ ~r/zero Sync trace and an unchanged stable-relay source/
    assert plan =~ "Open -> Locked -> Open"
    assert plan =~ "`Lattice.Sim` is the independent oracle"
    assert plan =~ ~r/reuses the existing action-handoff app bundle\s+in hosted CI/
    assert plan =~ "Plan 130's packaged post handoff remains unchanged"
    assert plan =~ "W2 already owns the stale ex-clerk `:not_holder` proof"
    assert plan =~ "No automatic authored-frame publication"
    assert plan =~ "No mobile secure-store implementation change"
    assert plan =~ "No complete G1/Phase G claim and no receipt-free W4 claim"

    assert plans_index =~
             "| 135 | Versioned clerk status action handoff | P1 | XL | 050, 054, 130, 131, 134 | DONE |"

    refute plans_index =~
             "reactive Tauri/Vue feed consumption, broader participant controls"

    assert build_map =~ "broader participant controls, production deployment, and receipt-free W4"
    assert mobile_strategy =~ "Carrier signatures and delegation ids are the integrity boundary"

    assert plan =~ "## Implementation evidence"
    assert plan =~ "Packaged close/reopen smoke is green"
    assert plan =~ "Full local regression passed on 2026-07-12"
    assert plan =~ "378 tests plus 25 properties"
    assert plan =~ "Final exact-worktree Claude review returned `PROCEED`"
    assert plan =~ "Hosted implementation run `29216789652` is green"
    assert plan =~ "`6a55a91ad82ccc30cc52ed09142864b8d76c1bb4`"
    assert plan =~ "`Verify flagship artifact` completed in 3m19s"
    assert plan =~ "`Unit + property suite` completed in 4m14s"
    assert plan =~ "`Packaged macOS convergence` completed in 11m39s"
    assert plan =~ ~r/## Completion claim\s+Complete for this scoped increment/
    refute plan =~ "Hosted acceptance remains pending"

    assert build_map =~ "Plan 135 adds the versioned clerk status action handoff"
    assert build_map =~ "Use request, Sign close/reopen, and separate Sync outbox"
    assert build_map =~ "Open -> Locked -> Open"
    assert build_map =~ "No automatic authored-frame publication"
    assert build_map =~ "Full local Plan 135 regression is green at 378 tests plus 25 properties"
    assert build_map =~ "Hosted Plan 135 run `29216789652` is green"
    assert build_map =~ "Plan 135 status is `DONE`"
    refute build_map =~ "Plan 135 completes G1"
    refute build_map =~ "Plan 135 completes Phase G"

    assert poc_status =~ "## Checkpoint: Versioned Clerk Status Action Handoff"
    assert plan135_checkpoint =~ "`npm run tauri:clerk-action-handoff:smoke` is green"
    assert plan135_checkpoint =~ "Full local regression is green at 378 tests plus 25 properties"
    assert plan135_checkpoint =~ "Hosted implementation run `29216789652` is green"
    assert plan135_checkpoint =~ "Plan 135 status is `DONE`"
    refute plan135_checkpoint =~ "Hosted acceptance remains pending"

    assert mobile_strategy =~ "Plan 135 leaves this custody strategy unchanged"
    assert mobile_strategy =~ "separate explicit Sync"
    assert mobile_strategy =~ "No mobile secure-store implementation"

    assert shell_package["scripts"]["tauri:clerk-action-handoff:smoke"] ==
             "tsx test/tauri_clerk_action_handoff_smoke.ts"

    assert shell_package["scripts"]["app:convergence"] =~
             ~r/tauri:action-handoff:smoke && TOWNSHIP_SKIP_CLERK_ACTION_APP_BUILD=1 npm run tauri:clerk-action-handoff:smoke/

    assert workflow =~
             ~r/TS Township shell typecheck\s+working-directory: clients\/township-tauri-shell\s+run: npm run typecheck/

    assert workflow =~
             ~r/TS Township action-intent contract\s+working-directory: clients\/township-tauri-shell\s+run: npm run action-intent:contract/

    assert workflow =~
             ~r/TS Township deep-link dispatcher contract\s+working-directory: clients\/township-tauri-shell\s+run: npm run deeplink:dispatcher:contract/

    assert workflow =~
             ~r/TS Township action contract\s+working-directory: clients\/township-tauri-shell\s+run: npm run action:contract/

    assert workflow =~
             ~r/TS Township frontend contract\s+working-directory: clients\/township-tauri-shell\s+run: npm run frontend:contract/

    assert workflow =~
             ~r/Verify packaged action handoff[\s\S]*Verify packaged clerk status handoff[\s\S]*Verify packaged reactive carrier feed/

    assert workflow =~
             ~r/Verify packaged clerk status handoff\s+working-directory: clients\/township-tauri-shell\s+env:\s+TOWNSHIP_SKIP_CLERK_ACTION_APP_BUILD: "1"\s+run: npm run tauri:clerk-action-handoff:smoke/
  end

  test "Plan 136 defines one bundled argument-bearing field-edit handoff" do
    plan =
      File.read!(Path.join(@repo_root, "plans/136-versioned-field-edit-action-handoff-g1.md"))

    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    poc_status = File.read!(Path.join(@repo_root, "docs/lattice_poc_status.md"))
    workflow = File.read!(Path.join(@repo_root, ".github/workflows/flagship.yml"))

    mobile_strategy =
      File.read!(Path.join(@repo_root, "docs/township_mobile_secure_store_strategy.md"))

    shell_package =
      @repo_root
      |> Path.join("clients/township-tauri-shell/package.json")
      |> File.read!()
      |> Jason.decode!()

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ "v1 and v2 remain exactly unchanged"

    assert plan =~
             ~s({"v":3,"id":"<32-lowercase-hex>","replica":"<replica>","command":{"command":"set_summary","text":"<text>"}})

    assert plan =~
             ~s({"v":3,"id":"<32-lowercase-hex>","replica":"<replica>","command":{"command":"set_title","text":"<text>"}})

    assert plan =~
             ~r/one v3 command union bundles both `set_title` and\s+`set_summary`/

    assert plan =~ "Unknown versions and cross-version keys fail closed"
    assert plan =~ "Use request -> Sign edit -> Sync outbox"
    assert plan =~ "No-cap participant refusal"
    assert plan =~ "zero native signatures and zero KV writes"
    assert plan =~ "contested-summary"
    assert plan =~ "authorizes both the participant"
    assert plan =~ "and distinct peer relay realms"
    assert plan =~ "outbox frame id remains byte-identical"
    assert plan =~ "`Lattice.Sim` is the independent oracle"
    assert plan =~ ~r/reuses the existing action-handoff app bundle\s+in hosted CI/
    assert plan =~ "No automatic authored-frame publication"
    assert plan =~ "No mobile secure-store implementation change"
    assert plan =~ "No complete G1/Phase G claim and no receipt-free W4 claim"
    assert plan =~ "383 tests plus 25 properties"
    assert plan =~ "Hosted implementation run `29223172342` is green"
    assert plan =~ "`0382f96b582b4efd9a751b8b81c76be58f719691`"
    assert plan =~ "`Verify flagship artifact` completed in 3m49s"
    assert plan =~ "`Unit + property suite` completed in 4m30s"
    assert plan =~ "`Packaged macOS convergence` completed in 11m24s"
    assert plan =~ ~r/## Completion claim\s+Complete for this scoped increment/

    refute plan =~
             "Hosted implementation, closure documentation, and branch-tip CI remain pending"

    refute plan =~ "Not yet complete"

    assert plans_index =~
             "| 136 | Versioned field-edit action handoff | P1 | XL | 048, 135 | DONE |"

    assert plans_index =~ "Plan 136 closes the bundled"

    assert shell_package["scripts"]["tauri:field-action-handoff:smoke"] ==
             "tsx test/tauri_field_action_handoff_smoke.ts"

    assert shell_package["scripts"]["app:convergence"] =~
             ~r/tauri:clerk-action-handoff:smoke && TOWNSHIP_SKIP_FIELD_ACTION_APP_BUILD=1 npm run tauri:field-action-handoff:smoke/

    assert workflow =~
             ~r/Verify packaged clerk status handoff[\s\S]*Verify packaged field edit handoff[\s\S]*Verify packaged reactive carrier feed/

    assert workflow =~
             ~r/Verify packaged field edit handoff\s+working-directory: clients\/township-tauri-shell\s+env:\s+TOWNSHIP_SKIP_FIELD_ACTION_APP_BUILD: "1"\s+run: npm run tauri:field-action-handoff:smoke/

    assert build_map =~ "Plan 136 adds the versioned field-edit action handoff"
    assert build_map =~ "Hosted Plan 136 run `29223172342` is green"
    assert build_map =~ "Plan 136 status is `DONE`"
    refute build_map =~ "Plan 136 completes G1"
    refute build_map =~ "Plan 136 completes Phase G"

    [_, plan136_tail] =
      String.split(
        poc_status,
        "## Checkpoint: Versioned Field-Edit Action Handoff",
        parts: 2
      )

    [plan136_checkpoint | _rest] = String.split(plan136_tail, "\n## Checkpoint:", parts: 2)

    assert plan136_checkpoint =~ "383 tests plus 25 properties"
    assert plan136_checkpoint =~ "Hosted implementation run `29223172342` is green"
    assert plan136_checkpoint =~ "Plan 136 status is `DONE`"
    refute plan136_checkpoint =~ "Hosted acceptance remains pending"

    assert mobile_strategy =~ "Plan 136 leaves this custody strategy unchanged"
  end

  test "Plan 137 defines one bundled roster handoff with a Sim add-wins proof" do
    plan =
      File.read!(Path.join(@repo_root, "plans/137-versioned-roster-action-handoff-g1.md"))

    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    poc_status = File.read!(Path.join(@repo_root, "docs/lattice_poc_status.md"))

    shell_package =
      @repo_root
      |> Path.join("clients/township-tauri-shell/package.json")
      |> File.read!()
      |> Jason.decode!()

    workflow = File.read!(Path.join(@repo_root, ".github/workflows/flagship.yml"))

    mobile_strategy =
      File.read!(Path.join(@repo_root, "docs/township_mobile_secure_store_strategy.md"))

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ "v1, v2, and v3 remain exactly unchanged"

    assert plan =~
             ~s({"v":4,"id":"<32-lowercase-hex>","replica":"<replica>","command":{"command":"admit","member":"<member>"}})

    assert plan =~
             ~s({"v":4,"id":"<32-lowercase-hex>","replica":"<replica>","command":{"command":"remove_member","member":"<member>"}})

    assert plan =~
             ~r/one v4 command union bundles both `admit` and\s+`remove_member`/

    assert plan =~ "nested command permits exactly `command` and `member`"
    assert plan =~ "Use request -> Sign roster action -> Sync outbox"
    assert plan =~ "only while its carrier source is fresh"
    assert plan =~ ~r/fails locally\s+as `missing_delegation` before operation construction/
    assert plan =~ "Phoenix receives no participant identity, private key, capability"
    assert plan =~ "persisted capability evidence for both roster commands"
    assert plan =~ "zero native signatures and zero KV writes"
    assert plan =~ "capability-valid on both branches"
    assert plan =~ "contested member is already admitted at the shared base frontier"
    assert plan =~ "both roster operations are concurrent from that shared base"
    assert plan =~ "observed-remove add-wins"
    assert plan =~ "outbox frame remains byte-identical"
    assert plan =~ "`Lattice.Sim` is the independent oracle"
    assert plan =~ "one installed clerk app identity"
    assert plan =~ "distinct authorized peer relay realm"
    assert plan =~ "TOWNSHIP_SKIP_ROSTER_ACTION_APP_BUILD=1"
    assert plan =~ "No mobile secure-store implementation change"
    assert plan =~ "No delegation, revocation, or succession handoff"
    assert plan =~ "not an authority-quarantine or authority-role proof"
    assert plan =~ "No complete G1/Phase G claim and no receipt-free W4 claim"
    assert plan =~ "389 tests plus 25 properties"
    assert plan =~ "Hosted implementation run `29233959489` is green"
    assert plan =~ "`cae78810b7858064a5c4ab07db950057a367df70`"
    assert plan =~ "`Verify flagship artifact` completed in 3m40s"
    assert plan =~ "`Unit + property suite` completed in 4m51s"
    assert plan =~ "`Packaged macOS convergence` completed in 7m46s"
    assert plan =~ ~r/## Completion claim\s+Complete for this scoped increment/
    refute plan =~ "Hard hosted unit, flagship, and packaged macOS runs remain required"
    refute plan =~ "Not yet complete"

    assert plans_index =~
             "| 137 | Versioned roster action handoff | P1 | XL | 051, 054, 130, 136 | DONE |"

    assert plans_index =~
             "Plan 137 closes the bundled `admit`/`remove_member` roster handoff slice"

    assert shell_package["scripts"]["tauri:roster-action-handoff:smoke"] ==
             "tsx test/tauri_roster_action_handoff_smoke.ts"

    assert shell_package["scripts"]["app:convergence"] =~
             ~r/tauri:field-action-handoff:smoke && TOWNSHIP_SKIP_ROSTER_ACTION_APP_BUILD=1 npm run tauri:roster-action-handoff:smoke && TOWNSHIP_SKIP_DELEGATION_GRANT_APP_BUILD=1 npm run tauri:delegation-grant-handoff:smoke && npm run tauri:feed:smoke/

    assert workflow =~
             ~r/Verify packaged roster handoff\s+working-directory: clients\/township-tauri-shell\s+env:\s+TOWNSHIP_SKIP_ROSTER_ACTION_APP_BUILD: "1"\s+run: npm run tauri:roster-action-handoff:smoke/

    assert build_map =~ "Plan 137 adds the versioned roster action handoff"
    assert build_map =~ "Hosted Plan 137 run `29233959489` is green"
    assert build_map =~ "Plan 137 status is `DONE`"

    assert build_map =~
             "The remaining participant-control work now narrows to capability-lifecycle controls"

    refute build_map =~ "Plan 137 completes G1"
    refute build_map =~ "Plan 137 completes Phase G"

    [_, plan137_tail] =
      String.split(
        poc_status,
        "## Checkpoint: Versioned Roster Action Handoff",
        parts: 2
      )

    [plan137_checkpoint | _rest] = String.split(plan137_tail, "\n## Checkpoint:", parts: 2)

    assert plan137_checkpoint =~ "389 tests plus 25 properties"
    assert plan137_checkpoint =~ "Hosted implementation run `29233959489` is green"
    assert plan137_checkpoint =~ "Plan 137 status is `DONE`"
    refute plan137_checkpoint =~ "Hosted acceptance remains pending"

    assert mobile_strategy =~ "Plan 137 leaves this custody strategy unchanged"
  end

  test "Plan 138 defines a versioned delegation grant handoff with recipient use and Sim authority proof" do
    plan =
      File.read!(Path.join(@repo_root, "plans/138-versioned-delegation-grant-handoff-g1.md"))

    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    poc_status = File.read!(Path.join(@repo_root, "docs/lattice_poc_status.md"))

    mobile_strategy =
      File.read!(Path.join(@repo_root, "docs/township_mobile_secure_store_strategy.md"))

    shell_package =
      @repo_root
      |> Path.join("clients/township-tauri-shell/package.json")
      |> File.read!()
      |> Jason.decode!()

    workflow = File.read!(Path.join(@repo_root, ".github/workflows/flagship.yml"))

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ "v1 through v4 remain exactly unchanged"

    assert plan =~
             ~s({"v":5,"id":"<32-lowercase-hex>","replica":"<replica>","authority":{"action":"grant","audience":"<canonical-base64-ed25519-pubkey>","ops":["admit","post","set_summary","set_title"],"roles":[],"live":false}})

    assert plan =~ "top-level object permits exactly `authority`, `id`, `replica`, and `v`"

    assert plan =~
             "nested authority object permits exactly `action`, `audience`, `live`, `ops`, and `roles`"

    assert plan =~ "one fixed resident grant profile"
    assert plan =~ "only while its carrier source is fresh"
    assert plan =~ "Use request -> Sign grant -> Sync outbox"
    assert plan =~ "rechecks the saved pairing replica before signing"
    assert plan =~ "reuses `submitTownshipDelegation`"
    assert plan =~ "selects the issuer parent from persisted delegation evidence"
    assert plan =~ "zero native signatures and zero KV writes"
    assert plan =~ ~r/fails as `missing_delegation` before any signature or\s+write/
    assert plan =~ "Phoenix receives no participant identity, private key, parent capability"
    assert plan =~ "the same packaged app bundle launches as two isolated participant identities"
    assert plan =~ "issuer app"
    assert plan =~ "recipient app"
    assert plan =~ "pulls and persists the new delegation evidence"
    assert plan =~ "authors a post under that delegation"
    assert plan =~ "`Lattice.Sim` is the independent oracle"
    assert plan =~ "source, Tauri feed, and LiveView"
    assert plan =~ ~r/over-broad grant is rejected as `not_attenuated`/
    assert plan =~ "structural delivery"
    assert plan =~ "does not prove live-BEAM authority honoring"
    assert plan =~ "TOWNSHIP_SKIP_DELEGATION_GRANT_APP_BUILD=1"
    assert plan =~ "No mobile secure-store implementation change"
    assert plan =~ "No cross-device capability transfer or recipient-device custody claim"
    assert plan =~ "No revocation or succession handoff"
    assert plan =~
             ~r/Plan 139 remains the v6 revocation follow-on after Plans 140\s+and 141/
    assert plan =~ "No complete G1/Phase G claim and no receipt-free W4 claim"
    assert plan =~ "394 tests plus 25 properties"
    assert plan =~ "Hosted implementation run `29248868666` is green"
    assert plan =~ "`367eec72a1c7263de2997623bfe83a2bf81ff35b`"
    assert plan =~ "`Verify flagship artifact` completed in 3m36s"
    assert plan =~ "`Unit + property suite` completed in 4m26s"
    assert plan =~ "`Packaged macOS convergence` completed in 11m55s"
    assert plan =~ "Final exact-worktree Claude review returned `PROCEED`"
    assert plan =~ ~r/no blocker,\s+high, or medium finding/
    assert plan =~ ~r/recipient\s+app pulls and persists the issued delegation/
    assert plan =~ ~r/byte-identical to\s+`Lattice.Sim`/
    assert plan =~ "cites the new delegation"
    assert plan =~ "structurally relayed"
    assert plan =~ "reduces as `not_attenuated`"
    assert plan =~ "no usable authority"
    assert plan =~ ~r/## Completion claim\s+Complete for this scoped increment/
    refute plan =~ "Not yet complete"
    refute plan =~ "Hosted acceptance remains pending"

    assert plans_index =~
             "| 138 | Versioned delegation grant handoff | P1 | XL | 053, 054, 058, 130, 137 | DONE |"

    assert plans_index =~
             "Plan 138 closes the versioned delegation-grant handoff slice"

    assert shell_package["scripts"]["tauri:delegation-grant-handoff:smoke"] ==
             "tsx test/tauri_delegation_grant_handoff_smoke.ts"

    assert shell_package["scripts"]["app:convergence"] =~
             ~r/tauri:roster-action-handoff:smoke && TOWNSHIP_SKIP_DELEGATION_GRANT_APP_BUILD=1 npm run tauri:delegation-grant-handoff:smoke && npm run tauri:feed:smoke/

    assert workflow =~
             ~r/Verify packaged delegation grant handoff\s+working-directory: clients\/township-tauri-shell\s+env:\s+TOWNSHIP_SKIP_DELEGATION_GRANT_APP_BUILD: "1"\s+run: npm run tauri:delegation-grant-handoff:smoke/

    assert build_map =~ "Plan 138 adds the versioned delegation grant handoff"
    assert build_map =~ "Hosted Plan 138 run `29248868666` is green"
    assert build_map =~ "Plan 138 status is `DONE`"
    assert build_map =~ "delegation issuance slice is closed"
    refute build_map =~ "Plan 138 completes G1"
    refute build_map =~ "Plan 138 completes Phase G"
    refute build_map =~ "Plan 138 makes W4 receipt-free"

    [_, plan138_tail] =
      String.split(
        poc_status,
        "## Checkpoint: Versioned Delegation Grant Handoff",
        parts: 2
      )

    [plan138_checkpoint | _rest] = String.split(plan138_tail, "\n## Checkpoint:", parts: 2)

    assert plan138_checkpoint =~ "394 tests plus 25 properties"
    assert plan138_checkpoint =~ "Hosted implementation run `29248868666` is green"
    assert plan138_checkpoint =~ "Plan 138 status is `DONE`"
    assert plan138_checkpoint =~ "not_attenuated"
    refute plan138_checkpoint =~ "Hosted acceptance remains pending"

    assert mobile_strategy =~ "Plan 138 leaves this custody strategy unchanged"
  end
end
