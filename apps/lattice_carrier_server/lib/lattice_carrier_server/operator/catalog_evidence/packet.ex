defmodule LatticeCarrierServer.Operator.CatalogEvidence.Packet do
  @moduledoc """
  Bounded public catalog evidence file, judged by the existing pure evaluator.

  This codec neither reads host files nor installs trust. Its successful decode
  means the complete supplied evidence forms a reason-nil candidate, not that a
  user pinned it, the host serves it, or any route should be activated.
  """
  alias Lattice.{Log, Op}
  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.Operator.{PublicHistory, CatalogCeremony.Atoms}
  alias Treehouse.{CatalogBootstrap, CatalogTrust, TransportCatalog}

  @format "lattice-catalog-evidence-page-v1"
  @max_file 64 * 1024 * 1024
  @max_snapshot 32 * 1024 * 1024
  @max_artifacts 1024
  @max_artifact 131_072
  @max_artifact_total 16 * 1024 * 1024
  @expected %{trust_revision: 0, history_generation: 0}
  @keys ~w(bootstrapId format head pages space)
  @page_keys ~w(catalogs cutoffProofs histories rotations)

  @spec encode(Log.t(), [binary()], %{String.t() => Log.t()}, String.t()) ::
          {:ok, binary()} | {:error, atom()}
  def encode(%Log{} = space, catalogs, histories, head) when is_map(histories) do
    Atoms.load()

    with :ok <- same(histories[space.replica] == space, :invalid_verified_history),
         {:ok, bootstrap} <- bootstrap(space),
         {:ok, catalogs} <- ordered(catalogs, bootstrap.record.catalog_key, head),
         {:ok, raws} <- raw_histories(histories),
         pages = pages(catalogs, raws),
         doc = %{
           "format" => @format,
           "space" => space.replica,
           "bootstrapId" => bootstrap.id,
           "head" => head,
           "pages" => pages
         },
         {:ok, _} <- observe(doc),
         bytes = PublicHistory.canonical(doc),
         :ok <- same(byte_size(bytes) <= @max_file, :evidence_page_too_large) do
      {:ok, bytes}
    else
      {:error, reason} when is_atom(reason) -> {:error, reason}
      _ -> {:error, :evidence_page_malformed}
    end
  rescue
    _ -> {:error, :evidence_page_malformed}
  catch
    _, _ -> {:error, :evidence_page_malformed}
  end

  def encode(_, _, _, _), do: {:error, :evidence_page_malformed}

  @spec decode(term()) :: {:ok, map()} | {:error, atom()}
  def decode(bytes) when is_binary(bytes) and byte_size(bytes) > @max_file,
    do: {:error, :evidence_page_too_large}

  def decode(bytes) when is_binary(bytes) do
    Atoms.load()

    with true <- String.valid?(bytes),
         {:ok, doc} <- JSON.decode(bytes),
         true <- PublicHistory.canonical(doc) == bytes,
         {:ok, snapshot_bytes} <- observe(doc) do
      {:ok,
       %{
         space: doc["space"],
         bootstrap_id: doc["bootstrapId"],
         head: doc["head"],
         pages: doc["pages"],
         snapshot_bytes: snapshot_bytes
       }}
    else
      {:error, reason} when is_atom(reason) -> {:error, reason}
      _ -> {:error, :evidence_page_malformed}
    end
  rescue
    _ -> {:error, :evidence_page_malformed}
  catch
    _, _ -> {:error, :evidence_page_malformed}
  end

  def decode(_), do: {:error, :evidence_page_malformed}

  defp bootstrap(space) do
    with :ok <- Log.verify_authenticity(space),
         {:ok, %{bootstraps: [found]}} <- CatalogBootstrap.observe(space) do
      {:ok, found}
    else
      {:ok, %{bootstraps: [_ | _]}} -> {:error, :catalog_fork}
      _ -> {:error, :evidence_page_malformed}
    end
  end

  defp ordered(catalogs, key, head) when is_list(catalogs) do
    cond do
      length(catalogs) not in 1..@max_artifacts ->
        {:error, :evidence_page_too_large}

      not Enum.all?(catalogs, &is_binary/1) ->
        {:error, :evidence_page_malformed}

      Enum.any?(catalogs, &(byte_size(&1) > @max_artifact)) ->
        {:error, :evidence_page_too_large}

      Enum.reduce(catalogs, 0, &(byte_size(&1) + &2)) > @max_artifact_total ->
        {:error, :evidence_page_too_large}

      true ->
        Enum.reduce_while(catalogs, {:ok, []}, fn bytes, {:ok, acc} ->
          with {:ok, envelope} <- TransportCatalog.decode_catalog_json(bytes),
               :ok <- TransportCatalog.verify_catalog(envelope, key) do
            item = %{
              catalog: envelope.catalog,
              id: TransportCatalog.catalog_id(envelope.catalog),
              bytes: bytes
            }

            {:cont, {:ok, [item | acc]}}
          else
            {:error, reason} -> {:halt, {:error, reason}}
          end
        end)
        |> case do
          {:ok, found} -> linear(Enum.sort_by(found, & &1.catalog.revision), head)
          refusal -> refusal
        end
    end
  end

  defp ordered(_, _, _), do: {:error, :evidence_page_malformed}

  defp linear(found, head) do
    revisions = Enum.map(found, & &1.catalog.revision)

    cond do
      Enum.uniq(revisions) != revisions ->
        {:error, :catalog_fork}

      revisions != Enum.to_list(0..(length(found) - 1)) ->
        {:error, :catalog_chain_incomplete}

      List.last(found).id != head ->
        {:error, :stale_catalog_head}

      true ->
        Enum.reduce_while(found, {:ok, nil}, fn item, {:ok, previous} ->
          if item.catalog.previous == previous,
            do: {:cont, {:ok, item.id}},
            else: {:halt, {:error, :catalog_chain_incomplete}}
        end)
        |> case do
          {:ok, _} -> {:ok, Enum.map(found, & &1.bytes)}
          refusal -> refusal
        end
    end
  end

  defp raw_histories(histories) when map_size(histories) in 1..13 do
    Enum.reduce_while(histories, {:ok, []}, fn {replica, log}, {:ok, acc} ->
      with %Log{replica: ^replica} <- log, :ok <- Log.verify_authenticity(log) do
        rejected =
          log
          |> Log.quarantine()
          |> Enum.sort_by(& &1.op.id)
          |> Enum.map(&%{"frame" => Wire.encode_op(&1.op), "reason" => "bad_signature"})

        raw = %{
          "replica" => replica,
          "frames" => PublicHistory.frames(log),
          "rejected" => rejected
        }

        {:cont, {:ok, [raw | acc]}}
      else
        _ -> {:halt, {:error, :invalid_verified_history}}
      end
    end)
    |> case do
      {:ok, raws} -> {:ok, Enum.sort_by(raws, & &1["replica"])}
      refusal -> refusal
    end
  end

  defp raw_histories(_), do: {:error, :evidence_page_malformed}

  defp pages(catalogs, histories) do
    catalogs
    |> Enum.chunk_every(32)
    |> Enum.with_index()
    |> Enum.map(fn {chunk, index} ->
      %{
        "catalogs" => chunk,
        "rotations" => [],
        "histories" => if(index == 0, do: histories, else: []),
        "cutoffProofs" => []
      }
    end)
  end

  defp observe(doc) do
    with :ok <-
           same(
             is_map(doc) and Enum.sort(Map.keys(doc)) == @keys and doc["format"] == @format,
             :evidence_page_malformed
           ),
         pages when is_list(pages) and pages != [] and length(pages) <= 32 <- doc["pages"],
         :ok <- same(Enum.all?(pages, &page?/1), :evidence_page_malformed),
         all_catalogs = Enum.flat_map(pages, & &1["catalogs"]),
         all_histories = Enum.flat_map(pages, & &1["histories"]),
         :ok <-
           same(
             length(all_histories) in 1..13 and Enum.all?(all_histories, &history?/1),
             :evidence_page_malformed
           ),
         [space_raw] <- Enum.filter(all_histories, &(&1["replica"] == doc["space"])),
         {:ok, space} <- restored(space_raw),
         {:ok, bootstrap} <- bootstrap(space),
         :ok <- same(doc["bootstrapId"] == bootstrap.id, :wrong_catalog_scope),
         {:ok, ^all_catalogs} <- ordered(all_catalogs, bootstrap.record.catalog_key, doc["head"]),
         {:ok, head_envelope} <- TransportCatalog.decode_catalog_json(List.last(all_catalogs)),
         expected_replicas =
           head_envelope.catalog.entries |> Enum.map(& &1.replica) |> Enum.sort(),
         :ok <-
           same(
             Enum.map(all_histories, & &1["replica"]) == expected_replicas,
             :invalid_verified_history
           ),
         review = %{
           version: 1,
           product: :treehouse,
           space: space.replica,
           space_root: bootstrap.record.space_root,
           bootstrap_id: bootstrap.id,
           observed_bootstrap_ids: [bootstrap.id],
           disposition: :pin_exact_observed_bootstrap
         },
         %{kind: :propose, reason: nil, next: initial} <-
           CatalogTrust.prepare_installation(%{
             review: review,
             history: raw(space_raw),
             store: %{kind: :verified_fresh, expected: @expected}
           }),
         {:ok, final} <- evaluate(pages, initial),
         :ok <- same(final.accepted.catalog == doc["head"], :stale_catalog_head),
         snapshot_bytes = byte_size(PublicHistory.canonical(snapshot(final))),
         :ok <- same(snapshot_bytes <= @max_snapshot, :evidence_page_too_large) do
      {:ok, snapshot_bytes}
    else
      {:error, reason} when is_atom(reason) -> {:error, reason}
      %{reason: reason} when is_atom(reason) and not is_nil(reason) -> {:error, reason}
      _ -> {:error, :evidence_page_malformed}
    end
  end

  defp page?(page) do
    is_map(page) and Enum.sort(Map.keys(page)) == @page_keys and
      is_list(page["catalogs"]) and length(page["catalogs"]) in 1..32 and
      page["rotations"] == [] and page["cutoffProofs"] == [] and
      is_list(page["histories"])
  end

  defp history?(history) do
    is_map(history) and Enum.sort(Map.keys(history)) == ~w(frames rejected replica) and
      is_binary(history["replica"]) and is_list(history["frames"]) and
      is_list(history["rejected"]) and
      Enum.all?(history["rejected"], fn item ->
        is_map(item) and Enum.sort(Map.keys(item)) == ~w(frame reason) and
          item["reason"] == "bad_signature" and is_map(item["frame"])
      end)
  end

  defp same(true, _reason), do: :ok
  defp same(_, reason), do: {:error, reason}

  defp restored(history) do
    frames = history["frames"]

    with true <- Enum.sort(Map.keys(history)) == ~w(frames rejected replica),
         true <- is_list(frames) and frames != [],
         {:ok, ops} <- decode_frames(frames),
         log = Log.from_ops(history["replica"], Map.new(ops, &{&1.id, &1})),
         true <- map_size(log.ops) == length(frames),
         :ok <- Log.verify_authenticity(log) do
      {:ok, log}
    else
      _ -> {:error, :invalid_verified_history}
    end
  end

  defp decode_frames(frames) do
    Enum.reduce_while(frames, {:ok, []}, fn frame, {:ok, acc} ->
      case Wire.decode_op(frame) do
        {:ok, %Op{} = op} -> {:cont, {:ok, [op | acc]}}
        _ -> {:halt, {:error, :invalid_verified_history}}
      end
    end)
  end

  defp raw(history),
    do: %{
      replica: history["replica"],
      frames: history["frames"],
      rejected: Enum.map(history["rejected"], &%{frame: &1["frame"], reason: :bad_signature})
    }

  defp evaluate(pages, initial) do
    Enum.reduce_while(pages, {:ok, initial}, fn page, {:ok, installed} ->
      incoming = %{
        catalogs: page["catalogs"],
        rotations: [],
        histories: Enum.map(page["histories"], &raw/1),
        cutoff_proofs: []
      }

      case CatalogTrust.evaluate(%{installed: installed, expected: @expected, incoming: incoming}) do
        %{kind: :propose, reason: nil, next: next} -> {:cont, {:ok, next}}
        %{reason: reason} when is_atom(reason) -> {:halt, {:error, reason}}
        _ -> {:halt, {:error, :evidence_page_malformed}}
      end
    end)
  end

  defp snapshot(state) do
    review = state.review

    %{
      "version" => 1,
      "review" => %{
        "version" => 1,
        "product" => "treehouse",
        "space" => review.space,
        "spaceRoot" => Base.encode64(review.space_root),
        "bootstrapId" => review.bootstrap_id,
        "observedBootstrapIds" => review.observed_bootstrap_ids,
        "disposition" => "pin_exact_observed_bootstrap"
      },
      "histories" =>
        Enum.map(state.histories, fn history ->
          %{
            "replica" => history.replica,
            "frames" => history.frames,
            "rejected" =>
              Enum.map(history.rejected, &%{"frame" => &1.frame, "reason" => "bad_signature"})
          }
        end),
      "catalogs" => Enum.map(state.catalogs, &%{"id" => &1.id, "json" => &1.json}),
      "rotations" => [],
      "cutoffProofs" => [],
      "accepted" => state.accepted,
      "blocked" => nil
    }
  end
end
