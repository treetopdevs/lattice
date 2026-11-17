defmodule Mix.Tasks.Lattice.Township.ExplainDivergence do
  @moduledoc """
  Explain how two Township audit bundles differ.

      mix lattice.township.explain_divergence --a DIR_A --b DIR_B [--format text|json]

  Both bundles are loaded through `Township.AuditBundle.load_verified/1`, so a forged or
  inconsistent bundle is refused with its verification errors before any comparison.
  The first line is the verdict (`CONVERGED` or `DIVERGED`); only non-empty sections
  follow. Participant content is never printed, only sizes and hash prefixes (see
  `Township.Divergence`). `--format json` emits the same map as JSON.
  """

  use Mix.Task

  alias Township.{AuditBundle, Divergence}

  @shortdoc "Explain how two Township audit bundles diverge"
  @usage "usage: mix lattice.township.explain_divergence --a DIR_A --b DIR_B [--format text|json]"

  @impl Mix.Task
  def run(argv) do
    {opts, rest, invalid} =
      OptionParser.parse(argv, strict: [a: :string, b: :string, format: :string])

    format = Keyword.get(opts, :format, "text")

    case {opts[:a], opts[:b], rest, invalid} do
      {a, b, [], []} when is_binary(a) and a != "" and is_binary(b) and b != "" ->
        if format in ["text", "json"], do: explain(a, b, format), else: Mix.raise(@usage)

      _other ->
        Mix.raise(@usage)
    end
  end

  defp explain(dir_a, dir_b, format) do
    log_a = load!(dir_a)
    log_b = load!(dir_b)

    case Divergence.explain(log_a, log_b) do
      %{error: :different_replicas, a: ra, b: rb} ->
        Mix.raise("bundles are for different replicas: #{ra} vs #{rb}")

      report ->
        if format == "json" do
          Mix.shell().info(Jason.encode!(jsonable(report), pretty: true))
        else
          report |> render(log_a.replica) |> Enum.each(fn line -> Mix.shell().info(line) end)
        end
    end
  end

  defp load!(dir) do
    case AuditBundle.load_verified(dir) do
      {:ok, %{log: log}} ->
        log

      {:error, errors} ->
        Mix.raise(
          "Township audit bundle verification failed for #{dir}:\n- #{Enum.join(errors, "\n- ")}"
        )
    end
  end

  defp render(%{converged?: true}, replica), do: ["CONVERGED: replica #{replica}"]

  defp render(report, replica) do
    [verdict(report, replica)] ++
      list_line("only in A", report.only_in_a) ++
      list_line("only in B", report.only_in_b) ++
      Enum.map(report.state_mismatches, fn m ->
        "state mismatch :#{m.field}  a: #{describe(m.a)}  b: #{describe(m.b)}"
      end) ++
      Enum.map(report.quarantine_delta, fn d ->
        "authority quarantine #{d.op_id}  a: #{inspect(d.reason_a)}  b: #{inspect(d.reason_b)}"
      end) ++
      Enum.map(report.structural_delta, fn d ->
        "structural quarantine #{d.op_id}  a: #{inspect(d.reason_a)}  b: #{inspect(d.reason_b)}"
      end) ++
      Enum.map(report.holder_delta, fn d ->
        "holder :#{d.role}  a: #{d.a || "none"}  b: #{d.b || "none"}"
      end) ++
      ["frontier A: #{inspect(report.frontier_a)}  frontier B: #{inspect(report.frontier_b)}"]
  end

  defp verdict(report, replica) do
    parts =
      [
        {length(report.only_in_a), "op", " only in A"},
        {length(report.only_in_b), "op", " only in B"},
        {length(report.state_mismatches), "field", ""},
        {length(report.quarantine_delta), "authority quarantine difference", ""},
        {length(report.structural_delta), "structural quarantine difference", ""},
        {length(report.holder_delta), "role holder difference", ""}
      ]
      |> Enum.reject(fn {n, _noun, _suffix} -> n == 0 end)
      |> Enum.map(fn
        {n, "field" = noun, suffix} -> "state differs in #{plural(n, noun)}#{suffix}"
        {n, noun, suffix} -> "#{plural(n, noun)}#{suffix}"
      end)

    Enum.join(["DIVERGED: replica #{replica}" | parts], ", ")
  end

  defp plural(1, noun), do: "1 #{noun}"
  defp plural(n, noun), do: "#{n} #{noun}s"

  defp list_line(_label, []), do: []
  defp list_line(label, ids), do: ["#{label}: #{Enum.join(ids, " ")}"]

  defp describe(%{entries: n, sha256: sha}),
    do: "#{n} #{if n == 1, do: "entry", else: "entries"} (sha #{sha})"

  defp describe(%{len: n, sha256: sha}), do: "len #{n}, sha #{sha}"
  defp describe(%{value: value}), do: inspect(value)
  defp describe(%{sha256: sha}), do: "sha #{sha}"

  defp jsonable(%{} = map), do: Map.new(map, fn {k, v} -> {to_string(k), jsonable(v)} end)
  defp jsonable(list) when is_list(list), do: Enum.map(list, &jsonable/1)
  defp jsonable(value) when is_boolean(value) or is_nil(value), do: value
  defp jsonable(value) when is_atom(value), do: Atom.to_string(value)
  defp jsonable(value), do: value
end
