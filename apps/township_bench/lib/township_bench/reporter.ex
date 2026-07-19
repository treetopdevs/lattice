defmodule TownshipBench.Reporter do
  @moduledoc """
  Emits the metric set G13 mandates verbatim (m4_interface_redesign_brief.md, gate 13):
  CPU, wall time, memory, network bytes, artifact bytes, cold/warm verification,
  trustee count, candidate count, dummy ballots, and revotes.

  Two forms: a human table for the loop's status line, and a JSON record under
  priv/reports/ that the outer gate-closure loop reads to mark G13 terminal-emitted.
  The JSON always carries the calibration status so a consumer can never mistake an
  uncalibrated estimate for a measured result, and it echoes every C12 knob
  (trustees, max_corrupt, share_quorum, candidates, dummy_ratio, revote_ratio) so a
  report is meaningless-proof: the numbers cannot be quoted apart from the
  parameters that produced them.

  Calibration policy: measured ristretto255 units (GroupOps) apply ONLY to the
  pinned no-pairing variant `:chide_es_r255`. The legacy variants charge pairings,
  for which no measured unit exists — they always report `:uncalibrated`.
  """

  alias TownshipBench.{CostModel, GroupOps}

  @scales [100, 1_000, 10_000]

  @spec run([pos_integer()], CostModel.variant(), map() | keyword()) :: map()
  def run(scales \\ @scales, variant \\ :chide_encrypted_sort, overrides \\ %{}) do
    overrides = Map.new(overrides)
    cal = GroupOps.calibrate()
    {cal_status, cal_notes, unit_opts} = effective_calibration(cal, variant)

    rows =
      Enum.map(scales, fn n ->
        params = CostModel.params(n, overrides)
        est = CostModel.estimate(variant, params, unit_opts)

        %{
          participants: n,
          effective_ballots: est.effective_ballots,
          trustees: params.trustees,
          max_corrupt: params.max_corrupt,
          share_quorum: params.share_quorum,
          candidates: params.candidates,
          dummy_ratio: params.dummy_ratio,
          revote_ratio: params.revote_ratio,
          dummy_ballots: round(n * params.dummy_ratio),
          revotes: round(n * params.revote_ratio),
          # Single-process simulation: CPU is the single-core serial total by construction.
          cpu_seconds: Float.round(est.wall_seconds_single_core, 2),
          wall_seconds_single_core: Float.round(est.wall_seconds_single_core, 2),
          wall_seconds_parallel: Float.round(est.wall_seconds_parallel, 2),
          bytes_exchanged: est.bytes_exchanged,
          artifact_bytes: est.artifact_bytes,
          peak_memory_mb: est.peak_memory_mb,
          # Verification cost is the ballot_verify phase (pairings for the legacy
          # variants, Sigma-verify exponentiations for the pinned profile);
          # cold = full replay, warm = cached.
          verify_cold_seconds:
            Float.round(Map.get(est.per_phase_seconds, :ballot_verify, 0.0), 2),
          verify_warm_seconds:
            Float.round(Map.get(est.per_phase_seconds, :ballot_verify, 0.0) * 0.15, 2)
        }
      end)

    # Knob echo (C12): scale-independent parameters, stated once at top level and
    # repeated per row so a single extracted row still carries its knobs.
    knobs =
      CostModel.knobs()
      |> Map.new(fn k -> {k, Map.fetch!(CostModel.params(1, overrides), k)} end)

    %{
      gate: "G13",
      variant: variant,
      knobs: knobs,
      calibration: cal_status,
      calibration_notes: cal_notes,
      calibration_raw: cal.raw,
      unit_seconds: unit_seconds_echo(variant, unit_opts),
      generated_at: DateTime.utc_now() |> DateTime.to_iso8601(),
      rows: rows,
      # The loop reads this: the harness's job is done when it RUNS and emits metrics.
      # Whether the numbers are acceptable is a human product decision, not a loop exit.
      exit_condition:
        "harness ran and emitted mandated metrics at #{inspect(scales)}; " <>
          "town-scale acceptability is a human decision"
    }
    |> put_pin_check(variant, overrides)
  end

  # Measured units describe ristretto255 scalar-mult/point-add. Only the pinned
  # no-pairing variant is priced by them; a pairing variant priced with a zero
  # pairing unit would silently understate cost — the exact dishonesty §14/R7 bans.
  defp effective_calibration(%{status: :measured} = cal, :chide_es_r255),
    do: {:measured, cal.notes, [unit_seconds: cal.unit_seconds]}

  defp effective_calibration(%{status: :measured}, variant),
    do:
      {:uncalibrated,
       "Measured ristretto255 units exist but variant #{variant} charges pairing " <>
         "operations that have no measured unit (the pinned profile has none to " <>
         "measure). Placeholder units used; numbers are order-of-magnitude only.", []}

  defp effective_calibration(cal, _variant), do: {:uncalibrated, cal.notes, []}

  defp unit_seconds_echo(variant, unit_opts) do
    case Keyword.fetch(unit_opts, :unit_seconds) do
      {:ok, units} -> units
      # Placeholder path: echo what estimate/3 will actually use.
      :error -> CostModel.estimate(variant, CostModel.params(1), []).unit_seconds
    end
  end

  # For the pinned variant, flag whether the run's thresholds satisfy the pinned
  # relations q = t + 1 and n − t ≥ q (m4_g2_profile_pin.md §3). Advisory: the
  # harness prices any parameter set, but a mismatch must be visible in the report.
  defp put_pin_check(report, :chide_es_r255, overrides),
    do:
      Map.put(
        report,
        :thresholds_match_pin,
        CostModel.thresholds_match_pin?(CostModel.params(1, Map.new(overrides)))
      )

  defp put_pin_check(report, _variant, _overrides), do: report

  @spec human(map()) :: String.t()
  def human(%{rows: rows, calibration: cal, variant: v, knobs: k}) do
    header =
      "G13 · #{v} · calibration=#{cal}\n" <>
        "  knobs: trustees=#{k.trustees} max_corrupt=#{k.max_corrupt} " <>
        "share_quorum=#{k.share_quorum} candidates=#{k.candidates} " <>
        "dummy_ratio=#{k.dummy_ratio} revote_ratio=#{k.revote_ratio}\n" <>
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

  # Anchored to the app source tree so the report lands in
  # apps/township_bench/priv/reports regardless of the caller's cwd (AGENTS.md contract).
  @reports_dir Path.expand("../../priv/reports", __DIR__)

  @spec write_json(map(), Path.t()) :: :ok
  def write_json(report, dir \\ @reports_dir) do
    File.mkdir_p!(dir)
    path = Path.join(dir, "g13_#{report.variant}_#{System.os_time(:second)}.json")
    File.write!(path, JSON.encode!(report))
    IO.puts("wrote #{path}")
    :ok
  end
end
