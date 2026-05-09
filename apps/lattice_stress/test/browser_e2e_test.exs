defmodule LatticeStress.BrowserE2ETest do
  use ExUnit.Case, async: false

  @moduletag :browser_e2e

  test "two real browser tabs show actor-aware authority flow" do
    root = Path.expand("../../..", __DIR__)

    assert {output, 0} =
             System.cmd("npm", ["run", "browser:e2e"],
               cd: root,
               stderr_to_stdout: true
             )

    assert output =~ "Lattice browser E2E passed"
  end
end
