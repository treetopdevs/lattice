defmodule TownshipBench.ReporterTest do
  use ExUnit.Case, async: true

  alias TownshipBench.{CostModel, GroupOps, Reporter}

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

  # The C12 knob set every report must echo (m4_g2_profile_pin.md §7.8).
  @knobs [:trustees, :max_corrupt, :share_quorum, :candidates, :dummy_ratio, :revote_ratio]

  # The pinned committee parameters (m4_g2_profile_pin.md §3).
  @pinned %{trustees: 5, max_corrupt: 2, share_quorum: 3}

  test "report emits every mandated metric at every scale" do
    report = Reporter.run([100, 1_000], :chide_encrypted_sort)

    assert length(report.rows) == 2

    for row <- report.rows, key <- @mandated_row_keys do
      assert Map.has_key?(row, key), "row missing mandated metric #{key}"
    end
  end

  test "report echoes every C12 knob at top level and per row" do
    report = Reporter.run([100], :chide_encrypted_sort)

    for knob <- @knobs do
      assert Map.has_key?(report.knobs, knob), "report.knobs missing #{knob}"
    end

    for row <- report.rows, knob <- @knobs do
      assert Map.has_key?(row, knob), "row missing knob echo #{knob}"
    end
  end

  test "knob overrides flow into params, rows, and op counts" do
    report =
      Reporter.run([1_000], :chide_es_r255, %{
        trustees: 5,
        max_corrupt: 2,
        share_quorum: 3,
        candidates: 8,
        dummy_ratio: 0.5,
        revote_ratio: 0.0
      })

    assert report.knobs.trustees == 5
    assert report.knobs.max_corrupt == 2
    assert report.knobs.share_quorum == 3
    assert report.knobs.candidates == 8
    assert report.knobs.dummy_ratio == 0.5
    assert report.knobs.revote_ratio == 0.0

    [row] = report.rows
    assert row.trustees == 5
    assert row.share_quorum == 3
    assert row.dummy_ballots == 500
    assert row.revotes == 0
    # effective ballots = n * (1 + dummy + revote)
    assert row.effective_ballots == 1_500
  end

  test "defaults are preserved when no overrides are given" do
    params = CostModel.params(100)

    assert params.trustees == 3
    assert params.max_corrupt == 1
    assert params.share_quorum == 2
    assert params.candidates == 4
    assert params.dummy_ratio == 1.0
    assert params.revote_ratio == 0.1
  end

  test "unknown knobs are rejected loudly" do
    assert_raise ArgumentError, ~r/unknown cost-model knobs/, fn ->
      CostModel.params(100, %{pairing_count: 2})
    end
  end

  test "pinned variant charges zero pairings anywhere (pin §2: no pairing curve)" do
    counts = CostModel.op_counts(:chide_es_r255, CostModel.params(10_000, @pinned))

    for {phase, ops} <- counts do
      assert Map.get(ops, :pairing, 0) == 0,
             "phase #{phase} charges pairings; chide-es-r255-v1 has none"
    end

    # The legacy variants DO charge pairings — the distinction is the point.
    legacy = CostModel.op_counts(:chide_encrypted_sort, CostModel.params(10_000))
    assert legacy.ballot_verify.pairing > 0
  end

  test "pinned variant ballot verification is Sigma exponentiations scaling with candidates" do
    p4 =
      CostModel.op_counts(
        :chide_es_r255,
        CostModel.params(1_000, Map.put(@pinned, :candidates, 4))
      )

    p16 =
      CostModel.op_counts(
        :chide_es_r255,
        CostModel.params(1_000, Map.put(@pinned, :candidates, 16))
      )

    assert p16.ballot_verify.exp > p4.ballot_verify.exp
    # O(|choices|): 4c + 6 exps per ballot.
    m = 1_000 + 1_000 + 100
    assert p4.ballot_verify.exp == m * (4 * 4 + 6)
  end

  test "pinned variant cleansing stays O(m log m) in eq_test and exp" do
    counts = CostModel.op_counts(:chide_es_r255, CostModel.params(10_000, @pinned))
    m = round(10_000 * 2.1)
    logm = :math.log2(m) |> :math.ceil() |> trunc()

    assert counts.cleansing.eq_test == m * logm
    assert counts.cleansing.exp == 6 * m * logm
  end

  test "threshold pin check flags non-pinned committees" do
    assert CostModel.thresholds_match_pin?(CostModel.params(100, @pinned))
    refute CostModel.thresholds_match_pin?(CostModel.params(100))

    pinned_report = Reporter.run([100], :chide_es_r255, @pinned)
    assert pinned_report.thresholds_match_pin == true

    default_report = Reporter.run([100], :chide_es_r255)
    assert default_report.thresholds_match_pin == false

    # Legacy variants carry no pin check — they predate the pin.
    refute Map.has_key?(Reporter.run([100], :chide_encrypted_sort), :thresholds_match_pin)
  end

  test "report carries calibration status and it is honest about the variant" do
    report = Reporter.run([100], :chide_es_r255, @pinned)

    # With the ristretto255 NIF available this is :measured; without it the seam
    # must degrade to :uncalibrated and name the blocker. Both are honest; a
    # fabricated :measured is the §14/R7 failure this harness exists to prevent.
    case GroupOps.calibrate() do
      %{status: :measured, unit_seconds: units} ->
        assert report.calibration == :measured
        assert report.unit_seconds == units
        # Measured units must be real timings: positive and plausibly sub-second.
        assert units.exp > 0.0 and units.exp < 1.0
        assert units.point_add > 0.0 and units.point_add < units.exp
        assert report.calibration_raw.scalar_mult_seconds > 0.0

      %{status: :uncalibrated, notes: notes} ->
        assert report.calibration == :uncalibrated
        assert notes =~ "blocked"
    end
  end

  test "legacy pairing variants never present as measured" do
    for variant <- [:chide_quadratic, :chide_encrypted_sort] do
      report = Reporter.run([100], variant)
      assert report.calibration == :uncalibrated
    end
  end

  test "written report is valid JSON with calibration, knobs, and mandated row keys" do
    report = Reporter.run([100], :chide_es_r255, @pinned)

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

    for knob <- @knobs do
      assert Map.has_key?(decoded["knobs"], to_string(knob)), "JSON knobs missing #{knob}"
      assert Map.has_key?(row, to_string(knob)), "JSON row missing knob #{knob}"
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
