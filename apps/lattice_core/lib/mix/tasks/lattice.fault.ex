defmodule Mix.Tasks.Lattice.Fault do
  @moduledoc """
  Run, verify and report scripted fault scenarios (plan 203).

      mix lattice.fault run revoke_offline --seed demo --out /tmp/fault
      mix lattice.fault run all --seed demo --out /tmp/fault
      mix lattice.fault verify /tmp/fault/revoke_offline
      mix lattice.fault report /tmp/fault

  `run` writes one evidence directory per scenario under `--out` (`all` runs every
  scenario, then writes the report). `verify` re-derives a directory and re-runs
  its seeded scenario. `report` writes `index.html` for every directory under the
  given path. Use absolute paths: an umbrella-root run executes in the app directory.
  """

  use Mix.Task

  alias Lattice.FaultScenario
  alias Lattice.FaultScenario.{Evidence, Report}

  @shortdoc "Run, verify and report scripted fault scenarios"

  @impl Mix.Task
  def run(argv) do
    Mix.Task.run("app.config")
    {opts, args, invalid} = OptionParser.parse(argv, strict: [seed: :string, out: :string])

    case {args, invalid} do
      {["run", scenario], []} -> run_scenarios(scenario, opts)
      {["verify", dir], []} -> verify(dir)
      {["report", dir], []} -> report(dir)
      _other -> Mix.raise(usage())
    end
  end

  defp run_scenarios(scenario, opts) do
    out = opts[:out] || Mix.raise(usage())
    seed = opts[:seed] || "demo"

    names =
      cond do
        scenario == "all" ->
          FaultScenario.scenarios()

        scenario in FaultScenario.scenarios() ->
          [scenario]

        true ->
          Mix.raise(
            "unknown scenario #{inspect(scenario)}; known: all, " <>
              Enum.join(FaultScenario.scenarios(), ", ")
          )
      end

    Enum.each(names, fn name ->
      {:ok, logs} = FaultScenario.run(name, seed)
      dir = Path.join(out, name)
      {:ok, verdict} = Evidence.write(dir, name, seed, logs)
      Mix.shell().info("#{name}: #{verdict} -> #{dir}")
    end)

    if scenario == "all", do: report(out)
  end

  defp verify(dir) do
    case Evidence.verify(dir) do
      {:ok, %{scenario: name, verdict: verdict, checks: checks}} ->
        recorded = Enum.count(checks, &(&1.source == :process))

        note =
          if recorded > 0,
            do: "; #{recorded} process check(s) recorded, not re-derived",
            else: ""

        Mix.shell().info("#{name}: verified, verdict #{verdict}#{note}")

      {:error, reasons} ->
        Mix.raise("verification failed for #{dir}:\n- " <> Enum.join(reasons, "\n- "))
    end
  end

  defp report(dir) do
    {:ok, path, entries} = Report.write(dir)
    failed = Enum.count(entries, &match?({:error, _}, &1.result))
    Mix.shell().info("report: #{path} (#{length(entries)} card(s), #{failed} unverified)")
  end

  defp usage do
    "usage: mix lattice.fault run <scenario|all> --out DIR [--seed SEED] | " <>
      "mix lattice.fault verify DIR | mix lattice.fault report DIR"
  end
end
