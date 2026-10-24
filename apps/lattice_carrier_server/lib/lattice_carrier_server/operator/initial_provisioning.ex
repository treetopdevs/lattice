defmodule LatticeCarrierServer.Operator.InitialProvisioning do
  @moduledoc """
  Verified public-bundle import into a new private offline output directory.

  The completion index is written last. Partial or conflicting directories are
  preserved and refused; a completed retry rechecks every byte. No served file,
  service identity, manifest or operator journal is replaced by this importer.
  """
  import Bitwise, only: [band: 2]
  alias Lattice.{Authority, Log}
  alias LatticeCarrierServer.{Manifest, Runtime}
  alias LatticeCarrierServer.Durability.Posix
  alias LatticeCarrierServer.Operator.{CatalogBinding, InitialBundle, Journal, Staging}
  alias LatticeCarrierServer.Operator.CatalogCeremony.Paths

  @index "complete.json"

  @spec prepare(keyword()) :: {:ok, map()} | {:error, atom()}
  def prepare(opts) do
    with true <- :os.type() == {:unix, :linux},
         {:ok, paths} <- paths(opts),
         :ok <- Journal.secure_root(paths.operator),
         :ok <- Journal.identity_location(paths.identity),
         {:ok, bundle} <- InitialBundle.load(paths.bundle),
         {:ok, binding} <- CatalogBinding.load_log(paths.ceremony, bundle.space),
         true <- binding.bootstrap_id == bundle.bootstrap.id,
         {:ok, _secret, pub} <- Manifest.read_identity_file(paths.identity, binding.realm),
         true <- pub == binding.record.service_key,
         {:ok, %{size: size}} when size <= 4096 <- File.lstat(paths.identity),
         {:ok, identity_bytes} when byte_size(identity_bytes) <= 4096 <- File.read(paths.identity),
         {:ok, ports} <- ports(opts),
         :ok <- deployment_apart(paths, pub),
         {:ok, material} <-
           material(bundle, binding, paths, ports, Journal.digest(identity_bytes)),
         :ok <-
           persist(paths.output, material.files, material.index, fn ->
             reread(material, binding, bundle, paths)
           end) do
      {:ok,
       %{
         index: Path.join(paths.output, @index),
         request: material.request,
         artifacts: material.artifacts,
         active_manifest: material.request.active_manifest
       }}
    else
      _ -> {:error, :initial_provisioning_refused}
    end
  rescue
    _ -> {:error, :initial_provisioning_refused}
  catch
    _, _ -> {:error, :initial_provisioning_refused}
  end

  @spec client_realm(binary()) :: String.t()
  def client_realm(<<_::256>> = key),
    do: "treehouse-client:" <> Base.url_encode64(key, padding: false)

  defp paths(opts) do
    names = [
      bundle: :bundle,
      ceremony: :ceremony,
      output: :output,
      operator: :operator_root,
      identity: :identity_file
    ]

    paths =
      Map.new(names, fn {name, option} -> {name, Path.expand(Keyword.fetch!(opts, option))} end)

    parent = Path.dirname(paths.output)

    with true <- Paths.real(parent) == parent,
         true <- paths.output != paths.operator,
         false <- String.starts_with?(paths.output, paths.operator <> "/"),
         false <- String.starts_with?(paths.operator, paths.output <> "/"),
         :ok <- Paths.ancestors_safe(parent, :unsafe_output, include_self: true) do
      {:ok, paths}
    else
      _ -> :error
    end
  end

  defp ports(opts) do
    space = Keyword.get(opts, :space_port, 0)
    child = Keyword.get(opts, :thread_port, 0)

    if is_integer(space) and is_integer(child) and space in 0..65535 and child in 0..65535 and
         (space == 0 or space != child), do: {:ok, {space, child}}, else: :error
  end

  defp deployment_apart(paths, pub) do
    case File.lstat(paths.output) do
      {:error, :enoent} ->
        # A new initial import precedes the first controlled boot. A stale
        # marker is recovery evidence too; never erase it to obtain first use.
        with {:error, :enoent} <- File.lstat(Path.join(paths.operator, "operator-incarnation")) do
          runtime_apart(paths, pub)
        else
          _ -> :error
        end

      # persist/4 only re-reads an exact completed inventory.
      {:ok, %{type: :directory}} ->
        :ok

      _ ->
        :error
    end
  end

  defp runtime_apart(paths, pub) do
    case Runtime.deployment() do
      nil ->
        :ok

      %{manifest_path: path} ->
        with false <- String.starts_with?(Path.expand(path), paths.output <> "/"),
             {:ok, manifest} <- Manifest.load(path),
             false <- Enum.any?(manifest.instances, &(&1.pub == pub)) do
          :ok
        else
          _ -> :error
        end

      _ ->
        :error
    end
  end

  defp material(bundle, binding, paths, {space_port, child_port}, identity_sha) do
    space_bytes = Log.dump_bytes(bundle.space)
    child_bytes = Log.dump_bytes(bundle.child)

    context = %{
      "domain" => "treehouse-initial-import-v1",
      "bundle" => Journal.digest(bundle.bytes),
      "output" => paths.output,
      "operator" => paths.operator,
      "identity" => paths.identity
    }

    attempt =
      context
      |> InitialBundle.canonical()
      |> then(&:crypto.hash(:sha256, &1))
      |> Base.url_encode64(padding: false)

    child_target = Staging.artifact_path(paths.operator, attempt, Journal.digest(child_bytes))
    space_path = Path.join(paths.output, "space.log")

    initial =
      instance(
        "space",
        space_path,
        bundle.space,
        bundle.roster,
        paths.identity,
        binding.realm,
        space_port
      )

    child =
      instance(
        "thread",
        child_target,
        bundle.child,
        bundle.roster,
        paths.identity,
        binding.realm,
        child_port
      )

    active = InitialBundle.canonical(%{"version" => 1, "instances" => [initial]})
    candidate = InitialBundle.canonical(%{"version" => 1, "instances" => [initial, child]})
    reference = bundle.reference |> Lattice.Carrier.Wire.encode_op() |> InitialBundle.canonical()

    artifacts = [
      %{
        kind: :log,
        bytes: child_bytes,
        replica: bundle.child.replica,
        op_id: bundle.child_genesis,
        review: bundle.child_review
      },
      %{
        kind: :reference,
        bytes: reference,
        replica: bundle.space.replica,
        op_id: bundle.reference.id,
        review: %{"mode" => "initial_existing"}
      },
      %{kind: :manifest, bytes: candidate, replica: nil, op_id: nil, review: nil}
    ]

    request = %{
      active_manifest: Path.join(paths.output, "initial.manifest.json"),
      attempt: attempt,
      generation: 1,
      catalog_head: nil,
      manifest_digest: Journal.digest(active)
    }

    files = %{
      "space.log" => space_bytes,
      "thread.log" => child_bytes,
      "initial.manifest.json" => active,
      "candidate.manifest.json" => candidate,
      "reference.json" => reference,
      "review.json" => InitialBundle.canonical(bundle.child_review)
    }

    index =
      InitialBundle.canonical(%{
        "format" => "treehouse-initial-import-index-v1",
        "bundleSha256" => Journal.digest(bundle.bytes),
        "bootstrapId" => binding.bootstrap_id,
        "identitySha256" => identity_sha,
        "operatorRoot" => paths.operator,
        "attempt" => attempt,
        "files" => Map.new(files, fn {name, bytes} -> {name, Journal.digest(bytes)} end)
      })

    {:ok, %{files: files, index: index, request: request, artifacts: artifacts}}
  end

  defp instance(name, log_path, log, roster, identity_file, realm, port) do
    peers =
      [Base.encode64(Authority.root(log)) | roster]
      |> Enum.uniq()
      |> Enum.sort()
      |> Enum.map(fn key -> %{"realm" => client_realm(Base.decode64!(key)), "pubkey" => key} end)

    route =
      "/r/" <>
        Base.url_encode64(
          :crypto.hash(
            :sha256,
            InitialBundle.canonical(["treehouse-initial-route-v1", log.replica])
          ),
          padding: false
        )

    %{
      "name" => name,
      "realm" => realm,
      "identity_file" => identity_file,
      "log_file" => log_path,
      "listener" => %{"ip" => "127.0.0.1", "port" => port},
      "route" => route,
      "trusted_peers" => peers,
      "relay_realms" => Enum.map(peers, & &1["realm"])
    }
  end

  defp persist(output, files, index, verify) do
    case File.mkdir(output) do
      :ok ->
        with :ok <- File.chmod(output, 0o700),
             :ok <- Posix.sync_directory(Path.dirname(output)),
             :ok <- write_files(output, files),
             :ok <- check_files(output, files),
             :ok <- inventory(output, Map.keys(files)),
             :ok <- verify.(),
             :ok <- Posix.sync_directory(output),
             # The completion marker is never written for a partial inventory.
             {:ok, _} <-
               Paths.create_private(
                 Path.join(output, @index),
                 fn -> index end,
                 :output_exists,
                 :output_write_failed
               ),
             :ok <- Posix.sync_directory(output),
             do: :ok

      {:error, :eexist} ->
        with :ok <- private_directory(output),
             {:ok, names} <- File.ls(output),
             true <- Enum.sort(names) == Enum.sort([@index | Map.keys(files)]),
             :ok <- exact_file(Path.join(output, @index), index),
             :ok <- check_files(output, files),
             :ok <- verify.(),
             :ok <- sync_completed(output, [@index | Map.keys(files)]),
             do: :ok

      _ ->
        :error
    end
  end

  defp sync_completed(output, names) do
    result =
      Enum.reduce_while(names, :ok, fn name, :ok ->
        case Posix.sync_file(Path.join(output, name)) do
          :ok -> {:cont, :ok}
          _ -> {:halt, :error}
        end
      end)

    with :ok <- result, do: Posix.sync_directory(output)
  end

  defp inventory(output, expected) do
    with {:ok, names} <- File.ls(output), true <- Enum.sort(names) == Enum.sort(expected), do: :ok
  end

  defp write_files(output, files) do
    Enum.reduce_while(Enum.sort(files), :ok, fn {name, bytes}, :ok ->
      case Paths.create_private(
             Path.join(output, name),
             fn -> bytes end,
             :output_exists,
             :output_write_failed
           ) do
        {:ok, _} -> {:cont, :ok}
        _ -> {:halt, :error}
      end
    end)
  end

  defp check_files(output, files) do
    Enum.reduce_while(files, :ok, fn {name, bytes}, :ok ->
      case exact_file(Path.join(output, name), bytes) do
        :ok -> {:cont, :ok}
        _ -> {:halt, :error}
      end
    end)
  end

  defp private_directory(path) do
    with {:ok, %{type: :directory, uid: uid, mode: mode}} <- File.lstat(path),
         true <- uid == Paths.uid() and band(mode, 0o7777) == 0o700,
         do: :ok
  end

  defp exact_file(path, expected) do
    with {:ok, %{type: :regular, links: 1, uid: uid, mode: mode, size: size}} <- File.lstat(path),
         true <-
           uid == Paths.uid() and band(mode, 0o7777) == 0o600 and size == byte_size(expected),
         {:ok, ^expected} <- File.read(path),
         do: :ok
  end

  defp reread(material, binding, bundle, paths) do
    with {:ok, %{log: space}} <- Log.restore_verified(Path.join(paths.output, "space.log")),
         true <- space == bundle.space,
         {:ok, %{log: child}} <- Log.restore_verified(Path.join(paths.output, "thread.log")),
         true <- child == bundle.child,
         {:ok, manifest} <- Manifest.load(material.request.active_manifest),
         [instance] <- manifest.instances,
         true <- instance.pub == binding.record.service_key and instance.realm == binding.realm,
         {:ok, rebound} <- CatalogBinding.load_log(paths.ceremony, space),
         true <- rebound.bootstrap_id == binding.bootstrap_id,
         do: :ok
  end
end
