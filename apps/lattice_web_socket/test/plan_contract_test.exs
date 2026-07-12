defmodule LatticeWebSocket.PlanContractTest do
  use ExUnit.Case, async: true

  @repo_root Path.expand("../../..", __DIR__)

  test "Plan 125 records reusable carrier ownership before the later instrument feed" do
    plan = File.read!(Path.join(@repo_root, "plans/125-reusable-websocket-carrier-boundary.md"))
    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))
    agents = File.read!(Path.join(@repo_root, "AGENTS.md"))
    readme = File.read!(Path.join(@repo_root, "README.md"))
    carrier_adr = File.read!(Path.join(@repo_root, "docs/adr/0005-carrier-interface.md"))
    poc_status = File.read!(Path.join(@repo_root, "docs/lattice_poc_status.md"))

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ "reusable real WebSocket carrier client boundary"
    assert plan =~ ~r/no\s+live instrument producer is wired/

    assert plans_index =~
             "| 125 | Reusable WebSocket carrier boundary | P1 | M | 017, 124 | DONE |"

    assert build_map =~ "`apps/lattice_web_socket`"
    assert build_map =~ "Plan 125 promotes the real WebSocket carrier client"
    assert build_map =~ "plans 023-132"
    assert build_map =~ ~r/Plan\s+126 adds the supervised pull-only carrier projection/

    assert agents =~ "Reusable WebSocket client and real carrier adapter"
    assert readme =~ "`apps/lattice_web_socket` owns"
    assert carrier_adr =~ "`Lattice.Carrier.WebSocket`"
    assert poc_status =~ ~r/through the reusable\s+`Lattice.Carrier.WebSocket`/
  end

  test "Plan 132 exposes atomic demultiplexing and carrier availability subscriptions" do
    plan =
      File.read!(Path.join(@repo_root, "plans/132-authenticated-carrier-availability-feed-g1.md"))

    assert plan =~ ~r/## Status\s+(?:IN PROGRESS|DONE)/
    assert plan =~ "one atomic request/reply API"
    assert plan =~ "never both"
    assert plan =~ "masked pong"
    assert plan =~ ~r/WebSocket\s+message fragmentation is not/

    Code.ensure_loaded!(Lattice.Transport.WebSocket.Client)
    Code.ensure_loaded!(Lattice.Carrier.WebSocket)

    assert function_exported?(Lattice.Transport.WebSocket.Client, :request_envelope, 3)
    assert function_exported?(Lattice.Transport.WebSocket.Client, :subscribe, 4)
    assert function_exported?(Lattice.Transport.WebSocket.Client, :unsubscribe, 2)
    assert function_exported?(Lattice.Carrier.WebSocket, :subscribe, 2)
    assert function_exported?(Lattice.Carrier.WebSocket, :subscribe, 3)
    assert function_exported?(Lattice.Carrier.WebSocket, :unsubscribe, 1)
  end
end
