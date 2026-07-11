defmodule Township.AuditBundle do
  @moduledoc """
  Produces and verifies the outsider-replayable Township audit bundle.

  `matter.log` is the only trusted input. Every state, authority, and graph
  artifact is a deterministic projection of that log. Realm labels from the
  manifest are display metadata used only in delegation-graph node labels.
  """

  alias Jason.OrderedObject
  alias Lattice.Authority
  alias Lattice.Graph.{Export, ReplicaSnapshot}
  alias Lattice.{Identity, Log}
  alias Township.Matter

  @schema "township-audit-bundle-v1"
  @artifact_entries [
    %{"file" => "matter.log", "kind" => "authoritative_log"},
    %{"file" => "state.json", "kind" => "materialized_state"},
    %{"file" => "audit.json", "kind" => "authority_verdict"},
    %{"file" => "op_dag.json", "kind" => "causal_op_dag"},
    %{"file" => "trust_graph.dot", "kind" => "delegation_graph_dot"},
    %{"file" => "trust_graph.mermaid", "kind" => "delegation_graph_mermaid"},
    %{"file" => "manifest.json", "kind" => "display_manifest"}
  ]
  @files @artifact_entries |> Enum.map(& &1["file"]) |> Enum.sort()

  @type labels :: %{optional(String.t()) => String.t()}
  @type verify_error :: String.t()

  @doc "The exact files in a version-one Township audit bundle."
  @spec files() :: [String.t()]
  def files, do: @files

  @doc "Write a deterministic bundle rooted in `log` to `dir`."
  @spec write(String.t(), Log.t(), keyword()) :: {:ok, map()} | {:error, term()}
  def write(dir, %Log{} = log, opts \\ []) when is_binary(dir) do
    with {:ok, labels} <- normalize_labels(Keyword.get(opts, :labels, %{})),
         :ok <- File.mkdir_p(dir),
         :ok <- Log.dump(log, Path.join(dir, "matter.log")) do
      manifest = manifest(labels)
      projections = projections(log, labels, manifest)
      manifest_bytes = Map.fetch!(projections, "manifest.json")
      projection_files = Map.delete(projections, "manifest.json")

      case write_projections(dir, projection_files) do
        :ok ->
          case File.write(Path.join(dir, "manifest.json"), manifest_bytes) do
            :ok -> {:ok, manifest}
            {:error, _reason} = error -> error
          end

        {:error, _reason} = error ->
          error
      end
    end
  end

  @doc "Restore `matter.log`, re-derive every claim, and report mismatches."
  @spec verify(String.t()) :: :ok | {:error, [verify_error()]}
  def verify(dir) when is_binary(dir) do
    dir = Path.expand(dir)

    with {:ok, names} <- list_bundle(dir),
         :ok <- validate_file_set(names),
         {:ok, manifest_doc, manifest_bytes} <- read_manifest(dir),
         {:ok, labels} <- validate_manifest(manifest_doc),
         :ok <- preload_lattice_core(),
         {:ok, log} <- Log.restore(Path.join(dir, "matter.log")),
         {:ok, expected} <- rederive(log, labels) do
      expected = Map.put(expected, "manifest.json", json(manifest_doc))

      errors =
        expected
        |> Enum.flat_map(fn {file, bytes} ->
          case read_projection(dir, file, manifest_bytes) do
            {:ok, ^bytes} -> []
            {:ok, _other} -> ["#{file} mismatch"]
            {:error, reason} -> ["#{file} unreadable: #{:file.format_error(reason)}"]
          end
        end)
        |> Kernel.++(validate_label_fingerprints(log, labels))
        |> Enum.sort()

      if errors == [], do: :ok, else: {:error, errors}
    else
      {:error, errors} when is_list(errors) -> {:error, errors}
      {:error, reason} -> {:error, [format_error(reason)]}
    end
  end

  defp rederive(log, labels) do
    {:ok, projections(log, labels, manifest(labels))}
  rescue
    error -> {:error, "bundle replay failed: #{Exception.message(error)}"}
  end

  defp read_projection(_dir, "manifest.json", manifest_bytes), do: {:ok, manifest_bytes}
  defp read_projection(dir, file, _manifest_bytes), do: File.read(Path.join(dir, file))

  defp projections(log, labels, manifest_doc) do
    analysis = Authority.analyze(Matter, log)
    trust_graph = trust_graph_snapshot(log, labels)

    %{
      "state.json" => state_json(log),
      "audit.json" => audit_json(analysis),
      "op_dag.json" => Matter |> ReplicaSnapshot.build(log) |> json(),
      "trust_graph.dot" => Export.export(trust_graph, :dot) <> "\n",
      "trust_graph.mermaid" => Export.export(trust_graph, :mermaid) <> "\n",
      "manifest.json" => json(manifest_doc)
    }
  end

  defp state_json(log) do
    state = Lattice.state(Matter, log)

    json(%{
      "title" => state.title,
      "summary" => state.summary,
      "posts" => state.posts,
      "members" => Enum.sort(state.members),
      "clerk_locked" => state.clerk_locked?
    })
  end

  defp audit_json(analysis) do
    reasons =
      analysis.reasons
      |> Enum.sort_by(fn {id, _reason} -> id end)
      |> Enum.map(fn {id, reason} -> {id, Atom.to_string(reason)} end)
      |> OrderedObject.new()

    holders =
      analysis.holders
      |> Enum.sort_by(fn {role, _pub} -> Atom.to_string(role) end)
      |> Enum.map(fn {role, pub} -> {Atom.to_string(role), pub && Identity.fingerprint(pub)} end)
      |> OrderedObject.new()

    audit = Enum.map(analysis.audit, &ordered_audit_entry/1)

    OrderedObject.new([
      {"quarantine", analysis.quarantine |> MapSet.to_list() |> Enum.sort()},
      {"reasons", reasons},
      {"audit", audit},
      {"holders", holders}
    ])
    |> Jason.encode!(pretty: true)
    |> Kernel.<>("\n")
  end

  defp ordered_audit_entry(entry) do
    preferred = [:reason, :op, :event, :role]
    preferred_set = MapSet.new(preferred)

    ordered =
      preferred
      |> Enum.filter(&Map.has_key?(entry, &1))
      |> Enum.map(fn key -> {Atom.to_string(key), ordered_json(Map.fetch!(entry, key))} end)

    extras =
      entry
      |> Enum.reject(fn {key, _value} -> MapSet.member?(preferred_set, key) end)
      |> Enum.sort_by(fn {key, _value} -> to_string(key) end)
      |> Enum.map(fn {key, value} -> {to_string(key), ordered_json(value)} end)

    OrderedObject.new(ordered ++ extras)
  end

  defp trust_graph_snapshot(log, labels) do
    events = delegation_events(log)

    nodes =
      events
      |> Enum.flat_map(fn {_kind, delegation} -> [delegation.issuer, delegation.audience] end)
      |> Enum.uniq()
      |> Enum.map(fn pub ->
        fingerprint = Identity.fingerprint(pub)
        label = if name = labels[fingerprint], do: "#{name} #{fingerprint}", else: fingerprint
        %{id: fingerprint, kind: "realm", label: label}
      end)

    edges =
      Enum.map(events, fn {kind, delegation} ->
        %{
          from: Identity.fingerprint(delegation.issuer),
          to: Identity.fingerprint(delegation.audience),
          kind: delegation_edge_kind(kind, delegation)
        }
      end)

    %{nodes: nodes, edges: edges}
  end

  defp delegation_events(log) do
    log
    |> Log.topo_ops()
    |> Enum.filter(&(&1.kind == :authority))
    |> Enum.flat_map(fn op ->
      case op.body do
        {:genesis, delegation, _policies} -> [{"genesis", delegation}]
        {:grant, delegation} -> [{"grant", delegation}]
        {:transfer, role, delegation, _tick} -> [{"transfer:#{role}", delegation}]
        {:succeed, role, delegation, _tick} -> [{"succeed:#{role}", delegation}]
        _other -> []
      end
    end)
  end

  defp delegation_edge_kind(kind, delegation) do
    roles =
      if MapSet.size(delegation.roles) > 0 do
        " roles=[#{delegation.roles |> Enum.sort() |> Enum.join(",")}]"
      else
        ""
      end

    "#{kind}#{roles} ops=[#{delegation.ops |> Enum.sort() |> Enum.join(",")}]"
  end

  defp manifest(labels) do
    %{"schema" => @schema, "artifacts" => @artifact_entries, "labels" => labels}
  end

  defp write_projections(dir, projections) do
    Enum.reduce_while(projections, :ok, fn {file, bytes}, :ok ->
      case File.write(Path.join(dir, file), bytes) do
        :ok -> {:cont, :ok}
        {:error, _reason} = error -> {:halt, error}
      end
    end)
  end

  defp list_bundle(dir) do
    case File.ls(dir) do
      {:ok, names} -> {:ok, Enum.sort(names)}
      {:error, reason} -> {:error, "cannot list bundle: #{:file.format_error(reason)}"}
    end
  end

  defp validate_file_set(@files), do: :ok

  defp validate_file_set(names) do
    missing = @files -- names
    extra = names -- @files
    {:error, ["bundle file set mismatch missing=#{inspect(missing)} extra=#{inspect(extra)}"]}
  end

  defp read_manifest(dir) do
    path = Path.join(dir, "manifest.json")

    with {:ok, bytes} <- File.read(path),
         {:ok, document} <- Jason.decode(bytes) do
      {:ok, document, bytes}
    else
      {:error, reason} -> {:error, "manifest.json unreadable: #{inspect(reason)}"}
    end
  end

  defp validate_manifest(
         %{"schema" => @schema, "artifacts" => artifacts, "labels" => labels} = manifest
       )
       when map_size(manifest) == 3 and artifacts == @artifact_entries do
    normalize_labels(labels)
  end

  defp validate_manifest(_manifest), do: {:error, "manifest.json contract mismatch"}

  defp normalize_labels(labels) when is_map(labels) do
    if Enum.all?(labels, fn {fingerprint, label} ->
         is_binary(fingerprint) and valid_label?(label)
       end) do
      {:ok, Map.new(labels)}
    else
      {:error, "manifest labels must map fingerprint strings to display strings"}
    end
  end

  defp normalize_labels(_labels),
    do: {:error, "manifest labels must map fingerprint strings to display strings"}

  defp valid_label?(label) when is_binary(label) do
    label != "" and label == String.trim(label) and String.valid?(label) and
      byte_size(label) <= 80 and not String.match?(label, ~r/[\x00-\x1F\x7F]/u)
  end

  defp valid_label?(_label), do: false

  defp validate_label_fingerprints(log, labels) do
    known =
      log
      |> delegation_events()
      |> Enum.flat_map(fn {_kind, delegation} -> [delegation.issuer, delegation.audience] end)
      |> MapSet.new(&Identity.fingerprint/1)

    unknown = labels |> Map.keys() |> Enum.reject(&MapSet.member?(known, &1)) |> Enum.sort()

    if unknown == [],
      do: [],
      else: ["manifest.json labels unknown fingerprints #{inspect(unknown)}"]
  end

  defp preload_lattice_core do
    with :ok <- load_lattice_core() do
      :lattice_core
      |> Application.spec(:modules)
      |> List.wrap()
      |> Enum.each(&Code.ensure_loaded/1)

      :ok
    end
  end

  defp load_lattice_core do
    case Application.load(:lattice_core) do
      :ok -> :ok
      {:error, {:already_loaded, :lattice_core}} -> :ok
      {:error, reason} -> {:error, "cannot load lattice_core: #{inspect(reason)}"}
    end
  end

  defp json(value) do
    value
    |> ordered_json()
    |> Jason.encode!(pretty: true)
    |> Kernel.<>("\n")
  end

  defp ordered_json(%MapSet{} = set), do: set |> MapSet.to_list() |> Enum.sort() |> ordered_json()
  defp ordered_json(%_module{} = struct), do: struct |> Map.from_struct() |> ordered_json()

  defp ordered_json(map) when is_map(map) do
    map
    |> Enum.map(fn {key, value} -> {to_string(key), ordered_json(value)} end)
    |> Enum.sort_by(fn {key, _value} -> key end)
    |> OrderedObject.new()
  end

  defp ordered_json(list) when is_list(list), do: Enum.map(list, &ordered_json/1)
  defp ordered_json(tuple) when is_tuple(tuple), do: tuple |> Tuple.to_list() |> ordered_json()

  defp ordered_json(atom) when is_atom(atom) and atom not in [nil, true, false],
    do: Atom.to_string(atom)

  defp ordered_json(value), do: value

  defp format_error(reason) when is_binary(reason), do: reason
  defp format_error(reason), do: inspect(reason)
end
