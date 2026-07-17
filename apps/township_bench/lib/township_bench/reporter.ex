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
          # Single-process simulation: CPU is the single-core serial total by construction.
          cpu_seconds: Float.round(est.wall_seconds_single_core, 2),
          wall_seconds_single_core: Float.round(est.wall_seconds_single_core, 2),
          wall_seconds_parallel: Float.round(est.wall_seconds_parallel, 2),
          bytes_exchanged: est.bytes_exchanged,
          artifact_bytes: est.artifact_bytes,
          peak_memory_mb: est.peak_memory_mb,
          # Verification cost is ballot-proof pairings; cold = full replay, warm = cached.
          verify_cold_seconds:
            Float.round(Map.get(est.per_phase_seconds, :ballot_verify, 0.0), 2),
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
