defmodule LatticeCarrierServer.Operator.CatalogCeremony.SigningLedger do
  @moduledoc """
  Locked custodian revision ledger with immutable signed envelopes.

  The Python helper owns all public-file writes and the lifetime OS lock.
  Signature/chain checks and signing callbacks execute in BEAM while it holds
  that lock. A callback result is released only after durable ACK and exit.
  """
  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.Operator.PublicHistory
  alias Treehouse.TransportCatalog

  @helper Path.expand("../../../../../../scripts/treehouse_catalog_signing_owner.py", __DIR__)
  @external_resource @helper
  @cap 67_108_864
  @timeout 35_000

  @doc false
  @spec max_envelopes() :: pos_integer()
  def max_envelopes, do: 12

  @spec init(Path.t(), map()) :: {:ok, map()} | {:error, atom()}
  def init(dir, binding), do: transact(dir, binding, "init", &unchanged/1)

  @spec status(Path.t(), map()) :: {:ok, map()} | {:error, atom()}
  def status(dir, binding), do: transact(dir, binding, "open", &unchanged/1)

  @doc "Public ledger status for relay-side preparation; no freshness guarantee."
  @spec export_status(map(), map()) :: binary()
  def export_status(state, binding) do
    PublicHistory.canonical(%{
      "format" => "treehouse-custodian-status-v1",
      "binding" => binding.bootstrap_id,
      "key" => Base.encode64(binding.record.catalog_key),
      "head" => state.head_bytes,
      "envelopes" => Enum.map(state.chain, & &1.bytes)
    })
  end

  @spec verify_status(term(), map()) :: {:ok, map()} | {:error, atom()}
  def verify_status(bytes, binding) when is_binary(bytes) and byte_size(bytes) <= @cap do
    with {:ok, doc} <- JSON.decode(bytes),
         true <- Enum.sort(Map.keys(doc)) == ~w(binding envelopes format head key),
         true <- doc["format"] == "treehouse-custodian-status-v1",
         true <- doc["binding"] == binding.bootstrap_id,
         true <- doc["key"] == Base.encode64(binding.record.catalog_key),
         true <- PublicHistory.canonical(doc) == bytes do
      verify(Map.take(doc, ["head", "envelopes"]), binding)
    else
      _ -> {:error, :catalog_ledger_corrupt}
    end
  rescue
    _ -> {:error, :catalog_ledger_corrupt}
  end

  def verify_status(_, _), do: {:error, :catalog_ledger_corrupt}

  defp unchanged(state), do: {:ok, state.head_bytes, nil, state}

  @doc false
  @spec transact(Path.t(), map(), String.t(), (map() -> term())) :: term()
  def transact(dir, binding, action, callback) do
    with python when is_binary(python) <- System.find_executable("python3"),
         true <- File.regular?(@helper) do
      port =
        Port.open({:spawn_executable, python}, [
          :binary,
          :exit_status,
          :use_stdio,
          args: [@helper, Path.expand(dir)]
        ])

      try do
        send_json(port, %{
          action: action,
          binding: binding.bootstrap_id,
          key: Base.encode64(binding.record.catalog_key)
        })

        with {:ok, snapshot} <- response(port),
             {:ok, state} <- verify(snapshot, binding),
             {:ok, head, envelope, value} <- callback.(state),
             true <- send_json(port, %{head: head, envelope: envelope}),
             {:ok, %{"ok" => true}} <- response(port),
             :ok <- exited(port) do
          {:ok, value}
        else
          {:error, _} = refusal -> refusal
          _ -> {:error, :catalog_ledger_failed}
        end
      after
        if Port.info(port), do: Port.close(port)
      end
    else
      _ -> {:error, :catalog_ledger_unavailable}
    end
  rescue
    _ -> {:error, :catalog_ledger_failed}
  catch
    :exit, _ -> {:error, :catalog_ledger_failed}
  end

  @spec head(map(), non_neg_integer() | nil, String.t() | nil) :: binary()
  def head(binding, revision, id),
    do:
      PublicHistory.canonical(%{
        "binding" => binding.bootstrap_id,
        "key" => Base.encode64(binding.record.catalog_key),
        "revision" => revision,
        "id" => id
      })

  defp verify(%{"head" => bytes, "envelopes" => envelopes} = raw, binding)
       when map_size(raw) == 2 and is_binary(bytes) and is_list(envelopes) and
              length(envelopes) <= 12 do
    with {:ok, head} <- JSON.decode(bytes),
         true <- Enum.sort(Map.keys(head)) == ~w(binding id key revision),
         true <- head["binding"] == binding.bootstrap_id,
         true <- head["key"] == Base.encode64(binding.record.catalog_key),
         true <- PublicHistory.canonical(head) == bytes,
         {:ok, chain} <- envelopes(envelopes, binding),
         {:ok, committed, pending} <- match_head(chain, head) do
      {:ok,
       %{head: head, head_bytes: bytes, committed: committed, pending: pending, chain: chain}}
    else
      _ -> {:error, :catalog_ledger_corrupt}
    end
  end

  defp verify(_, _), do: {:error, :catalog_ledger_corrupt}

  defp envelopes(bytes, binding) do
    Enum.reduce_while(bytes, {:ok, []}, fn bytes, {:ok, result} ->
      with true <- is_binary(bytes) and byte_size(bytes) <= 131_072,
           {:ok, %{catalog: catalog} = envelope} <- TransportCatalog.decode_catalog_json(bytes),
           :ok <- TransportCatalog.verify_catalog(envelope, binding.record.catalog_key),
           true <- PublicHistory.canonical(Wire.encode_value(envelope)) == bytes,
           true <-
             catalog.space == binding.record.space and catalog.binding == binding.bootstrap_id and
               catalog.bootstrap == binding.bootstrap_id do
        {:cont,
         {:ok,
          [%{catalog: catalog, id: TransportCatalog.catalog_id(catalog), bytes: bytes} | result]}}
      else
        _ -> {:halt, :error}
      end
    end)
    |> case do
      {:ok, entries} -> chain(Enum.sort_by(entries, & &1.catalog.revision))
      _ -> :error
    end
  end

  defp chain(entries) do
    result =
      Enum.reduce_while(entries, nil, fn entry, previous ->
        if extends?(entry.catalog, previous), do: {:cont, entry}, else: {:halt, :error}
      end)

    if result == :error, do: :error, else: {:ok, entries}
  end

  @doc false
  @spec extends?(map(), map() | nil) :: boolean()
  def extends?(catalog, nil),
    do:
      catalog.revision == 0 and catalog.previous == nil and
        Enum.sort(Enum.map(catalog.entries, & &1.kind)) == [:space, :thread]

  def extends?(catalog, previous) do
    before = previous.catalog
    old = Map.new(before.entries, &{&1.replica, &1})
    added = Enum.reject(catalog.entries, &Map.has_key?(old, &1.replica))

    catalog.revision == before.revision + 1 and catalog.previous == previous.id and
      length(catalog.entries) == length(before.entries) + 1 and
      Enum.all?(before.entries, &(&1 in catalog.entries)) and match?([%{kind: :thread}], added)
  end

  defp match_head(chain, %{"revision" => nil, "id" => nil}) when length(chain) <= 1,
    do: {:ok, nil, List.first(chain)}

  defp match_head(chain, %{"revision" => revision, "id" => id})
       when is_integer(revision) and revision >= 0 do
    case Enum.split(chain, revision + 1) do
      {committed, pending} when length(committed) == revision + 1 and length(pending) <= 1 ->
        if List.last(committed).id == id,
          do: {:ok, List.last(committed), List.first(pending)},
          else: :error

      _ ->
        :error
    end
  end

  defp match_head(_, _), do: :error

  defp send_json(port, value), do: Port.command(port, Jason.encode!(value) <> "\n")

  defp response(port, acc \\ "") do
    receive do
      {^port, {:data, bytes}} when byte_size(acc) + byte_size(bytes) <= @cap ->
        data = acc <> bytes

        if String.ends_with?(data, "\n") do
          case Jason.decode(data) do
            {:ok, %{"error" => reason}} -> {:error, refusal(reason)}
            {:ok, value} -> {:ok, value}
            _ -> {:error, :catalog_ledger_protocol}
          end
        else
          response(port, data)
        end

      {^port, {:exit_status, _}} ->
        {:error, :catalog_ledger_failed}

      {^port, _} ->
        {:error, :catalog_ledger_protocol}
    after
      @timeout -> {:error, :catalog_ledger_timeout}
    end
  end

  defp refusal(reason) do
    known =
      ~w(catalog_ledger_busy catalog_ledger_corrupt catalog_ledger_uninitialized catalog_ledger_fork catalog_ledger_timeout unsafe_catalog_ledger catalog_ledger_capacity catalog_ledger_protocol)a

    Enum.find(known, :catalog_ledger_failed, &(Atom.to_string(&1) == reason))
  end

  defp exited(port) do
    receive do
      {^port, {:exit_status, 0}} -> :ok
      {^port, {:exit_status, _}} -> {:error, :catalog_ledger_failed}
    after
      @timeout -> {:error, :catalog_ledger_timeout}
    end
  end
end
