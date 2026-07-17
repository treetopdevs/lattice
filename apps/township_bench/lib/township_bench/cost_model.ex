defmodule TownshipBench.CostModel do
  @moduledoc """
  Reference-algorithm cost model for the candidate G13 constructions.

  This is a *transparent* cost model: it derives operation counts from the published
  asymptotics of the encrypted-sorting CHide treatment (ePrint 2023/837, O(n log n)
  cleansing) and the original CHide (ePrint 2022/430, O(n^2)), then multiplies by a
  per-operation cost that is EITHER a placeholder constant OR a measured time from a
  real group-op micro-benchmark (see `TownshipBench.GroupOps`).

  The point is falsifiability. Every number this module emits is `count * unit`, and
  both factors are printed in the report, so a reviewer can challenge either the
  operation-count formula or the calibration independently — the same discipline the
  M4 verdict used when it imported the "48 CPU-days / 668 GB at 10k" figures.

  Variants:

    * `:chide_quadratic` / `:chide_encrypted_sort` — the pre-pin generic models
      (pairing-verified ballots, historical committee defaults). Kept byte-for-byte
      so earlier reports stay reproducible.
    * `:chide_es_r255` — the G2-PINNED profile `chide-es-r255-v1`
      (docs/research/m4_g2_profile_pin.md, 2026-07-17): single-curve ristretto255,
      exponential ElGamal, Sigma/Fiat–Shamir ballot proofs, Bayer–Groth shuffle,
      PET + conditional-zeroing cleansing with order-free remove-all. There are
      ZERO pairings anywhere in this variant by construction (pin §2 "Group").

  Every parameter is a knob (review finding C12): trustees, max_corrupt,
  share_quorum, candidates, dummy_ratio, revote_ratio are settable per run and the
  report echoes all of them.

  It deliberately does NOT run the real MPC. Running true trustee rounds is F2/F3
  work; this harness exists to decide whether that work is worth starting.
  """

  @type variant :: :chide_quadratic | :chide_encrypted_sort | :chide_es_r255
  @type params :: %{
          n: pos_integer(),
          trustees: pos_integer(),
          max_corrupt: non_neg_integer(),
          share_quorum: pos_integer(),
          candidates: pos_integer(),
          dummy_ratio: float(),
          revote_ratio: float()
        }

  @knobs [:trustees, :max_corrupt, :share_quorum, :candidates, :dummy_ratio, :revote_ratio]

  @doc "The C12 knob set every report must echo."
  @spec knobs() :: [atom()]
  def knobs, do: @knobs

  @doc "Default town-scale parameter set. Every value is a knob the report echoes."
  @spec default_params(pos_integer()) :: params()
  def default_params(n) do
    %{
      n: n,
      trustees: 3,
      max_corrupt: 1,
      share_quorum: 2,
      candidates: 4,
      dummy_ratio: 1.0,
      revote_ratio: 0.1
    }
  end

  @doc """
  Merge per-run knob overrides (C12) into the defaults for scale `n`.
  Unknown keys are rejected loudly rather than silently ignored.
  """
  @spec params(pos_integer(), map() | keyword()) :: params()
  def params(n, overrides \\ %{}) do
    overrides = Map.new(overrides)

    case Map.keys(overrides) -- @knobs do
      [] -> Map.merge(default_params(n), overrides)
      unknown -> raise ArgumentError, "unknown cost-model knobs: #{inspect(unknown)}"
    end
  end

  @doc """
  Does this parameter set describe the PINNED committee of `chide-es-r255-v1`
  (m4_g2_profile_pin.md §3): exactly `n = 5`, `t = 2`, `q = 3` — which also
  satisfies the manifest relations `q = t + 1` and `n − t ≥ q`? Advisory only —
  the harness prices whatever it is given, but a report over a different
  committee must visibly say it is not pricing the pinned profile's committee.
  """
  @spec thresholds_match_pin?(params()) :: boolean()
  def thresholds_match_pin?(%{trustees: n, max_corrupt: t, share_quorum: q}) do
    n == 5 and t == 2 and q == 3 and q == t + 1 and n - t >= q
  end

  # Effective ballot count the tally must process: real + dummy + revote inflation.
  # dummy_ratio prices the open-posting cover traffic the pin preserves (§4 "Cover
  # traffic preserved"); revote_ratio prices duplicate submissions the cleansing
  # remove-all rule must detect and strike (§4 "Duplicate policy") — v1 offers no
  # revote UX, but duplicates still arrive and still cost.
  defp effective_ballots(%{n: n, dummy_ratio: d, revote_ratio: r}) do
    round(n * (1.0 + d + r))
  end

  @doc """
  Operation-count profile for a variant, as a map of named phases to counts of
  each primitive group operation. Counts are the reviewable artifact.

  Primitives counted:
    * :exp        — modular exponentiation / scalar mult (dominant cost)
    * :pairing    — bilinear pairing (legacy variants only; the pinned profile
                    has none — pin §2)
    * :enc        — ElGamal encryptions
    * :dec_share  — threshold decryption-share computations
    * :eq_test    — encrypted plaintext-equality tests (the cleansing hot loop)
  """
  @spec op_counts(variant(), params()) :: %{atom() => %{atom() => non_neg_integer()}}
  def op_counts(variant, params)

  # ── Legacy pre-pin variants — kept unchanged for report reproducibility ──────
  def op_counts(variant, params) when variant in [:chide_quadratic, :chide_encrypted_sort] do
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

  # ── Pinned profile chide-es-r255-v1 (m4_g2_profile_pin.md) ───────────────────
  def op_counts(:chide_es_r255, params) do
    m = effective_ballots(params)
    n_t = params.trustees
    q = params.share_quorum
    c = params.candidates
    logm = max(1, ceil_log2(m))

    %{
      # Pedersen DKG hardened per GJKR, degree-(q−1) Shamir sharing (pin §2 "DKG").
      # Each of the n trustees publishes q coefficient commitments (q exps) and
      # each of the other n−1 trustees checks its received share against them
      # (a q-term multi-exp plus one base exp ≈ q+1 exps). Negligible at n=5;
      # counted for completeness.
      setup_dkg: %{exp: n_t * q + n_t * (n_t - 1) * (q + 1)},

      # Sigma/Fiat–Shamir ballot verification — exponentiations, NOT pairings
      # (pin §2 "Ballot well-formedness proofs": Sigma NIZKs in the ROM, no SNARK,
      # no pairing curve anywhere). Per ballot:
      #   * choice-in-domain OR-proof over the frozen ≤16-choice list,
      #     O(|choices|) size: ~2 Chaum–Pedersen equations per branch over the
      #     2-element ciphertext ≈ 4·c exps;
      #   * knowledge-of-plaintext ≈ 2 exps;
      #   * credential-encryption well-formedness ≈ 4 exps.
      # RV-1 (pin §7.1) is the standing check that the paper's exact statement
      # set stays O(|choices|) Sigma-expressible; if RV-1 reopens, this formula
      # reopens with it.
      ballot_verify: %{exp: m * (4 * c + 6)},

      # Encrypted-sort cleansing, O(m log m) (pin §2 "Encrypted-sort primitives",
      # §4 remove-all): the sort network performs ~m·log2(m) PET/conditional-
      # zeroing gates; each gate's NIZK production/verification overhead is
      # charged as the explicit 6 exps alongside each eq_test (the eq_test unit
      # itself covers only the ciphertext blinding — see GroupOps.derive_units/2).
      cleansing: %{eq_test: m * logm, exp: 6 * m * logm},

      # Bayer–Groth shuffle verification is O(m) exps per trustee mix pass
      # (pin §2 "Verifiable shuffle"), and threshold decryption needs q = quorum
      # shares per opened value with Chaum–Pedersen proofs (pin §2 "Threshold
      # decryption").
      mix_decrypt: %{dec_share: m * q, exp: 4 * m * n_t}
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

    # Persistent replay transcript: published ballot artifacts (ciphertext + proof)
    # plus the cleansing and mix/decrypt proof bytes. A subset of bytes_exchanged —
    # what an offline verifier must hold, not what trustees exchanged to produce it.
    ballot_artifact_b =
      m * (Map.get(unit_b, :ciphertext, 256) + Map.get(unit_b, :ballot_proof, 384))

    transcript_b =
      [:cleansing, :mix_decrypt]
      |> Enum.map(&Map.get(counts, &1, %{}))
      |> Enum.reduce(0, fn ops, acc ->
        acc + Enum.reduce(ops, 0, fn {op, c}, a -> a + c * Map.get(unit_b, op, 0) end)
      end)

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
      artifact_bytes: ballot_artifact_b + transcript_b,
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

  # PLACEHOLDER CONSTANTS — used only when GroupOps has no measurement to offer
  # (or for the legacy pairing variants, which no measured ristretto255 unit can
  # describe). Order-of-magnitude only; the report's calibration status flags them
  # so no reviewer mistakes them for measured truth.
  defp default_unit_seconds do
    %{exp: 1.0e-4, pairing: 5.0e-4, enc: 2.0e-4, dec_share: 1.5e-4, eq_test: 4.0e-4}
  end

  # Byte weights. For the pinned profile: ciphertext = 2 compressed ristretto255
  # elements per choice slot at 64 B (pin §3), kept at the generic 256 B envelope
  # here to stay comparable with the legacy variants; ballot_proof stays well under
  # the pinned ≤4 KiB bound.
  defp default_unit_bytes do
    %{
      exp: 0,
      pairing: 0,
      enc: 128,
      dec_share: 96,
      eq_test: 256,
      ciphertext: 256,
      ballot_proof: 384
    }
  end
end
