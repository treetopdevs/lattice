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
    with {:ok, catalog} <- TransportCatalog.normalize_catalog(catalog),
         :ok <- authenticate_histories(histories),
         {:ok, space_log} <- fetch(histories, catalog.space),
         {:ok, bootstrap} <- bootstrap(space_log, catalog.bootstrap),
         :ok <- verify_entries(catalog.entries, histories, space_log, bootstrap.record) do
      {:ok, %{entries: catalog.entries, bootstrap: bootstrap}}
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

  defp verify_entries(entries, histories, space_log, record) do
    space_analysis = Authority.analyze(Space, space_log)

    entries
    |> Enum.map(&verify_entry(&1, histories, space_log, space_analysis, record))
    |> result()
  end

  defp verify_entry(entry, histories, space_log, space_analysis, record) do
    with true <- Continuation.family(entry.replica) == {:bounded, entry.kind},
         true <- entry.service_id == record.service_id and entry.service_key == record.service_key,
         {:ok, log} <- fetch(histories, entry.replica),
         {:ok, genesis} <- fetch(Log.ops(log), entry.genesis),
         {:ok, creation} <- fetch(Log.ops(log), entry.creation),
         analysis = Authority.analyze(schema(entry.kind), log),
         true <- valid_genesis?(genesis, entry, log, analysis),
         true <- valid_creation?(creation, entry, log, analysis),
         :ok <- reference(entry, space_log, space_analysis, record) do
      :ok
    else
      false -> {:error, :invalid_catalog_transition}
      error -> error
    end
  end

  defp valid_genesis?(
         %Op{kind: :authority, body: {:genesis, %Delegation{} = d, _}} = op,
         entry,
         log,
         analysis
       ) do
    root = Authority.root(log)

    root == entry.root and op.author == root and d.issuer == root and d.audience == root and
      is_nil(d.parent_id) and Authority.verify_chain([d], log.replica) == :ok and
      honored?(op, analysis)
  end

  defp valid_genesis?(_op, _entry, _log, _analysis), do: false

  defp valid_creation?(%Op{kind: :command, body: {command, [_title]}} = op, entry, log, analysis) do
    command == creation_command(entry.kind) and honored?(op, analysis) and
      MapSet.member?(Dag.ancestors(Log.ops(log), op.id), entry.genesis)
  end

  defp valid_creation?(_op, _entry, _log, _analysis), do: false

  defp reference(%{kind: :space} = entry, log, _analysis, record) do
    if entry.replica == log.replica and entry.replica == record.space and
         entry.root == record.space_root,
       do: :ok,
       else: {:error, :invalid_catalog_transition}
  end

  defp reference(%{kind: :thread} = entry, log, analysis, _record) do
    with {:ok, op} <- fetch(Log.ops(log), entry.reference) do
      case op do
        %Op{kind: :command, body: {:create_thread, [replica, _title]}}
        when replica == entry.replica ->
          if honored?(op, analysis), do: :ok, else: {:error, :invalid_catalog_transition}

        _ ->
          {:error, :invalid_catalog_transition}
      end
    end
  end

  defp schema(:space), do: Space
  defp schema(:thread), do: Thread
  defp creation_command(:space), do: :create_space
  defp creation_command(:thread), do: :create_thread
  defp honored?(op, analysis), do: not MapSet.member?(analysis.quarantine, op.id)

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
