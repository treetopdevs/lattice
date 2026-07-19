defmodule Mix.Tasks.Township.Bench.G13 do
  @shortdoc "Run the G13 coercion-resistance cost harness (reference-algorithm simulation)"
  @moduledoc """
  G13 measurement harness.

      mix township.bench.g13
      mix township.bench.g13 --variant chide_quadratic
      mix township.bench.g13 --scales 100,1000,10000 --json
      mix township.bench.g13 --variant chide_es_r255 \\
        --trustees 5 --max-corrupt 2 --share-quorum 3 --json

  Prices the candidate construction's DOMINANT cost against its reference algorithms
  in single-process simulation, per §13 step 5 of the ZK findings doc. Runs before any
  role runner exists; emits the metric set gate 13 mandates. Makes no claim, flips no
  SecurityProfile value, touches neither Township.Matter nor Lattice.Attestation.

  ## Variants

    * `chide_encrypted_sort` (default) / `chide_quadratic` — legacy pre-pin models.
    * `chide_es_r255` — the G2-pinned profile `chide-es-r255-v1`
      (docs/research/m4_g2_profile_pin.md): Sigma-verified ballots (no pairings),
      O(m log m) encrypted-sort cleansing, priced with measured ristretto255 units
      when the calibration NIF is available.

  ## Knobs (review finding C12 — all echoed in every report)

    * `--trustees N` (default 3; pinned profile uses 5)
    * `--max-corrupt T` (default 1; pinned profile uses 2)
    * `--share-quorum Q` (default 2; pinned profile uses 3)
    * `--candidates C` (default 4; pinned bound is ≤16)
    * `--dummy-ratio F` (default 1.0 — open-posting cover traffic)
    * `--revote-ratio F` (default 0.1 — duplicate submissions the remove-all
      cleansing must strike; v1 offers no revote UX but duplicates still cost)
  """
  use Mix.Task

  alias TownshipBench.Reporter

  @impl Mix.Task
  def run(argv) do
    {opts, _, invalid} =
      OptionParser.parse(argv,
        strict: [
          variant: :string,
          scales: :string,
          json: :boolean,
          trustees: :integer,
          max_corrupt: :integer,
          share_quorum: :integer,
          candidates: :integer,
          dummy_ratio: :float,
          revote_ratio: :float
        ]
      )

    if invalid != [], do: Mix.raise("invalid options: #{inspect(invalid)}")

    variant =
      case opts[:variant] do
        "chide_quadratic" -> :chide_quadratic
        "chide_es_r255" -> :chide_es_r255
        _ -> :chide_encrypted_sort
      end

    scales =
      case opts[:scales] do
        nil -> [100, 1_000, 10_000]
        s -> s |> String.split(",") |> Enum.map(&String.to_integer/1)
      end

    overrides =
      opts
      |> Keyword.take([
        :trustees,
        :max_corrupt,
        :share_quorum,
        :candidates,
        :dummy_ratio,
        :revote_ratio
      ])
      |> Map.new()

    report = Reporter.run(scales, variant, overrides)
    IO.puts(Reporter.human(report))

    if Map.get(report, :thresholds_match_pin) == false do
      IO.puts(
        "  ⚠ committee is not the pinned n=5, t=2, q=3 of chide-es-r255-v1 " <>
          "(m4_g2_profile_pin.md §3); this run does not price the pinned committee."
      )
    end

    if opts[:json], do: Reporter.write_json(report)
  end
end
