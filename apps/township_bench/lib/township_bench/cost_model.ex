defmodule TownshipBench.CostModel do
  @moduledoc """
  Reference-algorithm cost model for the candidate G13 construction.

  This is a *transparent* cost model: it derives operation counts from the published
  asymptotics of the encrypted-sorting CHide treatment (ePrint 2023/837, O(n log n)
  cleansing) and the original CHide (ePrint 2022/430, O(n^2)), then multiplies by a
  per-operation cost that is EITHER a calibrated constant OR a measured time from a
  real group-op micro-benchmark (see `TownshipBench.GroupOps`).

  The point is falsifiability. Every number this module emits is `count * unit`, and
  both factors are printed in the report, so a reviewer can challenge either the
  operation-count formula or the calibration independently — the same discipline the
  M4 verdict used when it imported the "48 CPU-days / 668 GB at 10k" figures.

  It deliberately does NOT run the real MPC. Running true trustee rounds is F2/F3
  work; this harness exists to decide whether that work is worth starting.
  """

  @type variant :: :chide_quadratic | :chide_encrypted_sort
  @type params :: %{
          n: pos_integer(),
          trustees: pos_integer(),
          corrupt_bound: non_neg_integer(),
          share_quorum: pos_integer(),
          candidates: pos_integer(),
          dummy_ratio: float(),
          revote_ratio: float()
        }

  @doc "Default town-scale parameter set. Every value is a knob the report echoes."
  @spec default_params(pos_integer()) :: params()
  def default_params(n) do
    %{
      n: n,
      trustees: 3,
      corrupt_bound: 1,
      share_quorum: 2,
      candidates: 4,
      dummy_ratio: 1.0,
      revote_ratio: 0.1
    }
  end

  # Effective ballot count the tally must process: real + dummy + revote inflation.
  defp effective_ballots(%{n: n, dummy_ratio: d, revote_ratio: r}) do
    round(n * (1.0 + d + r))
  end

  @doc """
  Operation-count profile for a variant, as a map of named phases to counts of
  each primitive group operation. Counts are the reviewable artifact.

  Primitives counted:
    * :exp        — modular exponentiation / scalar mult (dominant cost)
    * :pairing    — bilinear pairing (proof verification)
    * :enc        — ElGamal encryptions
    * :dec_share  — threshold decryption-share computations
    * :eq_test    — encrypted plaintext-equality tests (the cleansing hot loop)
  """
  @spec op_counts(variant(), params()) :: %{atom() => %{atom() => non_neg_integer()}}
  def op_counts(variant, params) do
    m = effective_ballots(params)
    t = params.trustees

    cleansing =
      case variant do
        # Original CHide: pairwise duplicate/fake elimination is quadratic in m.
        :chide_quadratic ->
          %{eq_test: m * m, exp: 6 * m * m}

        # Encrypted-sorting CHide: oblivious sort brings cleansing to O(m log m).
        :chide_encrypted_sort ->
          logm = max(1, ceil_log2(m))
          %{eq_test: m * logm, exp: 6 * m * logm}
      end

    %{
      setup_dkg: %{exp: 3 * t * t},
      ballot_verify: %{pairing: 2 * m, exp: m},
      cleansing: cleansing,
      mix_decrypt: %{dec_share: m * t, exp: 4 * m * t}
    }
  end

  defp ceil_log2(x) when x <= 1, do: 0
  defp ceil_log2(x), do: x |> :math.log2() |> :math.ceil() |> trunc()

  @doc """
  Total cost for a variant given per-primitive unit times (seconds) and unit bytes.
  Returns wall-time seconds (single-core, per phase and total) and bytes exchanged.
  Memory is estimated from peak live ciphertext set, not counted per-op.
  """
  @spec estimate(variant(), params(), keyword()) :: map()
  def estimate(variant, params, opts \\ []) do
    unit_s = Keyword.get(opts, :unit_seconds, default_unit_seconds())
    unit_b = Keyword.get(opts, :unit_bytes, default_unit_bytes())
    cores = Keyword.get(opts, :trustee_cores, params.trustees)

    counts = op_counts(variant, params)

    per_phase_s =
      Map.new(counts, fn {phase, ops} ->
        {phase, Enum.reduce(ops, 0.0, fn {op, c}, acc -> acc + c * Map.get(unit_s, op, 0.0) end)}
      end)

    total_s = per_phase_s |> Map.values() |> Enum.sum()

    bytes =
      counts
      |> Map.values()
      |> Enum.reduce(0, fn ops, acc ->
        acc + Enum.reduce(ops, 0, fn {op, c}, a -> a + c * Map.get(unit_b, op, 0) end)
      end)

    m = effective_ballots(params)
    peak_ciphertext_mb = m * Map.get(unit_b, :ciphertext, 256) / 1_048_576.0

    %{
      variant: variant,
      params: params,
      effective_ballots: m,
      op_counts: counts,
      wall_seconds_single_core: total_s,
      # Cleansing + mix/decrypt parallelize across the trustee committee.
      wall_seconds_parallel: parallelize(per_phase_s, cores),
      per_phase_seconds: per_phase_s,
      bytes_exchanged: bytes,
      peak_memory_mb: Float.round(peak_ciphertext_mb, 2),
      unit_seconds: unit_s,
      unit_bytes: unit_b
    }
  end

  # Setup/verify are not committee-parallel; cleansing and mix/decrypt are.
  defp parallelize(per_phase_s, cores) when cores > 0 do
    serial = Map.get(per_phase_s, :setup_dkg, 0.0) + Map.get(per_phase_s, :ballot_verify, 0.0)
    parallel = Map.get(per_phase_s, :cleansing, 0.0) + Map.get(per_phase_s, :mix_decrypt, 0.0)
    serial + parallel / cores
  end

  # CALIBRATION CONSTANTS — placeholders until GroupOps measures the real curve.
  # Order-of-magnitude only; flagged so no reviewer mistakes them for measured truth.
  # ~0.1 ms/exp, ~0.5 ms/pairing on a 2026 core is the calibration target.
  defp default_unit_seconds do
    %{exp: 1.0e-4, pairing: 5.0e-4, enc: 2.0e-4, dec_share: 1.5e-4, eq_test: 4.0e-4}
  end

  defp default_unit_bytes do
    %{exp: 0, pairing: 0, enc: 128, dec_share: 96, eq_test: 256, ciphertext: 256}
  end
end
