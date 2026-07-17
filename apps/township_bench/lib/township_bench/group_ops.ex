defmodule TownshipBench.GroupOps do
  @moduledoc """
  Calibration seam for the cost model.

  The `CostModel` multiplies operation *counts* by per-primitive unit *times*. Those
  units must eventually come from measuring the actual group of the pinned profile,
  not from a guess. This module is that measurement seam.

  STATUS: stub. Until the profile is pinned (G2), there is no specific curve to time,
  so `calibrate/0` returns the model's placeholder units and marks them :uncalibrated.
  Once G2 lands, replace the body with a micro-benchmark over the pinned curve's
  scalar-mult / pairing (via a Rustler NIF over arkworks, verify-only build), and
  return :measured units. The harness contract does not change — only the numbers do.

  Keeping calibration behind this seam is what lets the harness ship in iteration one
  and become truthful later without a rewrite.
  """

  @spec calibrate() :: %{status: :uncalibrated | :measured, unit_seconds: map(), notes: String.t()}
  def calibrate do
    %{
      status: :uncalibrated,
      unit_seconds: nil,
      notes:
        "No curve pinned (G2 open). Report uses CostModel placeholder units. " <>
          "Numbers are order-of-magnitude and MUST NOT be read as measured cost."
    }
  end

  @doc """
  Once a curve is pinned: time N scalar-mults and pairings, return seconds/op.
  Left unimplemented deliberately — implementing it against an unpinned curve would
  manufacture exactly the false confidence §14/R7 warns about.
  """
  @spec measure(atom(), pos_integer()) :: {:error, :no_pinned_profile}
  def measure(_curve, _samples), do: {:error, :no_pinned_profile}
end
