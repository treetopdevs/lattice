defmodule Lattice.FaultScenario.Evidence do
  @moduledoc """
  Writes and verifies the replayable evidence directory of one fault scenario
  (plan 203, step 1).

      <out>/<scenario>/
        evidence.json               # canonical key order, no timestamps
        logs/<prefix>.<realm>.log   # Lattice.Log.dump/2 of each final log
        trust_graph.<prefix>.dot    # one per log prefix, from its first realm's log

  `verify/2` trusts nothing in the directory. It checks the scenario, fault,
  invariant, modules, log names and check sources against the verifier-owned
  `Lattice.FaultScenario.spec/1` table; restores every log with
  `Lattice.Log.restore_verified/1` and binds it to the expected replica;
  recomputes `evidence.json` and every DOT file and requires byte equality. For
  scenarios the table marks `rerun`, it also re-runs the scenario from the
  recorded seed and requires the logs to match byte for byte, because authentic
  logs are not necessarily complete.
  """

  alias Jason.OrderedObject
  alias Lattice.{Authority, FaultScenario, Log}
  alias Lattice.Graph.ReplicaSnapshot

  @schema "lattice-fault-evidence-v1"

  @type check :: %{name: String.t(), source: FaultScenario.source(), ok: boolean()}
  @type verified :: %{
          scenario: String.t(),
          verdict: String.t(),
          checks: [check()],
          evidence: map()
        }

  @doc "The schema identifier written into every `evidence.json`."
  @spec schema() :: String.t()
  def schema, do: @schema

  @doc """
  Encode the evidence for `logs` without touching disk.

  Returns the `evidence.json` bytes and a map of DOT file name to bytes. `opts`
  may carry `:spec` to supply a table entry other than `FaultScenario.spec/1`.
  """
  @spec encode(String.t(), String.t(), FaultScenario.logs(), keyword()) ::
          {:ok, %{json: binary(), dot: %{String.t() => binary()}, verdict: String.t()}}
  def encode(name, seed, logs, opts \\ []) do
    spec = Keyword.get_lazy(opts, :spec, fn -> FaultScenario.spec(name) end)
    checks = Keyword.get_lazy(opts, :checks, fn -> FaultScenario.checks(name, seed, logs) end)
    sources = Map.new(spec.checks)
    verdict = if Enum.all?(checks, fn {_, ok} -> ok end), do: "held", else: "violated"

    json =
      OrderedObject.new([
        {"schema", @schema},
        {"scenario", name},
        {"seed", seed},
        {"module", sorted(spec.modules, &inspect/1)},
        {"fault", spec.fault},
        {"invariant", spec.invariant},
        {"replicas", replicas(spec, logs)},
        {"quarantine", quarantine(spec, logs)},
        {"checks",
         Enum.map(checks, fn {check, ok} ->
           OrderedObject.new([
             {"name", check},
             {"source", Atom.to_string(Map.fetch!(sources, check))},
             {"ok", ok}
           ])
         end)},
        {"verdict", verdict}
      ])

    {:ok,
     %{json: Jason.encode!(json, pretty: true) <> "\n", dot: dots(spec, logs), verdict: verdict}}
  end

  @doc "Write the evidence directory for `logs` at `dir`, replacing what is there."
  @spec write(Path.t(), String.t(), String.t(), FaultScenario.logs(), keyword()) ::
          {:ok, String.t()}
  def write(dir, name, seed, logs, opts \\ []) do
    {:ok, encoded} = encode(name, seed, logs, opts)
    File.rm_rf!(dir)
    File.mkdir_p!(Path.join(dir, "logs"))

    Enum.each(logs, fn {log_name, log} ->
      :ok = Log.dump(log, Path.join([dir, "logs", log_name <> ".log"]))
    end)

    Enum.each(encoded.dot, fn {file, bytes} -> File.write!(Path.join(dir, file), bytes) end)
    File.write!(Path.join(dir, "evidence.json"), encoded.json)
    {:ok, encoded.verdict}
  end

  @doc """
  Verify the evidence directory at `dir`.

  `opts[:spec_fun]` replaces the table lookup (tests use it for a synthetic
  process-sourced entry). Returns the verified checks with their table sources.
  """
  @spec verify(Path.t(), keyword()) :: {:ok, verified()} | {:error, [String.t()]}
  def verify(dir, opts \\ []) do
    spec_fun = Keyword.get(opts, :spec_fun, &FaultScenario.spec/1)

    with {:ok, bytes} <- read(dir, "evidence.json"),
         {:ok, evidence} <- decode(bytes),
         {:ok, name, seed} <- identify(evidence),
         {:ok, spec} <- lookup(spec_fun, name),
         :ok <- pinned(spec, evidence),
         {:ok, names} <- log_names(dir, spec),
         :ok <- load_modules(spec),
         {:ok, logs} <- restore(dir, names),
         :ok <- bound(spec, name, seed, logs),
         :ok <- recomputed(dir, bytes, name, seed, logs, spec),
         :ok <- rerun(dir, spec, name, seed, names) do
      {:ok,
       %{
         scenario: name,
         verdict: evidence["verdict"],
         evidence: evidence,
         checks:
           Enum.map(evidence["checks"], fn %{"name" => n, "ok" => ok} ->
             %{name: n, source: Map.new(spec.checks)[n], ok: ok}
           end)
       }}
    else
      {:error, reasons} when is_list(reasons) -> {:error, reasons}
      {:error, reason} -> {:error, [reason]}
    end
  end

  # --- Encoding --------------------------------------------------------------

  defp replicas(spec, logs) do
    logs
    |> Enum.sort_by(fn {name, _} -> name end)
    |> Enum.map(fn {name, log} ->
      {prefix, _realm} = FaultScenario.split_log_name(name)
      module = Map.fetch!(spec.modules, prefix)

      {name,
       OrderedObject.new([
         {"frontier", sha(log |> Log.frontier() |> Enum.sort() |> Enum.join("\n"))},
         {"state", sha(:erlang.term_to_binary(Lattice.state(module, log), [:deterministic]))}
       ])}
    end)
    |> OrderedObject.new()
  end

  defp quarantine(spec, logs) do
    reasons =
      Map.new(logs, fn {name, log} ->
        {prefix, _} = FaultScenario.split_log_name(name)
        {name, Authority.analyze(Map.fetch!(spec.modules, prefix), log).reasons}
      end)

    names = logs |> Map.keys() |> Enum.sort()

    for {prefix, _module} <- Enum.sort(spec.modules),
        group = Enum.filter(names, &String.starts_with?(&1, prefix <> ".")),
        op <- group |> Enum.flat_map(&Map.keys(reasons[&1])) |> Enum.uniq() |> Enum.sort() do
      OrderedObject.new([
        {"op", op},
        {"reasons",
         OrderedObject.new(for(n <- group, do: {n, reason_text(Map.get(reasons[n], op))}))}
      ])
    end
  end

  defp reason_text(nil), do: "none"
  defp reason_text(reason), do: Atom.to_string(reason)

  defp dots(spec, logs) do
    first = hd(spec.realms)

    Map.new(spec.modules, fn {prefix, module} ->
      log = Map.fetch!(logs, "#{prefix}.#{first}")
      dot = module |> ReplicaSnapshot.build(log) |> ReplicaSnapshot.export(:dot)
      {"trust_graph.#{prefix}.dot", dot <> "\n"}
    end)
  end

  defp sorted(map, fun),
    do: map |> Enum.sort() |> Enum.map(fn {k, v} -> {k, fun.(v)} end) |> OrderedObject.new()

  defp sha(bytes), do: :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)

  # --- Verification ----------------------------------------------------------

  defp read(dir, file) do
    case File.read(Path.join(dir, file)) do
      {:ok, bytes} -> {:ok, bytes}
      {:error, _} -> {:error, "#{file} is missing or unreadable"}
    end
  end

  defp decode(bytes) do
    case Jason.decode(bytes) do
      {:ok, %{} = evidence} -> {:ok, evidence}
      _ -> {:error, "evidence.json is not a JSON object"}
    end
  end

  defp identify(%{"schema" => @schema, "scenario" => name, "seed" => seed})
       when is_binary(name) and is_binary(seed),
       do: {:ok, name, seed}

  defp identify(_), do: {:error, "evidence.json has no #{@schema} scenario and seed"}

  defp lookup(spec_fun, name) do
    case spec_fun.(name) do
      %{} = spec -> {:ok, spec}
      nil -> {:error, "unknown scenario #{inspect(name)}"}
    end
  end

  defp pinned(spec, evidence) do
    expected_modules = Map.new(spec.modules, fn {prefix, mod} -> {prefix, inspect(mod)} end)

    expected_checks =
      Enum.map(spec.checks, fn {name, source} -> {name, Atom.to_string(source)} end)

    # A malformed row is kept as a mismatch, never filtered out (no new atom: row 190
    # requires the plan 185 vector atoms, `malformed` among them, stay absent from lib).
    given_checks =
      Enum.map(List.wrap(evidence["checks"]), fn
        %{"name" => name, "source" => source, "ok" => ok} when is_boolean(ok) -> {name, source}
        malformed -> {nil, malformed}
      end)

    errors =
      [
        {evidence["fault"] == spec.fault, "fault text differs from the verifier table"},
        {evidence["invariant"] == spec.invariant,
         "invariant text differs from the verifier table"},
        {evidence["module"] == expected_modules, "modules differ from the verifier table"},
        {given_checks == expected_checks, "check names or sources differ from the verifier table"}
      ]
      |> Enum.reject(&elem(&1, 0))
      |> Enum.map(&elem(&1, 1))

    if errors == [], do: :ok, else: {:error, errors}
  end

  defp log_names(dir, spec) do
    expected =
      for prefix <- Map.keys(spec.modules), realm <- spec.realms, into: MapSet.new() do
        "#{prefix}.#{realm}"
      end

    found =
      dir
      |> Path.join("logs")
      |> File.ls()
      |> case do
        {:ok, files} -> MapSet.new(files, &Path.rootname/1)
        {:error, _} -> MapSet.new()
      end

    extra_files =
      case File.ls(Path.join(dir, "logs")) do
        {:ok, files} -> Enum.reject(files, &String.ends_with?(&1, ".log"))
        _ -> []
      end

    if found == expected and extra_files == [],
      do: {:ok, Enum.sort(expected)},
      else: {:error, "log files #{inspect(Enum.sort(found))} differ from the verifier table"}
  end

  # `restore_verified/1` decodes with `:safe`, which refuses atoms the VM has not
  # interned; a replica module's command names are interned only once it is loaded.
  defp load_modules(spec) do
    Enum.each(spec.modules, fn {_prefix, module} -> Code.ensure_loaded!(module) end)
  end

  defp restore(dir, names) do
    Enum.reduce_while(names, {:ok, %{}}, fn name, {:ok, acc} ->
      case Log.restore_verified(Path.join([dir, "logs", name <> ".log"])) do
        {:ok, %{log: log}} ->
          {:cont, {:ok, Map.put(acc, name, log)}}

        {:error, reason} ->
          {:halt, {:error, "#{name}.log failed verification: #{inspect(reason)}"}}
      end
    end)
  end

  # Every log must be bound to a replica the table derives from the seed, re-runnable or
  # not; an entry that cannot name its replicas fails closed.
  defp bound(spec, name, seed, logs) do
    expected =
      cond do
        spec.rerun -> FaultScenario.expected_replicas(name, seed)
        is_function(spec[:replicas], 1) -> spec.replicas.(seed)
        true -> nil
      end

    if is_map(expected) do
      mismatched =
        for {log_name, log} <- logs,
            {prefix, _} = FaultScenario.split_log_name(log_name),
            log.replica != Map.get(expected, prefix),
            do: log_name

      if mismatched == [],
        do: :ok,
        else:
          {:error,
           "logs bound to an unexpected replica: #{Enum.join(Enum.sort(mismatched), ", ")}"}
    else
      {:error, "the verifier table names no expected replicas for #{name}"}
    end
  end

  defp recomputed(dir, bytes, name, seed, logs, spec) do
    with {:ok, encode_opts} <- encode_opts(dir, spec, seed, logs) do
      {:ok, encoded} = encode(name, seed, logs, encode_opts)
      compare(dir, bytes, encoded)
    end
  end

  defp encode_opts(_dir, %{rerun: true} = spec, _seed, _logs), do: {:ok, [spec: spec]}

  # A non-re-runnable entry re-derives its replay checks through the table's own function
  # and copies only its process checks from the evidence.
  defp encode_opts(dir, spec, seed, logs) do
    replay? = Enum.any?(spec.checks, &match?({_, :replay}, &1))

    if replay? and not is_function(spec[:replay_checks], 2) do
      {:error, "the verifier table cannot re-derive the replay checks of #{spec.scenario}"}
    else
      derived = if replay?, do: Map.new(spec.replay_checks.(seed, logs)), else: %{}
      recorded = recorded_checks(dir)

      checks =
        Enum.map(spec.checks, fn
          {check, :replay} -> {check, Map.get(derived, check, false)}
          {check, :process} -> {check, Map.get(recorded, check, false)}
        end)

      {:ok, [spec: spec, checks: checks]}
    end
  end

  defp compare(dir, bytes, encoded) do
    expected_files =
      MapSet.new(["evidence.json", "logs" | Map.keys(encoded.dot)])

    actual_files = dir |> File.ls!() |> MapSet.new()

    dot_errors =
      for {file, dot} <- encoded.dot,
          File.read(Path.join(dir, file)) != {:ok, dot},
          do: "#{file} differs from the DOT regenerated from the verified logs"

    errors =
      [
        {encoded.json == bytes,
         "evidence.json differs from the evidence recomputed from the logs"},
        {actual_files == expected_files,
         "directory holds #{inspect(Enum.sort(actual_files))}, expected #{inspect(Enum.sort(expected_files))}"}
      ]
      |> Enum.reject(&elem(&1, 0))
      |> Enum.map(&elem(&1, 1))

    if errors ++ dot_errors == [], do: :ok, else: {:error, errors ++ dot_errors}
  end

  # Process-sourced checks cannot be re-derived offline; they are copied as recorded.
  defp recorded_checks(dir) do
    {:ok, evidence} = dir |> Path.join("evidence.json") |> File.read!() |> Jason.decode()
    Map.new(evidence["checks"], &{&1["name"], &1["ok"] == true})
  end

  defp rerun(_dir, %{rerun: false}, _name, _seed, _names), do: :ok

  defp rerun(dir, _spec, name, seed, names) do
    {:ok, logs} = FaultScenario.run(name, seed)

    # Unique across OS processes; `mkdir` (not `mkdir_p`) refuses a pre-existing path.
    suffix = Base.url_encode64(:crypto.strong_rand_bytes(12), padding: false)
    tmp = Path.join(System.tmp_dir!(), "lattice-fault-rerun-#{System.pid()}-#{suffix}")
    :ok = File.mkdir(tmp)

    try do
      mismatched =
        Enum.reject(names, fn log_name ->
          path = Path.join(tmp, log_name <> ".log")

          Map.has_key?(logs, log_name) and Log.dump(logs[log_name], path) == :ok and
            File.read!(path) == File.read!(Path.join([dir, "logs", log_name <> ".log"]))
        end)

      if mismatched == [],
        do: :ok,
        else:
          {:error,
           "seeded re-run of #{name} (seed #{inspect(seed)}) does not reproduce " <>
             Enum.join(mismatched, ", ")}
    after
      File.rm_rf!(tmp)
    end
  end
end
