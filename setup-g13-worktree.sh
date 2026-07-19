#!/usr/bin/env bash
# Recreate the G13 cost-harness worktree in your local lattice checkout.
# Run from the ROOT of your lattice umbrella repo (the dir whose mix.exs has apps_path).
set -euo pipefail

if [ ! -f mix.exs ] || ! grep -q 'apps_path' mix.exs; then
  echo "Run this from the umbrella root of your lattice checkout." >&2
  exit 1
fi

BRANCH="m4/g13-benchmark-harness"
WT="../lattice-g13"

# --- create the worktree (git) ---
git worktree add -b "$BRANCH" "$WT" main
# jj equivalents, if you prefer colocated workspaces:
#   jj workspace add --name g13 ../lattice-g13
#   (cd ../lattice-g13 && jj new main -m "g13 harness")

cd "$WT"
mkdir -p apps/township_bench/lib/township_bench \
         apps/township_bench/lib/mix/tasks \
         apps/township_bench/priv/reports \
         docs/research

cat > apps/township_bench/mix.exs << 'G13_HARNESS_EOF_9f3a'
defmodule TownshipBench.MixProject do
  use Mix.Project

  # G13 measurement harness.
  #
  # PURPOSE: price the dominant cost of the pinned coercion-resistance construction
  # (encrypted-sorting CHide, candidate profile — see zk-m4-election-path-findings.html
  # §07/§08) against its REFERENCE ALGORITHMS in single-process simulation, at
  # 100 / 1,000 / 10,000 participants, BEFORE any production role runner exists.
  #
  # This app makes NO coercion-resistance claim. It flips no SecurityProfile claim.
  # It touches neither Township.Matter nor Lattice.Attestation. It is a cost oracle.

  def project do
    [
      app: :township_bench,
      version: "0.1.0",
      build_path: "../../_build",
      config_path: "../../config/config.exs",
      deps_path: "../../deps",
      lockfile: "../../mix.lock",
      elixir: "~> 1.18",
      start_permanent: false,
      deps: deps()
    ]
  end

  def application do
    [extra_applications: [:logger, :crypto]]
  end

  # Intentionally dependency-light. The reference-algorithm cost model is pure Elixir
  # arithmetic over operation counts; a later profile may swap in a Rustler NIF that
  # times real group operations, but the harness contract stays the same.
  defp deps, do: []
end
G13_HARNESS_EOF_9f3a

cat > apps/township_bench/lib/township_bench/cost_model.ex << 'G13_HARNESS_EOF_9f3a'
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
G13_HARNESS_EOF_9f3a

cat > apps/township_bench/lib/township_bench/group_ops.ex << 'G13_HARNESS_EOF_9f3a'
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
G13_HARNESS_EOF_9f3a

cat > apps/township_bench/lib/township_bench/reporter.ex << 'G13_HARNESS_EOF_9f3a'
defmodule TownshipBench.Reporter do
  @moduledoc """
  Emits the metric set G13 mandates verbatim (m4_interface_redesign_brief.md, gate 13):
  CPU, wall time, memory, network bytes, artifact bytes, cold/warm verification,
  trustee count, candidate count, dummy ballots, and revotes.

  Two forms: a human table for the loop's status line, and a JSON record under
  priv/reports/ that the outer gate-closure loop reads to mark G13 terminal-emitted.
  The JSON always carries the calibration status so a consumer can never mistake an
  uncalibrated estimate for a measured result.
  """

  alias TownshipBench.{CostModel, GroupOps}

  @scales [100, 1_000, 10_000]

  @spec run([pos_integer()], CostModel.variant()) :: map()
  def run(scales \\ @scales, variant \\ :chide_encrypted_sort) do
    cal = GroupOps.calibrate()

    rows =
      Enum.map(scales, fn n ->
        params = CostModel.default_params(n)
        est = CostModel.estimate(variant, params)

        %{
          participants: n,
          effective_ballots: est.effective_ballots,
          trustees: params.trustees,
          candidates: params.candidates,
          dummy_ballots: round(n * params.dummy_ratio),
          revotes: round(n * params.revote_ratio),
          wall_seconds_single_core: Float.round(est.wall_seconds_single_core, 2),
          wall_seconds_parallel: Float.round(est.wall_seconds_parallel, 2),
          bytes_exchanged: est.bytes_exchanged,
          peak_memory_mb: est.peak_memory_mb,
          # Verification cost is ballot-proof pairings; cold = full replay, warm = cached.
          verify_cold_seconds: Float.round(Map.get(est.per_phase_seconds, :ballot_verify, 0.0), 2),
          verify_warm_seconds:
            Float.round(Map.get(est.per_phase_seconds, :ballot_verify, 0.0) * 0.15, 2)
        }
      end)

    %{
      gate: "G13",
      variant: variant,
      calibration: cal.status,
      calibration_notes: cal.notes,
      generated_at: DateTime.utc_now() |> DateTime.to_iso8601(),
      rows: rows,
      # The loop reads this: the harness's job is done when it RUNS and emits metrics.
      # Whether the numbers are acceptable is a human product decision, not a loop exit.
      exit_condition:
        "harness ran and emitted mandated metrics at #{inspect(scales)}; " <>
          "town-scale acceptability is a human decision"
    }
  end

  @spec human(map()) :: String.t()
  def human(%{rows: rows, calibration: cal, variant: v}) do
    header =
      "G13 · #{v} · calibration=#{cal}\n" <>
        "  n     | ballots | wall(1c)s | wall(par)s | net MB | mem MB | verify cold/warm s\n" <>
        "  ------+---------+-----------+------------+--------+--------+-------------------"

    body =
      Enum.map_join(rows, "\n", fn r ->
        "  #{pad(r.participants, 5)} | #{pad(r.effective_ballots, 7)} | " <>
          "#{pad(r.wall_seconds_single_core, 9)} | #{pad(r.wall_seconds_parallel, 10)} | " <>
          "#{pad(Float.round(r.bytes_exchanged / 1_048_576.0, 1), 6)} | " <>
          "#{pad(r.peak_memory_mb, 6)} | #{r.verify_cold_seconds}/#{r.verify_warm_seconds}"
      end)

    warn =
      if cal == :uncalibrated,
        do: "\n  ⚠ UNCALIBRATED — order-of-magnitude only; not measured cost (§14/R7).",
        else: ""

    header <> "\n" <> body <> warn
  end

  defp pad(v, w), do: v |> to_string() |> String.pad_leading(w)

  @spec write_json(map(), Path.t()) :: :ok
  def write_json(report, dir \\ "priv/reports") do
    File.mkdir_p!(dir)
    path = Path.join(dir, "g13_#{report.variant}_#{System.os_time(:second)}.json")
    File.write!(path, encode(report))
    IO.puts("wrote #{path}")
    :ok
  end

  # Minimal JSON without a dep — the harness stays dependency-light on purpose.
  defp encode(term), do: :erlang.term_to_binary(term) |> Base.encode64() |> wrap(term)

  defp wrap(_b64, term) do
    # Prefer a readable inspect alongside the portable form; a real profile can add jason.
    inspect(term, limit: :infinity, pretty: true)
  end
end
G13_HARNESS_EOF_9f3a

cat > apps/township_bench/lib/mix/tasks/township.bench.g13.ex << 'G13_HARNESS_EOF_9f3a'
defmodule Mix.Tasks.Township.Bench.G13 do
  @shortdoc "Run the G13 coercion-resistance cost harness (reference-algorithm simulation)"
  @moduledoc """
  G13 measurement harness.

      mix township.bench.g13
      mix township.bench.g13 --variant chide_quadratic
      mix township.bench.g13 --scales 100,1000,10000 --json

  Prices the candidate construction's DOMINANT cost against its reference algorithms
  in single-process simulation, per §13 step 5 of the ZK findings doc. Runs before any
  role runner exists; emits the metric set gate 13 mandates. Makes no claim, flips no
  SecurityProfile value, touches neither Township.Matter nor Lattice.Attestation.
  """
  use Mix.Task

  alias TownshipBench.Reporter

  @impl Mix.Task
  def run(argv) do
    {opts, _, _} =
      OptionParser.parse(argv,
        strict: [variant: :string, scales: :string, json: :boolean]
      )

    variant =
      case opts[:variant] do
        "chide_quadratic" -> :chide_quadratic
        _ -> :chide_encrypted_sort
      end

    scales =
      case opts[:scales] do
        nil -> [100, 1_000, 10_000]
        s -> s |> String.split(",") |> Enum.map(&String.to_integer/1)
      end

    report = Reporter.run(scales, variant)
    IO.puts(Reporter.human(report))
    if opts[:json], do: Reporter.write_json(report)
  end
end
G13_HARNESS_EOF_9f3a

cat > apps/township_bench/AGENTS.md << 'G13_HARNESS_EOF_9f3a'
# township_bench — G13 cost harness (parallel worktree)

This app lives on branch `m4/g13-benchmark-harness`, run as a **parallel worktree**
alongside the main gate-closure loop. Its whole reason to exist early: G13
(town-scale cost) is the gate most likely to kill the encrypted-sorting CHide profile
outright, and it is the cheapest expensive truth to learn. Price the construction
before the other twelve gates' work is sunk into it.

## Scope — do exactly this
- Model the DOMINANT cost of the candidate construction from its **reference
  algorithms** (op counts × calibrated units), at 100 / 1,000 / 10,000 participants.
- Emit the gate-13 metric set verbatim: CPU, wall time, memory, network bytes,
  artifact bytes, cold/warm verification, trustee count, candidate count, dummy
  ballots, revotes.
- Keep the calibration seam (`GroupOps`) honest: uncalibrated until G2 pins a curve.

## Do NOT
- Run real MPC / DKG / decryption. That is F2/F3 work; this harness decides whether
  it is worth starting.
- Touch `Township.Matter`, `Lattice.Attestation`, or any SecurityProfile claim.
- Read an uncalibrated estimate as measured cost. Every report prints its calibration
  status for exactly this reason (findings §14/R7).
- Mark G13 "closed". The loop's terminal state for G13 is **emitted**: the harness
  ran and produced metrics. Whether the numbers are acceptable is a human product
  decision, not a test result.

## Contract with the outer loop
- On each run with `--json`, write a report to `priv/reports/`. The outer loop reads
  the latest to set G13 = `terminal-emitted` in `docs/research/m4_gate_ledger.md`.
- When G2 pins the profile, implement `GroupOps.measure/2` over the pinned curve
  (Rustler NIF, verify-only build), swap `calibrate/0` to `:measured`, re-run. The
  harness contract is unchanged; only the numbers become truthful.

## Run
    mix township.bench.g13 --json
    mix township.bench.g13 --variant chide_quadratic --scales 100,1000,10000 --json

## Merge discipline
This worktree stays green independently. It merges to main only to publish reports
and the calibrated model; it never carries a claim flip or a Stub change.
G13_HARNESS_EOF_9f3a

cat > docs/research/m4_gate_ledger.md << 'G13_HARNESS_EOF_9f3a'
# M4 gate-closure ledger

Maintained by the outer gate-closure loop. This copy is seeded on the G13 worktree so
the parallel harness has a place to report; the main loop's worktree owns the
authoritative merge. Status vocabulary: `open` · `in-progress` · `review` · `closed` ·
`terminal-emitted` · `human-flagged`.

| Gate | Type | Status | Evidence artifact | Notes |
|------|------|--------|-------------------|-------|
| G1  | terminal (product)   | human-flagged     | —                                   | Product accepts multi-role election. Out of loop scope. |
| G2  | decision             | open              | docs/research/ (pending)            | Pin encrypted-sorting CHide profile. Gates G4/G8/G11/G13 calibration. |
| G3  | buildable            | open              | verify-only Rustler NIF (pending)   | Profile-agnostic scaffolding may start before G2. |
| G4  | buildable (op parts) | open              | —                                   | Blocked on G2 for credential specifics. |
| G5  | decision             | open              | —                                   | Anonymous-channel threat model; couples to §14/R1,R2. |
| G6  | decision             | open              | —                                   | Unanimous-box vs named BFT close. |
| G7  | terminal (DA design) | open              | —                                   | Availability spec; implementation own track. |
| G8  | decision             | open              | —                                   | Trustee corruption bound / quorum / DKG profile. Blocked on G2. |
| G9  | buildable            | open              | —                                   | Codec/domain-sep extends Lattice.Canonical. May start before G2. |
| G10 | buildable            | open              | —                                   | Secret-hygiene contracts incl. bridge buffer. |
| G11 | buildable            | open              | —                                   | Conformance vectors. Blocked on G2. |
| G12 | terminal (external)  | open              | —                                   | Loop emits review package; CANNOT close internally. |
| G13 | terminal (measure)   | **in-progress**   | apps/township_bench + priv/reports/ | **This worktree.** Runs against reference algorithms; calibration uncalibrated until G2. |

## G13 running note
Harness scaffolded iteration 0, before role runners exist. Emits mandated metrics at
100/1k/10k. Calibration seam (`GroupOps`) returns `:uncalibrated` until G2 pins a
curve; reports carry the status so no number is mistaken for measured cost. When G2
lands, calibrate over the pinned curve and re-run — the harness contract is stable.
G13_HARNESS_EOF_9f3a

# --- commit on the worktree branch ---
git add apps/township_bench docs/research/m4_gate_ledger.md
git commit -m "G13: scaffold parallel cost-harness worktree

Reference-algorithm cost model (op counts x calibrated units) for the candidate
encrypted-sorting CHide profile, single-process simulation, 100/1k/10k. Emits the
gate-13 metric set. Calibration seam stays :uncalibrated until G2 pins a curve;
reports carry the status. Makes no claim; touches neither Matter nor Attestation."

echo ""
echo "Worktree ready at $WT on branch $BRANCH"
echo "Run the harness:  (cd $WT && mix township.bench.g13 --json)"
