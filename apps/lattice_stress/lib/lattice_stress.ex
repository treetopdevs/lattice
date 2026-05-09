defmodule LatticeStress do
  @moduledoc """
  Adversarial stress helpers for the Lattice POC.

  This application is intentionally outside the framework surface. It provides
  instrumented tabs, servers, barriers, and load runners that attack the
  existing capability gateway.
  """

  def diagnostics, do: Lattice.diagnostics()
end
