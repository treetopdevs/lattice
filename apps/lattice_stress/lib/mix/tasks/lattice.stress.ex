defmodule Mix.Tasks.Lattice.Stress do
  @moduledoc """
  Runs a repeatable adversarial load/soak harness against Lattice.

      mix lattice.stress --tabs 500 --caps 2000 --calls 50000 --bridges 1000

  The harness uses the real capability gateway with instrumented stress tabs and
  servers. It prints allow/deny counts, delivery counts, cleanup checks, latency
  percentiles, process count, memory, and audit totals.
  """

  use Mix.Task

  @shortdoc "Run the Lattice adversarial stress harness"

  @defaults [
    tabs: 100,
    caps: 400,
    calls: 5_000,
    bridges: 100,
    concurrency: System.schedulers_online() * 4
  ]

  @impl true
  def run(args) do
    Mix.Task.run("app.start")

    opts = parse_opts(args)
    Lattice.reset!()
    LatticeServer.DemoHub.reset()

    {:ok, probe} = LatticeStress.ProbeServer.start_link(name: :load_probe)
    tabs = connect_tabs(opts[:tabs])
    caps = grant_caps(tabs, probe, opts[:caps])
    bridge_caps = grant_bridges(tabs, opts[:bridges])

    start_metrics = runtime_metrics()
    {call_metrics, latencies} = run_calls(tabs, caps, bridge_caps, opts)

    Enum.each(tabs, fn {_pid, tab} -> Lattice.disconnect_tab(tab.id) end)
    Process.sleep(20)

    final_metrics = runtime_metrics()
    probe_stats = LatticeStress.ProbeServer.stats(probe)
    diagnostics = Lattice.diagnostics()

    active_caps = map_size(diagnostics.caps.active_caps)

    print_report(%{
      options: opts,
      calls: call_metrics,
      probe: probe_stats,
      latency_us: latency_summary(latencies),
      runtime_start: start_metrics,
      runtime_final: final_metrics,
      audit_count: diagnostics.audit_count,
      active_caps_after_cleanup: active_caps,
      connected_tabs_after_cleanup: MapSet.size(diagnostics.topology.connected_tab_ids)
    })

    if active_caps == 0 and diagnostics.topology.connected_tab_ids == MapSet.new() do
      :ok
    else
      Mix.raise("stress cleanup invariant failed")
    end
  end

  defp parse_opts(args) do
    {parsed, _rest, _invalid} =
      OptionParser.parse(args,
        strict: [
          tabs: :integer,
          caps: :integer,
          calls: :integer,
          bridges: :integer,
          concurrency: :integer
        ]
      )

    @defaults
    |> Keyword.merge(parsed)
    |> Keyword.update!(:tabs, &max(&1, 1))
    |> Keyword.update!(:caps, &max(&1, 1))
    |> Keyword.update!(:calls, &max(&1, 1))
    |> Keyword.update!(:bridges, &max(&1, 0))
    |> Keyword.update!(:concurrency, &max(&1, 1))
  end

  defp connect_tabs(count) do
    for index <- 1..count do
      {:ok, pid, tab} =
        LatticeStress.ProbeTab.connect(
          identity: %{stress_index: index},
          handlers: [relay: fn payload -> %{relayed: payload} end]
        )

      {pid, tab}
    end
  end

  defp grant_caps(tabs, probe, count) do
    for index <- 1..count do
      {_pid, tab} = Enum.at(tabs, rem(index - 1, length(tabs)))
      {:ok, cap} = Lattice.grant(tab.id, probe, [:call, :cast])
      {tab.id, cap}
    end
  end

  defp grant_bridges(_tabs, 0), do: []

  defp grant_bridges(tabs, count) when length(tabs) < 2 do
    _ = count
    []
  end

  defp grant_bridges(tabs, count) do
    for index <- 1..count, reduce: [] do
      acc ->
        {_from_pid, from_tab} = Enum.at(tabs, rem(index - 1, length(tabs)))
        {_to_pid, to_tab} = Enum.at(tabs, rem(index, length(tabs)))

        case Lattice.bridge(from_tab.id, to_tab.id, [:call], ttl: 60_000) do
          {:ok, cap} -> [{from_tab.id, cap} | acc]
          {:error, _reason} -> acc
        end
    end
  end

  defp run_calls(tabs, caps, bridge_caps, opts) do
    1..opts[:calls]
    |> Task.async_stream(
      fn index -> timed_call(index, tabs, caps, bridge_caps) end,
      max_concurrency: opts[:concurrency],
      timeout: 30_000,
      ordered: false
    )
    |> Enum.reduce({%{allowed: 0, denied: 0, errors: %{}}, []}, fn
      {:ok, {status, reason, latency}}, {metrics, latencies} ->
        metrics =
          case status do
            :allowed -> update_in(metrics.allowed, &(&1 + 1))
            :denied -> update_denied(metrics, reason)
          end

        {metrics, [latency | latencies]}

      {:exit, reason}, {metrics, latencies} ->
        {update_denied(metrics, {:task_exit, reason}), latencies}
    end)
  end

  defp timed_call(index, tabs, caps, bridge_caps) do
    started = System.monotonic_time(:microsecond)
    {status, reason} = call_kind(index, tabs, caps, bridge_caps)
    latency = System.monotonic_time(:microsecond) - started
    {status, reason, latency}
  end

  defp call_kind(index, tabs, caps, bridge_caps) do
    cond do
      rem(index, 23) == 0 ->
        {_pid, tab} = Enum.at(tabs, rem(index, length(tabs)))
        classify(Lattice.call(tab.id, "forged_" <> Integer.to_string(index), %{index: index}))

      rem(index, 17) == 0 and length(tabs) > 1 ->
        {owner_tab_id, cap} = Enum.at(caps, rem(index, length(caps)))
        {_pid, thief_tab} = Enum.find(tabs, fn {_pid, tab} -> tab.id != owner_tab_id end)
        classify(Lattice.call(thief_tab.id, cap, %{index: index, stolen: true}))

      rem(index, 11) == 0 and bridge_caps != [] ->
        {tab_id, cap} = Enum.at(bridge_caps, rem(index, length(bridge_caps)))
        classify(Lattice.call(tab_id, cap, %{op: :relay, index: index}))

      true ->
        {tab_id, cap} = Enum.at(caps, rem(index, length(caps)))
        classify(Lattice.call(tab_id, cap, %{index: index}))
    end
  end

  defp classify({:ok, _}), do: {:allowed, :ok}
  defp classify({:error, reason}), do: {:denied, reason}

  defp update_denied(metrics, reason) do
    metrics
    |> update_in([:denied], &(&1 + 1))
    |> update_in([:errors, reason], &((&1 || 0) + 1))
  end

  defp latency_summary([]), do: %{p50: 0, p95: 0, p99: 0, max: 0}

  defp latency_summary(latencies) do
    sorted = Enum.sort(latencies)

    %{
      p50: percentile(sorted, 0.50),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: List.last(sorted)
    }
  end

  defp percentile(sorted, fraction) do
    index = max(ceil(length(sorted) * fraction) - 1, 0)
    Enum.at(sorted, index)
  end

  defp runtime_metrics do
    %{
      process_count: :erlang.system_info(:process_count),
      total_memory: :erlang.memory(:total)
    }
  end

  defp print_report(report) do
    IO.puts("Lattice stress report")
    IO.puts("options: #{inspect(report.options)}")
    IO.puts("calls: #{inspect(report.calls)}")
    IO.puts("probe deliveries: #{inspect(Map.take(report.probe, [:call_count, :cast_count]))}")
    IO.puts("latency_us: #{inspect(report.latency_us)}")
    IO.puts("runtime_start: #{inspect(report.runtime_start)}")
    IO.puts("runtime_final: #{inspect(report.runtime_final)}")
    IO.puts("audit_count: #{report.audit_count}")
    IO.puts("active_caps_after_cleanup: #{report.active_caps_after_cleanup}")
    IO.puts("connected_tabs_after_cleanup: #{report.connected_tabs_after_cleanup}")
  end
end
