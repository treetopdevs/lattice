defmodule TownshipBench.GroupOps do
  @moduledoc """
  Calibration seam for the cost model.

  The `CostModel` multiplies operation *counts* by per-primitive unit *times*. Those
  units must come from measuring the actual group of the pinned profile, not from a
  guess. This module is that measurement seam.

  STATUS: G2 closed 2026-07-17 pinning `chide-es-r255-v1`
  (docs/research/m4_g2_profile_pin.md): single-curve ristretto255, no pairings
  anywhere. `measure/2` times REAL scalar multiplications and point additions on
  ristretto255 through a verify-only Rustler NIF over curve25519-dalek
  (`TownshipBench.GroupOps.Native`), and `calibrate/0` returns `:measured` units
  derived from those timings.

  Honesty rule (findings §14/R7, AGENTS.md): if the NIF is unavailable in the
  running environment, `calibrate/0` returns `:uncalibrated` with the blocker
  named. It never substitutes a placeholder and calls it measured.
  """

  alias TownshipBench.GroupOps.Native

  # Scalar mult is tens of microseconds/op; point add is sub-microsecond.
  # Sample counts sized so each measurement window is a few tens of ms.
  @scalar_mult_samples 2_000
  @point_add_samples 200_000

  @type calibration :: %{
          status: :uncalibrated | :measured,
          curve: atom() | nil,
          unit_seconds: map() | nil,
          raw: map() | nil,
          notes: String.t()
        }

  @doc """
  Measure one ristretto255 primitive (`:scalar_mult` | `:point_add`) over
  `samples` iterations. Returns `{:ok, seconds_per_op}` from real curve
  arithmetic, or `{:error, reason}` — never a fabricated number.
  """
  @spec measure(:scalar_mult | :point_add, pos_integer()) ::
          {:ok, float()} | {:error, term()}
  def measure(op, samples) when op in [:scalar_mult, :point_add] and samples > 0 do
    {:ok, Native.measure_op(Atom.to_string(op), samples)}
  rescue
    _ in [UndefinedFunctionError] ->
      {:error, :nif_module_unavailable}

    e in [ErlangError] ->
      case e do
        %ErlangError{original: :nif_not_loaded} -> {:error, :nif_not_loaded}
        _ -> {:error, e.original}
      end
  end

  def measure(_op, _samples), do: {:error, :badarg}

  @doc """
  Calibrate the cost-model units against the pinned curve.

  On success returns `:measured` with `unit_seconds` derived from the two raw
  timings (see `derive_units/2` for the reviewable derivation). On any failure
  returns `:uncalibrated` naming the blocker.

  The measurement is cached per VM (`:persistent_term`): one run of the harness
  prices every scale and variant against ONE calibration, so its rows are
  mutually comparable and a report's echoed units are exactly the units used.
  """
  @spec calibrate() :: calibration()
  def calibrate do
    case :persistent_term.get(cache_key(), nil) do
      nil ->
        cal = do_calibrate()
        :persistent_term.put(cache_key(), cal)
        cal

      cal ->
        cal
    end
  end

  defp cache_key, do: {__MODULE__, :calibration}

  defp do_calibrate do
    with {:ok, exp_s} <- measure(:scalar_mult, @scalar_mult_samples),
         {:ok, add_s} <- measure(:point_add, @point_add_samples) do
      %{
        status: :measured,
        curve: :ristretto255,
        unit_seconds: derive_units(exp_s, add_s),
        raw: %{
          scalar_mult_seconds: exp_s,
          point_add_seconds: add_s,
          scalar_mult_samples: @scalar_mult_samples,
          point_add_samples: @point_add_samples
        },
        notes:
          "Measured on ristretto255 via curve25519-dalek (verify-only Rustler NIF), " <>
            "profile chide-es-r255-v1 (m4_g2_profile_pin.md §2). Composite units are " <>
            "derived from the raw scalar-mult/point-add timings by the documented " <>
            "formulas in GroupOps.derive_units/2. Applies to the no-pairing pinned " <>
            "profile only; pairing-based variants remain uncalibrated."
      }
    else
      {:error, reason} ->
        %{
          status: :uncalibrated,
          curve: nil,
          unit_seconds: nil,
          raw: nil,
          notes:
            "Calibration blocked: #{inspect(reason)} (ristretto255 NIF not available " <>
              "in this environment). Report uses CostModel placeholder units; numbers " <>
              "are order-of-magnitude and MUST NOT be read as measured cost (§14/R7)."
        }
    end
  end

  @doc """
  Derive per-primitive cost-model units (seconds) from the two measured raw
  timings. Every composite is a transparent linear formula a reviewer can
  challenge independently of the raw measurement:

    * `:exp`       = 1 scalar mult — the model's "exponentiation".
    * `:point_add` = 1 point addition (exposed for completeness).
    * `:enc`       = 3 exp — exponential ElGamal encryption: r·G, r·P, m·G
      (pin §2 "Encryption").
    * `:dec_share` = 3 exp + 1 add — one partial decryption (1 exp) plus its
      Chaum–Pedersen correctness proof (2 exp, 1 add) (pin §2 "Threshold
      decryption").
    * `:eq_test`   = 2 exp + 2 add — PET core: blinding both components of a
      2-element ciphertext difference (pin §2 "Encrypted-sort primitives").
      The per-test NIZK overhead is carried by the explicit `exp` term the
      cleansing phase charges alongside `eq_test` in `CostModel.op_counts/2`.
    * `:pairing`   = 0.0 — the pinned profile has NO pairings anywhere (pin §2
      "Group"); the `chide_es_r255` variant counts zero of them, and this unit
      is never applied to the legacy pairing variants (they stay uncalibrated).
  """
  @spec derive_units(float(), float()) :: map()
  def derive_units(exp_s, add_s) do
    %{
      exp: exp_s,
      point_add: add_s,
      enc: 3 * exp_s,
      dec_share: 3 * exp_s + add_s,
      eq_test: 2 * exp_s + 2 * add_s,
      pairing: 0.0
    }
  end
end
