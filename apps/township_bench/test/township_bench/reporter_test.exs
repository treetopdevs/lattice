defmodule TownshipBench.ReporterTest do
  use ExUnit.Case, async: true

  alias TownshipBench.{GroupOps, Reporter}

  # The gate-13 metric set, verbatim from m4_interface_redesign_brief.md §15.13.
  @mandated_row_keys [
    :cpu_seconds,
    :wall_seconds_single_core,
    :wall_seconds_parallel,
    :peak_memory_mb,
    :bytes_exchanged,
    :artifact_bytes,
    :verify_cold_seconds,
    :verify_warm_seconds,
    :trustees,
    :candidates,
    :dummy_ballots,
    :revotes
  ]

  test "report emits every mandated metric at every scale" do
    report = Reporter.run([100, 1_000], :chide_encrypted_sort)

    assert length(report.rows) == 2

    for row <- report.rows, key <- @mandated_row_keys do
      assert Map.has_key?(row, key), "row missing mandated metric #{key}"
    end
  end

  test "report carries calibration status and it is honest about G2" do
    report = Reporter.run([100], :chide_encrypted_sort)

    # Until G2 pins a curve, the seam must say so; a :measured status here without a
    # pinned curve would be the §14/R7 failure this harness exists to prevent.
    assert report.calibration == GroupOps.calibrate().status
    assert report.calibration in [:uncalibrated, :measured]
  end

  test "written report is valid JSON with calibration and mandated row keys" do
    report = Reporter.run([100], :chide_encrypted_sort)

    dir = Path.join(System.tmp_dir!(), "g13_reporter_test_#{System.unique_integer([:positive])}")
    :ok = Reporter.write_json(report, dir)

    [path] = Path.wildcard(Path.join(dir, "g13_*.json"))
    decoded = path |> File.read!() |> JSON.decode!()

    assert decoded["gate"] == "G13"
    assert is_binary(decoded["calibration"])
    assert [row | _] = decoded["rows"]

    for key <- @mandated_row_keys do
      assert Map.has_key?(row, to_string(key)), "JSON row missing #{key}"
    end
  after
    Path.wildcard(Path.join(System.tmp_dir!(), "g13_reporter_test_*"))
    |> Enum.each(&File.rm_rf!/1)
  end

  test "quadratic variant dominates encrypted-sorting at scale" do
    quad = Reporter.run([10_000], :chide_quadratic)
    sort = Reporter.run([10_000], :chide_encrypted_sort)

    [q] = quad.rows
    [s] = sort.rows

    assert q.wall_seconds_single_core > s.wall_seconds_single_core * 10
  end
end
