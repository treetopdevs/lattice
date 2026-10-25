defmodule LatticeCarrierServer.Operator.Lock do
  @moduledoc """
  Private client of the Linux Python3 mutation owner.

  Python's standard-library helper owns flock and every filesystem write through
  fsync and reopen. BEAM callbacks only inspect staged bytes; keeper death cannot
  leave a BEAM rename running after lock release. Missing Python3/helper refuses.
  The helper must be deployed with the operator checkout; no release installation
  or supported-host availability is asserted by this primitive.
  """
  alias LatticeCarrierServer.Operator.{CatalogStore, Journal}
  alias Treehouse.TransportCatalog
  @helper Path.expand("../../../../../scripts/treehouse_operator_mutation.py", __DIR__)
  @external_resource @helper
  @timeout 10_000

  @spec commit(Path.t(), binary() | nil, binary()) :: :ok | {:error, term()}
  def commit(root, expected, record) do
    run(root, plan("journal", expected, record, nil, nil, nil), nil)
  end

  @spec stage(Path.t(), binary() | nil, binary(), [map()], [map()], (-> term())) :: term()
  def stage(root, expected, attempt, checks, artifacts, inspect_staged) do
    run(root, plan("stage", expected, nil, attempt, checks, artifacts), inspect_staged)
  end

  @doc """
  Replace the checked active manifest with the pending record's staged
  candidate, while every sealed log still holds its checked bytes and only
  while `incarnation` is still the latest controlled boot's.
  """
  @spec activate(Path.t(), binary(), binary(), map(), [map()], binary(), String.t()) ::
          :ok | {:error, term()}
  def activate(root, expected, attempt, active_manifest, logs, record, incarnation) do
    plan = plan("activate", expected, record, attempt, [active_manifest | logs], nil)
    run(root, %{plan | incarnation: incarnation}, nil)
  end

  @doc """
  Record the `activated` journal as `ready`, only while `active_manifest` still
  holds the activated candidate's bytes and `incarnation` is still the latest
  controlled boot's. The BEAM proves the local facts before calling this.
  """
  @spec ready(Path.t(), binary(), map(), binary(), String.t()) :: :ok | {:error, term()}
  def ready(root, expected, active_manifest, record, incarnation) do
    with {:ok, %{"attempt" => attempt}} <- Journal.decode(expected) do
      plan = plan("ready", expected, record, attempt, [active_manifest], nil)
      run(root, %{plan | incarnation: incarnation}, nil)
    end
  end

  @doc """
  Record the `ready` journal as `catalogued`: the owner writes the signed
  catalog envelope into its store, then commits `record`, only while
  `active_manifest` still holds the activated bytes and `incarnation` is current.
  """
  @spec catalogued(Path.t(), binary(), map(), binary(), String.t(), binary()) ::
          :ok | {:error, term()}
  def catalogued(root, expected, active_manifest, record, incarnation, envelope_bytes) do
    with {:ok, %{"attempt" => attempt}} <- Journal.decode(expected),
         :ok <- catalog_artifact(root, record, envelope_bytes) do
      artifacts = [
        %{sha256: Journal.digest(envelope_bytes), bytes: Base.encode64(envelope_bytes)}
      ]

      plan = plan("catalogued", expected, record, attempt, [active_manifest], artifacts)
      run(root, %{plan | incarnation: incarnation}, nil)
    end
  end

  # The record must hold exactly one catalog artifact naming these bytes.
  defp catalog_artifact(root, record, bytes) do
    sha = Journal.digest(bytes)

    with {:ok, %{catalog: catalog}} <- TransportCatalog.decode_catalog_json(bytes),
         {:ok, decoded} <- Journal.decode(record),
         [%{"op_id" => id, "sha256" => ^sha, "path" => path, "replica" => replica}] <-
           Enum.filter(decoded["artifacts"], &(&1["kind"] == "catalog")),
         true <- id == TransportCatalog.catalog_id(catalog),
         true <- replica == catalog.space,
         true <- path == CatalogStore.file_path(root, sha),
         true <- extends_head?(root, catalog, sha) do
      :ok
    else
      _ -> {:error, :catalog_artifact_mismatch}
    end
  end

  # The owner cannot decode envelopes, so the chain rule is enforced here: the
  # store has no other pending envelope and this one is the committed head's
  # next revision (revision 0 with no head).
  defp extends_head?(root, catalog, sha) do
    case CatalogStore.verify(root, nil) do
      {:ok, %{head: head, head_revision: revision, pending: pending}} ->
        (pending == nil or pending.sha256 == sha) and catalog.previous == head and
          catalog.revision == if(revision == nil, do: 0, else: revision + 1)

      _ ->
        false
    end
  end

  @doc """
  Record the `catalogued` journal as `listed`, with the same checks as `ready`.
  An exact already-listed retry repeats the locked checks without another receipt.
  """
  @spec listed(Path.t(), binary(), map(), binary(), String.t()) :: :ok | {:error, term()}
  def listed(root, expected, active_manifest, record, incarnation) do
    with {:ok, %{"attempt" => attempt}} <- Journal.decode(expected) do
      plan = plan("listed", expected, record, attempt, [active_manifest], nil)
      run(root, %{plan | incarnation: incarnation}, nil)
    end
  end

  @doc """
  The controlled boot's step under the operator lock, after the manifest at
  `manifest_path` was loaded with lowercase-hex digest `loaded` and before any
  route starts: refuses while another plan holds the lock, reconciles the
  journal with the loaded bytes, and returns the new incarnation marker.
  """
  @spec boot(Path.t(), Path.t(), String.t()) :: {:ok, String.t()} | {:error, term()}
  def boot(root, manifest_path, loaded) do
    run(root, plan("boot", nil, nil, nil, [%{path: manifest_path, sha256: loaded}], nil), nil)
  end

  defp plan(kind, expected, record, attempt, checks, artifacts) do
    %{
      version: 1,
      kind: kind,
      expected: expected,
      record: record,
      attempt: attempt,
      checks: checks,
      artifacts: artifacts,
      incarnation: nil
    }
  end

  defp run(root, plan, inspect_staged) do
    with true <- :os.type() == {:unix, :linux},
         python when is_binary(python) <- System.find_executable("python3"),
         true <- File.regular?(@helper) do
      port =
        Port.open({:spawn_executable, python}, [
          :binary,
          :exit_status,
          :stderr_to_stdout,
          {:line, 1024},
          args: [@helper, Path.expand(root)]
        ])

      try do
        true = Port.command(port, Jason.encode!(plan) <> "\n")

        case response(port) do
          {:ok, %{"staged" => true}} when is_function(inspect_staged, 0) ->
            case inspect_staged.() do
              {:ok, record} ->
                commit = Journal.encode(record)
                true = Port.command(port, Jason.encode!(%{commit: commit}) <> "\n")
                with :ok <- completed(port), do: {:ok, record}

              {:error, _} = error ->
                error
            end

          {:ok, %{"ok" => true}} ->
            exited(port)

          {:ok, %{"incarnation" => incarnation}} ->
            with :ok <- exited(port), do: {:ok, incarnation}

          {:error, _} = error ->
            error

          _ ->
            {:error, :invalid_operator_response}
        end
      after
        close(port)
      end
    else
      _ -> {:error, :unsupported_operator_platform}
    end
  rescue
    _ -> {:error, :operator_mutation_failed}
  catch
    :exit, _ -> {:error, :operator_mutation_failed}
  end

  defp completed(port) do
    case response(port) do
      {:ok, %{"ok" => true}} -> exited(port)
      {:error, _} = error -> error
      _ -> {:error, :invalid_operator_response}
    end
  end

  defp response(port) do
    receive do
      {^port, {:data, {:eol, bytes}}} ->
        case Jason.decode(bytes) do
          {:ok, %{"error" => reason} = value} when map_size(value) == 1 and is_binary(reason) ->
            {:error, {:operator_refused, reason}}

          {:ok, value} when value in [%{"ok" => true}, %{"staged" => true}] ->
            {:ok, value}

          {:ok, %{"incarnation" => <<_::binary-size(64)>> = marker} = value}
          when map_size(value) == 1 ->
            if marker =~ ~r/\A[0-9a-f]{64}\z/,
              do: {:ok, value},
              else: {:error, :invalid_operator_response}

          _ ->
            {:error, :invalid_operator_response}
        end

      {^port, {:exit_status, _}} ->
        {:error, :operator_mutation_failed}

      {^port, {:data, _}} ->
        {:error, :invalid_operator_response}
    after
      @timeout -> {:error, :operator_mutation_timeout}
    end
  end

  defp exited(port) do
    receive do
      {^port, {:exit_status, 0}} -> :ok
      {^port, {:exit_status, _}} -> {:error, :operator_mutation_failed}
    after
      @timeout -> {:error, :operator_mutation_timeout}
    end
  end

  defp close(port) do
    if Port.info(port) != nil, do: Port.close(port)
    :ok
  rescue
    ArgumentError -> :ok
  end
end
