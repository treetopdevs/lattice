defmodule Lattice.Tab.WasmSmokeTest do
  use ExUnit.Case, async: false
  # excluded from default `mix test` (see test_helper exclude)
  @moduletag :wasm

  test "packed .avm boots in the node bundle and answers a hello" do
    avm = Path.expand("../../../../examples/atomvm_tab/lattice_tab.avm", __DIR__)

    if File.exists?(avm) do
      {out, code} =
        System.cmd(
          "node",
          [Path.expand("../../../../scripts/lattice_atomvm_tab_smoke.mjs", __DIR__)],
          stderr_to_stdout: true
        )

      assert code == 0, out
      assert out =~ "SMOKE_OK"
    else
      flunk("run apps/lattice_tab/build_avm.sh first (no lattice_tab.avm staged)")
    end
  end
end
