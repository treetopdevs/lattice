defmodule Hello do
  @moduledoc "C2 bytecode-gate probe: trivial entry + a stdlib call to test atomvmlib presence."

  def start do
    :erlang.display(:hello_from_atomvm)
    # Exercise the Erlang stdlib (atomvmlib). If this resolves, the runtime has the
    # standard library available (embedded or auto-loaded) — answers the C1 stdlib question.
    :erlang.display(:lists.seq(1, 3))
  end
end
