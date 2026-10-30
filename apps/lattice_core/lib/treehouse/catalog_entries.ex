defmodule Treehouse.CatalogEntries do
  @moduledoc """
  Authenticated observations of the actual history named by a transport catalog.

  Every supplied log is checked, including evidence unrelated to a missing entry.
  The result binds entries to honored creation/reference operations and the exact
  honored bootstrap. It establishes no trusted catalog signer, installed pin,
  usable route, membership permission, or completeness of unseen history.

  This catalog profile requires the exact bounded-continuation Space/Thread
  family. Legacy root-only preview replicas are not converted or admitted here.
  """

  alias Lattice.{Authority, Dag, Log, Op}
  alias Lattice.Authority.{Continuation, Delegation}
  alias Treehouse.{CatalogBootstrap, CatalogCutoff, Space, Thread, TransportCatalog}

  @type refusal ::
          :malformed_catalog
          | :invalid_verified_history
          | :unsupported_cutoff
          | :trust_pending
          | :invalid_catalog_transition

  @spec observe(term(), term()) :: {:ok, map()} | {:error, refusal()}
  def observe(catalog, histories) do
    case observe_with_detail(catalog, histories) do
      {:error, reason, _refused} -> {:error, reason}
      result -> result
    end
  end

  @doc "Observed refusal IDs for the source trust owner; no catalog signer or route is established."
  @spec observe_with_detail(term(), term()) ::
          {:ok, map()} | {:error, refusal(), [binary()]}
  def observe_with_detail(catalog, histories) do
    with {:ok, catalog} <- TransportCatalog.normalize_catalog(catalog),
         :ok <- authenticate_histories(histories),
         {:ok, space_log} <- fetch(histories, catalog.space),
         {:ok, bootstrap} <- bootstrap(space_log, catalog.bootstrap),
         :ok <- verify_entries(catalog.entries, histories, space_log, bootstrap.record) do
      {:ok, %{entries: catalog.entries, bootstrap: bootstrap}}
    else
      {:error, reason} -> {:error, reason, []}
      {:error, reason, refused} -> {:error, reason, refused}
    end
  end

  defp authenticate_histories(histories) when is_map(histories) do
    # Authenticate the entire supplied set before either portability or pending
    # classification can mask an independently detectable forgery.
    if Enum.all?(histories, &authentic_history?/1) do
      histories
      |> Enum.map(fn {_replica, log} ->
        case CatalogCutoff.derive(log) do
          {:ok, _} -> :ok
          error -> error
        end
      end)
      |> result()
    else
      {:error, :invalid_verified_history}
    end
  end

  defp authenticate_histories(_), do: {:error, :invalid_verified_history}

  defp authentic_history?({replica, %Log{replica: replica} = log}),
    do: Log.verify_authenticity(log) == :ok

  defp authentic_history?(_), do: false

  defp bootstrap(log, id) do
    with {:ok, _op} <- fetch(Log.ops(log), id),
         {:ok, observed} <- CatalogBootstrap.observe(log) do
      case Enum.find(observed.bootstraps, &(&1.id == id)) do
        nil -> {:error, :invalid_catalog_transition}
        bootstrap -> {:ok, bootstrap}
      end
    end
  end

  @doc "Structural completeness for frozen diagnostics; this status cannot authorize a route."
  @spec structure_status(term(), term()) :: :complete | :pending | :invalid
  def structure_status(catalog, histories) do
    with {:ok, catalog} <- TransportCatalog.normalize_catalog(catalog),
         :ok <- authenticate_histories(histories),
         {:ok, space_log} <- fetch(histories, catalog.space),
         {:ok, bootstrap} <- structural_bootstrap(space_log, catalog.bootstrap) do
      case catalog.entries
           |> entry_facts(histories, space_log, bootstrap.record)
           |> Enum.map(& &1.result)
           |> result() do
        :ok -> :complete
        {:error, :trust_pending} -> :pending
        _ -> :invalid
      end
    else
      {:error, :trust_pending} -> :pending
      _ -> :invalid
    end
  end

  defp structural_bootstrap(log, id) do
    with {:ok, %Op{kind: :command, body: {:catalog_bootstrap_v1, [record]}}} <-
           fetch(Log.ops(log), id),
         {:ok, record} <- TransportCatalog.normalize_bootstrap(record) do
      {:ok, %{id: id, record: record}}
    else
      {:error, :trust_pending} -> {:error, :trust_pending}
      _ -> {:error, :invalid_catalog_transition}
    end
  end

  defp verify_entries(entries, histories, space_log, record) do
    entries
    |> entry_facts(histories, space_log, record)
    |> Enum.map(fn %{result: result, refused: refused} ->
      case {result, refused} do
        {_, [_ | _]} -> {:error, :invalid_catalog_transition, refused}
        {:ok, []} -> :ok
        {{:error, reason}, []} -> {:error, reason, []}
      end
    end)
    |> entry_result()
  end

  defp entry_facts(entries, histories, space_log, record) do
    space_analysis = Authority.analyze(Space, space_log)
    Enum.map(entries, &entry_fact(&1, histories, space_log, space_analysis, record))
  end

  defp entry_fact(entry, histories, space_log, space_analysis, record) do
    with true <- Continuation.family(entry.replica) == {:bounded, entry.kind},
         true <- entry.service_id == record.service_id and entry.service_key == record.service_key,
         {:ok, log} <- fetch(histories, entry.replica) do
      # Keep structural validity, missing evidence and current policy refusal
      # separate. Frozen diagnostics consume structure without granting eligibility.
      analysis = if entry.kind == :space, do: space_analysis, else: Authority.analyze(Thread, log)
      root = Authority.root(log)
      ops = Log.ops(log)

      checks = [
        if(root == entry.root, do: :ok, else: {:error, :invalid_catalog_transition}),
        check_known(ops, entry.genesis, &valid_genesis?(&1, entry, log, root)),
        check_known(ops, entry.creation, &valid_creation?(&1, entry, log)),
        reference(entry, space_log, record)
      ]

      %{
        result: result(checks),
        refused: refused_targets(entry, log, analysis, space_log, space_analysis)
      }
    else
      false -> %{result: {:error, :invalid_catalog_transition}, refused: []}
      {:error, reason} -> %{result: {:error, reason}, refused: []}
    end
  end

  defp check_known(ops, id, valid?) do
    with {:ok, op} <- fetch(ops, id) do
      if valid?.(op), do: :ok, else: {:error, :invalid_catalog_transition}
    end
  end

  defp refused_targets(entry, log, analysis, space_log, space_analysis) do
    [
      {log, analysis, entry.genesis},
      {log, analysis, entry.creation},
      {space_log, space_analysis, entry.reference}
    ]
    |> Enum.filter(fn {history, policy, id} ->
      Map.has_key?(Log.ops(history), id) and MapSet.member?(policy.quarantine, id)
    end)
    |> Enum.map(&elem(&1, 2))
    |> Enum.uniq()
    |> Enum.sort()
  end

  defp entry_result(results) do
    Enum.find(results, fn
      {:error, reason, _} -> reason != :trust_pending
      _ -> false
    end) || Enum.find(results, &match?({:error, :trust_pending, _}, &1)) || :ok
  end

  defp valid_genesis?(
         %Op{kind: :authority, body: {:genesis, %Delegation{} = d, _}} = op,
         entry,
         log,
         root
       ) do
    root == entry.root and op.author == root and d.issuer == root and d.audience == root and
      is_nil(d.parent_id) and Authority.verify_chain([d], log.replica) == :ok
  end

  defp valid_genesis?(_op, _entry, _log, _analysis), do: false

  defp valid_creation?(%Op{kind: :command, body: {command, args}} = op, entry, log)
       when is_list(args) do
    command == creation_command(entry.kind) and
      (not Map.has_key?(Log.ops(log), entry.genesis) or
         MapSet.member?(Dag.ancestors(Log.ops(log), op.id), entry.genesis))
  end

  defp valid_creation?(_op, _entry, _log), do: false

  defp reference(%{kind: :space} = entry, log, record) do
    if entry.replica == log.replica and entry.replica == record.space and
         entry.root == record.space_root,
       do: :ok,
       else: {:error, :invalid_catalog_transition}
  end

  defp reference(%{kind: :thread} = entry, log, _record) do
    with {:ok, op} <- fetch(Log.ops(log), entry.reference) do
      case op do
        %Op{kind: :command, body: {:create_thread, [replica, _title]}}
        when replica == entry.replica ->
          :ok

        _ ->
          {:error, :invalid_catalog_transition}
      end
    end
  end

  defp creation_command(:space), do: :create_space
  defp creation_command(:thread), do: :create_thread

  defp fetch(values, key) do
    case Map.fetch(values, key) do
      {:ok, value} -> {:ok, value}
      :error -> {:error, :trust_pending}
    end
  end

  defp result(results) do
    # A missing page must not conceal already available invalid entry proof.
    Enum.find(results, &(&1 not in [:ok, {:error, :trust_pending}])) ||
      Enum.find(results, &(&1 == {:error, :trust_pending})) || :ok
  end
end
