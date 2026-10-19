defmodule LatticeCarrierServer.Operator.CatalogCeremony.SpaceExport do
  @moduledoc false
  # The ordinary app's Space frames export (D-31): one UTF-8 JSON object
  #
  #     {"format","frames","root","space"}
  #
  # holding the Space root's verified op frames. `load/1` admits it only as
  # strictly as a `Lattice.Log.dump`: every frame is decoded through
  # `Lattice.Carrier.Wire`, must re-encode to exactly the frame as written,
  # must belong to the declared Space, and the assembled log must pass
  # `Lattice.Log.verify_authenticity/1` (content hash, signature, dependencies,
  # referenced set). The whole file must also equal `encode/2` of what it
  # decodes to, so an alternative encoding of the same frames is refused.
  # Every refusal is one opaque `:invalid_space_export`.

  alias Lattice.{Authority, Log, Op}
  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.Operator.CatalogCeremony.Atoms

  @format "lattice-space-frames-export-v1"
  @max_bytes 16 * 1024 * 1024
  @max_frames 4000
  @top_keys ~w(format frames root space)
  @frame_keys ~w(author body cap deps id kind replica sig v)

  @spec load(Path.t()) :: {:ok, Log.t()} | {:error, :invalid_space_export}
  def load(path) do
    Atoms.load()

    with {:ok, bytes} <- read(path),
         {:ok, %{} = doc} <- JSON.decode(bytes),
         {:ok, space, root, frames} <- shape(doc),
         {:ok, ops} <- ops(space, frames),
         log = Log.from_ops(space, Map.new(ops, &{&1.id, &1})),
         :ok <- Log.verify_authenticity(log),
         :ok <- root_matches(log, root),
         true <- encode(log, root) == bytes do
      {:ok, log}
    else
      _ -> {:error, :invalid_space_export}
    end
  rescue
    _ -> {:error, :invalid_space_export}
  catch
    _, _ -> {:error, :invalid_space_export}
  end

  @doc "The exact export bytes for a log and its declared root public key."
  @spec encode(Log.t(), binary()) :: binary()
  def encode(%Log{replica: space, ops: ops}, root) when is_binary(root) do
    frames =
      ops
      |> Map.values()
      |> Enum.sort_by(& &1.id)
      |> Enum.map(&Wire.encode_op/1)

    json(%{
      "format" => @format,
      "space" => space,
      "root" => Base.encode64(root),
      "frames" => frames
    })
  end

  defp read(path) when is_binary(path) do
    with {:ok, %File.Stat{type: :regular, size: size}} when size <= @max_bytes <-
           File.stat(path),
         {:ok, bytes} when byte_size(bytes) <= @max_bytes <- File.read(path) do
      {:ok, bytes}
    else
      _ -> :error
    end
  end

  defp shape(doc) do
    with true <- Enum.sort(Map.keys(doc)) == @top_keys,
         @format <- doc["format"],
         space when is_binary(space) and space != "" <- doc["space"],
         {:ok, root} when byte_size(root) == 32 <- Base.decode64(doc["root"] || 0),
         true <- Base.encode64(root) == doc["root"],
         frames when is_list(frames) and frames != [] and length(frames) <= @max_frames <-
           doc["frames"] do
      {:ok, space, root, frames}
    else
      _ -> :error
    end
  end

  defp ops(space, frames) do
    decoded =
      Enum.reduce_while(frames, {:ok, []}, fn frame, {:ok, acc} ->
        with %{} <- frame,
             true <- Enum.sort(Map.keys(frame)) == @frame_keys,
             {:ok, %Op{replica: ^space} = op} <- Wire.decode_op(frame),
             true <- Wire.encode_op(op) == frame do
          {:cont, {:ok, [op | acc]}}
        else
          _ -> {:halt, :error}
        end
      end)

    with {:ok, reversed} <- decoded,
         ops = Enum.reverse(reversed),
         ids = Enum.map(ops, & &1.id),
         true <- ids == Enum.sort(ids) and ids == Enum.uniq(ids) do
      {:ok, ops}
    else
      _ -> :error
    end
  end

  # A profile root, when the Space has one, must be the declared root, and the
  # declared root must have authored a dependency-free authority op (its genesis).
  # Competing geneses by other authors are retained by the app and quarantined by
  # Authority; they do not make the history invalid (`Log.dump` admits them too).
  defp root_matches(log, root) do
    geneses =
      for {_, %Op{kind: :authority, deps: [], author: author}} <- log.ops, do: author

    profile_ok =
      case Authority.continuation_profile(log) do
        {:ok, %{root: profile_root}} -> profile_root == root
        _ -> true
      end

    if profile_ok and root in geneses, do: :ok, else: :error
  end

  # Compact JSON, object keys sorted recursively; no whitespace.
  defp json(%{} = map) do
    body =
      map
      |> Enum.sort_by(fn {k, _} -> k end)
      |> Enum.map_join(",", fn {k, v} -> JSON.encode!(k) <> ":" <> json(v) end)

    "{" <> body <> "}"
  end

  defp json(list) when is_list(list), do: "[" <> Enum.map_join(list, ",", &json/1) <> "]"
  defp json(value), do: JSON.encode!(value)
end
