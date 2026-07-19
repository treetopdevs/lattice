defmodule TownshipBench.GroupOps.Native do
  @moduledoc """
  Rustler NIF boundary for `TownshipBench.GroupOps` — verify-only timing of real
  ristretto255 group operations via curve25519-dalek.

  See `native/townshipbench_groupops/src/lib.rs`. The NIF does timing only: no
  keys, no ballots, no proofs, no protocol state. If the NIF cannot compile or
  load in some environment, `GroupOps.calibrate/0` degrades to `:uncalibrated`
  and says so — it never fakes a measurement.
  """

  use Rustler, otp_app: :township_bench, crate: "townshipbench_groupops"

  @doc """
  Time `samples` iterations of the named primitive ("scalar_mult" | "point_add")
  on ristretto255. Returns seconds per operation as a float. The timed loop runs
  on a dirty CPU scheduler inside the NIF, so BEAM scheduling does not pollute
  the window.
  """
  @spec measure_op(String.t(), pos_integer()) :: float()
  def measure_op(_op, _samples), do: :erlang.nif_error(:nif_not_loaded)
end
