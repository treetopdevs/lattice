defmodule LatticeCarrierServer.Operator.CatalogStore do
  @moduledoc """
  Read-only verifier of the owner's catalog store at `<root>/catalog/`.

  The Linux mutation owner is the only writer. This module reads the signed
  envelopes, checks that they form one linear revision chain, and checks that
  every `catalog` receipt in the journal and its history names a stored
  envelope. The committed head is the highest-revision receipt; at most one
  envelope may lie past it (a pending write whose journal commit never ran).
  It claims nothing about publication or routes.
  """
  import Bitwise
  alias LatticeCarrierServer.Operator.Journal
  alias Treehouse.TransportCatalog

  @max_envelope 131_072
  @max_history 67_108_864
  @max_line 1_048_576

  @type info :: %{sha256: String.t(), revision: non_neg_integer(), previous: String.t() | nil}
  @type result :: %{
          head: String.t() | nil,
          head_revision: non_neg_integer() | nil,
          pending: nil | %{id: String.t(), sha256: String.t(), revision: non_neg_integer()},
          envelopes: %{String.t() => info()}
        }

  @spec path(Path.t()) :: Path.t()
  def path(root), do: Path.join(Path.expand(root), "catalog")

  @spec file_path(Path.t(), String.t()) :: Path.t()
  def file_path(root, sha256), do: Path.join(path(root), sha256 <> ".json")

  @spec committed_head(Path.t()) :: {:ok, String.t() | nil} | {:error, atom()}
  def committed_head(root) do
    with {:ok, %{head: head}} <- verify(root, nil), do: {:ok, head}
  end

  @doc """
  Verify the store against the journal receipts. With a 32-byte `key` every
  envelope signature is checked; with nil only structure is.
  """
  @spec verify(Path.t(), binary() | nil) :: {:ok, result()} | {:error, atom()}
  def verify(root, key) do
    with :ok <- Journal.secure_root(root),
         {:ok, uid} <- Journal.effective_uid(),
         {:ok, stored} <- read_store(root, uid, key),
         {:ok, chain} <- chain(stored),
         {:ok, current, receipts, replicas} <- receipts(root, uid),
         :ok <- match_receipts(chain, receipts),
         :ok <- receipt_space(stored, replicas),
         {:ok, result} <- head(chain, receipts),
         :ok <- complete_below_head(chain, receipts, result.head_revision),
         :ok <- journal_head(current, result.head) do
      {:ok, result}
    end
  end

  @doc "Read one verified immutable envelope, including an interrupted publish's temporary link."
  @spec load_envelope(Path.t(), String.t(), binary()) :: {:ok, map()} | {:error, atom()}
  def load_envelope(root, sha, key) do
    with true <- Journal.digest?(sha),
         {:ok, info} <- verify(root, key),
         true <- Enum.any?(info.envelopes, fn {_id, meta} -> meta.sha256 == sha end),
         {:ok, uid} <- Journal.effective_uid(),
         path = file_path(root, sha),
         {:ok, {:final, _}, bytes} <- read_file(path, sha <> ".json", uid, key),
         true <- byte_size(bytes) <= @max_envelope and Journal.digest(bytes) == sha,
         {:ok, envelope} <- TransportCatalog.decode_catalog_json(bytes),
         :ok <- TransportCatalog.verify_catalog(envelope, key) do
      {:ok, envelope}
    else
      _ -> {:error, :catalog_store_corrupt}
    end
  rescue
    _ -> {:error, :catalog_store_corrupt}
  end

  @doc "Read the exact verified bytes of the complete committed chain without repeated full-store scans."
  @spec committed_documents(Path.t(), binary()) :: {:ok, map()} | {:error, atom()}
  def committed_documents(root, key) when is_binary(key) and byte_size(key) == 32 do
    with {:ok, before} <- verify(root, key),
         nil <- before.pending,
         true <- is_binary(before.head) and map_size(before.envelopes) <= 1024,
         {:ok, uid} <- Journal.effective_uid(),
         {:ok, documents} <- read_documents(root, before.envelopes, uid, key),
         {:ok, ^before} <- verify(root, key) do
      {:ok, %{head: before.head, documents: documents}}
    else
      %{id: _} -> {:error, :catalog_publication_pending}
      _ -> {:error, :catalog_store_corrupt}
    end
  rescue
    _ -> {:error, :catalog_store_corrupt}
  end

  def committed_documents(_, _), do: {:error, :catalog_store_corrupt}

  defp read_documents(root, entries, uid, key) do
    entries
    |> Enum.sort_by(fn {_id, meta} -> meta.revision end)
    |> Enum.reduce_while({:ok, [], 0}, fn {id, meta}, {:ok, documents, size} ->
      with {:ok, {:final, checked}, bytes} <-
             read_file(file_path(root, meta.sha256), meta.sha256 <> ".json", uid, key),
           true <- checked.id == id and checked.revision == meta.revision,
           true <- size + byte_size(bytes) <= 16 * 1024 * 1024,
           {:ok, envelope} <- TransportCatalog.decode_catalog_json(bytes) do
        item = %{
          id: id,
          sha256: meta.sha256,
          revision: meta.revision,
          bytes: bytes,
          envelope: envelope
        }

        {:cont, {:ok, [item | documents], size + byte_size(bytes)}}
      else
        _ -> {:halt, {:error, :catalog_store_corrupt}}
      end
    end)
    |> case do
      {:ok, reversed, _size} -> {:ok, Enum.reverse(reversed)}
      refusal -> refusal
    end
  end

  defp read_store(root, uid, key) do
    dir = path(root)

    case File.lstat(dir) do
      {:error, :enoent} ->
        {:ok, []}

      {:ok, %{type: :directory, uid: ^uid, mode: mode}} when band(mode, 0o077) == 0 ->
        with {:ok, names} <- File.ls(dir),
             {:ok, entries} <- read_names(dir, names, uid, key),
             do: split_entries(entries)

      _ ->
        {:error, :catalog_store_corrupt}
    end
  end

  defp read_names(dir, names, uid, key) do
    Enum.reduce_while(names, {:ok, []}, fn name, {:ok, acc} ->
      case read_name(dir, name, uid, key) do
        {:ok, entry} -> {:cont, {:ok, [entry | acc]}}
        {:error, _} = error -> {:halt, error}
      end
    end)
  end

  defp read_name(dir, name, uid, key) do
    cond do
      Regex.match?(~r/\A\.tmp\.[0-9a-f]{32}\z/, name) ->
        read_temp(Path.join(dir, name), uid)

      Regex.match?(~r/\A[0-9a-f]{64}\.json\z/, name) ->
        case read_file(Path.join(dir, name), name, uid, key) do
          {:ok, entry, _bytes} -> {:ok, entry}
          {:error, _} = refusal -> refusal
        end

      true ->
        {:error, :catalog_store_corrupt}
    end
  end

  # A temp is skipped by content but must still be a private regular file.
  defp read_temp(file, uid) do
    case File.lstat(file) do
      {:ok, %{type: :regular, uid: ^uid, mode: mode, major_device: dev, inode: inode}}
      when band(mode, 0o077) == 0 ->
        {:ok, {:temp, {dev, inode}}}

      _ ->
        {:error, :catalog_store_corrupt}
    end
  end

  # A final may have a second link only from an interrupted publish: exactly
  # one temp in this store names the same inode.
  defp split_entries(entries) do
    temps = for {:temp, node} <- entries, do: node
    finals = for {:final, entry} <- entries, do: entry

    ok? =
      Enum.all?(finals, fn %{links: links, node: node} ->
        links == 1 or Enum.count(temps, &(&1 == node)) == 1
      end)

    if ok?, do: {:ok, finals}, else: {:error, :catalog_store_corrupt}
  end

  defp read_file(file, name, uid, key) do
    sha = String.replace_suffix(name, ".json", "")

    with {:ok,
          %{
            type: :regular,
            links: links,
            uid: ^uid,
            mode: mode,
            size: size,
            major_device: dev,
            inode: inode
          }} <- File.lstat(file),
         true <- links in [1, 2] and band(mode, 0o077) == 0 and size <= @max_envelope,
         {:ok, bytes} <- bounded_document(file),
         true <- Journal.digest(bytes) == sha,
         {:ok, %{catalog: catalog}} <- TransportCatalog.decode_catalog_json(bytes),
         true <- signed?(bytes, key) do
      {:ok,
       {:final,
        %{
          links: links,
          node: {dev, inode},
          id: TransportCatalog.catalog_id(catalog),
          sha256: sha,
          revision: catalog.revision,
          previous: catalog.previous,
          shared: {catalog.bootstrap, catalog.binding, catalog.space}
        }}, bytes}
    else
      _ -> {:error, :catalog_store_corrupt}
    end
  end

  defp bounded_document(path) do
    with {:ok, file} <- File.open(path, [:read, :binary, :raw]) do
      try do
        case :file.read(file, @max_envelope + 1) do
          {:ok, bytes} when byte_size(bytes) <= @max_envelope -> {:ok, bytes}
          _ -> {:error, :catalog_store_corrupt}
        end
      after
        File.close(file)
      end
    end
  end

  defp signed?(_bytes, nil), do: true

  defp signed?(bytes, key) when byte_size(key) == 32,
    do: TransportCatalog.verify_catalog_json(bytes, key) == :ok

  defp signed?(_bytes, _key), do: false

  # A linear chain: revision 0 first, each next one naming its predecessor.
  defp chain(stored) do
    by_id = Map.new(stored, &{&1.id, &1})

    cond do
      map_size(by_id) != length(stored) ->
        {:error, :catalog_store_corrupt}

      stored |> Enum.map(& &1.shared) |> Enum.uniq() |> length() > 1 ->
        {:error, :catalog_store_corrupt}

      stored
      |> Enum.group_by(& &1.previous)
      |> Enum.any?(fn {_, group} -> length(group) > 1 end) ->
        {:error, :catalog_fork}

      Enum.all?(stored, &linked?(&1, by_id)) ->
        {:ok,
         Map.new(by_id, fn {id, e} -> {id, Map.take(e, [:sha256, :revision, :previous])} end)}

      true ->
        {:error, :catalog_store_corrupt}
    end
  end

  defp linked?(%{previous: nil, revision: 0}, _by_id), do: true

  defp linked?(%{previous: previous, revision: revision}, by_id) when previous != nil,
    do: match?(%{revision: r} when r == revision - 1, by_id[previous])

  defp linked?(_entry, _by_id), do: false

  # Every catalog artifact of the journal and of each complete history line.
  defp receipts(root, uid) do
    with {:ok, current} <- current_record(root),
         {:ok, lines} <- history_records(root, uid) do
      artifacts =
        for record <- current ++ lines,
            %{"kind" => "catalog"} = artifact <- record["artifacts"],
            do: artifact

      pairs = Enum.map(artifacts, &{&1["op_id"], &1["sha256"]})

      {:ok, List.first(current), Enum.uniq(pairs),
       Enum.uniq(Enum.map(artifacts, & &1["replica"]))}
    end
  end

  defp current_record(root) do
    case Journal.read(root) do
      {:ok, nil} -> {:ok, []}
      {:ok, raw} -> with {:ok, record} <- Journal.decode(raw), do: {:ok, [record]}
      {:error, _} = error -> error
    end
  end

  defp history_records(root, uid) do
    file = Journal.history_path(root)

    case File.lstat(file) do
      {:error, :enoent} ->
        {:ok, []}

      # The owner writes history only as this user's private single-link file.
      {:ok, %{type: :regular, size: size, uid: ^uid, links: 1, mode: mode}}
      when size <= @max_history and band(mode, 0o077) == 0 ->
        with {:ok, raw} <- File.read(file), do: decode_lines(raw)

      _ ->
        {:error, :catalog_store_corrupt}
    end
  end

  # The text after the last newline is a torn append and is ignored.
  defp decode_lines(raw) do
    lines = raw |> :binary.split("\n", [:global]) |> Enum.drop(-1)

    Enum.reduce_while(lines, {:ok, []}, fn line, {:ok, acc} ->
      with true <- byte_size(line) <= @max_line,
           {:ok, record} <- Journal.decode(line) do
        {:cont, {:ok, [record | acc]}}
      else
        _ -> {:halt, {:error, :catalog_store_corrupt}}
      end
    end)
  end

  # Every receipt names the Space the stored envelopes catalog.
  defp receipt_space(_stored, []), do: :ok

  defp receipt_space([%{shared: {_, _, space}} | _], replicas) do
    if replicas == [space], do: :ok, else: {:error, :catalog_store_corrupt}
  end

  defp receipt_space([], _replicas), do: {:error, :catalog_store_corrupt}

  defp match_receipts(chain, receipts) do
    ok? =
      Enum.all?(receipts, fn {id, sha} ->
        match?(%{sha256: ^sha}, chain[id])
      end)

    if ok?, do: :ok, else: {:error, :catalog_store_corrupt}
  end

  # Every envelope at or below the committed head was committed, so each must
  # be a receipt; only envelopes past the head may lack one.
  defp complete_below_head(_chain, _receipts, nil), do: :ok

  defp complete_below_head(chain, receipts, head_revision) do
    ok? =
      Enum.all?(chain, fn {id, e} ->
        e.revision > head_revision or {id, e.sha256} in receipts
      end)

    if ok?, do: :ok, else: {:error, :catalog_store_corrupt}
  end

  # The journal's catalog_head is the committed head (nil with no receipts).
  # History is appended only when a journal is replaced, so a receipt with no
  # current journal means the journal was lost.
  defp journal_head(nil, nil), do: :ok
  defp journal_head(%{"catalog_head" => head}, head), do: :ok
  defp journal_head(_record, _head), do: {:error, :catalog_store_corrupt}

  defp head(chain, receipts) do
    {head, head_revision} =
      receipts
      |> Enum.map(fn {id, _} -> {id, chain[id].revision} end)
      |> Enum.max_by(&elem(&1, 1), fn -> {nil, nil} end)

    past =
      for {id, e} <- chain, head_revision == nil or e.revision > head_revision, do: {id, e}

    with {:ok, pending} <- pending(past, head) do
      {:ok, %{head: head, head_revision: head_revision, pending: pending, envelopes: chain}}
    end
  end

  defp pending([], _head), do: {:ok, nil}

  defp pending([{id, e}], head) do
    if e.previous == head,
      do: {:ok, %{id: id, sha256: e.sha256, revision: e.revision}},
      else: {:error, :catalog_fork}
  end

  defp pending(_many, _head), do: {:error, :catalog_fork}
end
