defmodule LatticeCarrierServer.Operator.MutationProtocolTest do
  use ExUnit.Case, async: true

  test "actual private helper parser rejects duplicate/type/canonical/bound substitutions" do
    python = System.find_executable("python3")
    assert is_binary(python), "Python3 is required for operator-host validation"

    {output, status} =
      System.cmd(python, [Path.join(__DIR__, "mutation_protocol_test.py")],
        stderr_to_stdout: true
      )

    assert status == 0, output
  end
end
