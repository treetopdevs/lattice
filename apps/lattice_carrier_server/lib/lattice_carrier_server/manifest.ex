defmodule LatticeCarrierServer.Manifest do
  @moduledoc """
  Fail-closed loader for the pilot carrier deployment manifest.

  A manifest describes one supervised carrier deployment: one isolated
  `LatticeCarrierServer` instance per pilot replica, each bound to a loopback
  listener, plus an optional loopback health listener. Identity material is
  never inline: each instance names an identity secret file containing a
  32-byte Ed25519 private seed as 64 hex characters, readable only by the
  service user. A missing or corrupt manifest, identity file, or log file
  refuses startup — the runtime never mints a fresh identity or creates a new
  community.

  Every load error is `{:error, {:invalid_manifest, detail}}` where `detail`
  carries paths and atoms only, never secret bytes.
  """

  import Bitwise, only: [&&&: 2]

  alias Lattice.Identity
  alias LatticeCarrierServer.Secret

  defstruct [:health, :instances]

  @type instance :: %{
          name: String.t(),
          realm: String.t(),
          identity: Secret.t(),
          pub: binary(),
          log_file: Path.t(),
          log_identity: {non_neg_integer(), non_neg_integer(), non_neg_integer()},
          listener: [ip: :inet.ip_address(), port: :inet.port_number()],
          trusted_peers: %{String.t() => binary()},
          relay_realms: [String.t()],
          state_reporter: module() | nil
        }

  @type t :: %__MODULE__{
          health: [ip: :inet.ip_address(), port: :inet.port_number()] | nil,
          instances: [instance()]
        }

  # Inline secret material is rejected outright: identity comes from
  # `identity_file` and nothing else. Argv/env seeds are unsupported.
  @forbidden_instance_keys ~w(seed identity_seed identity priv private_key secret)
  @max_instances 64

  # State reporters are named symbolically and resolved through this
  # whitelist; a manifest cannot inject an arbitrary module.
  @state_reporters %{"township" => Township.CarrierStateReport}

  @spec load(Path.t()) :: {:ok, t()} | {:error, {:invalid_manifest, term()}}
  def load(path) when is_binary(path) do
    base_dir = path |> Path.expand() |> Path.dirname()

    with {:ok, bytes} <- read_manifest(path),
         {:ok, decoded} <- decode_manifest(bytes),
         {:ok, manifest} <- parse(decoded, base_dir) do
      {:ok, manifest}
    else
      {:error, {:invalid_manifest, _detail} = reason} -> {:error, reason}
      {:error, detail} -> {:error, {:invalid_manifest, detail}}
    end
  end

  defp read_manifest(path) do
    case File.read(path) do
      {:ok, bytes} -> {:ok, bytes}
      {:error, reason} -> {:error, {:manifest_unreadable, path, reason}}
    end
  end

  defp decode_manifest(bytes) do
    case Jason.decode(bytes) do
      {:ok, decoded} when is_map(decoded) -> {:ok, decoded}
      _other -> {:error, :manifest_corrupt}
    end
  end

  defp parse(%{"version" => 1, "instances" => instances}, _base_dir)
       when is_list(instances) and length(instances) > @max_instances,
       do: {:error, :too_many_instances}

  defp parse(%{"version" => 1, "instances" => instances} = decoded, base_dir)
       when is_list(instances) and instances != [] do
    with {:ok, health} <- parse_health(Map.get(decoded, "health")),
         {:ok, parsed} <- parse_instances(instances, base_dir),
         :ok <- validate_unique(parsed) do
      {:ok, %__MODULE__{health: health, instances: parsed}}
    end
  end

  defp parse(%{"version" => version}, _base_dir) when version != 1,
    do: {:error, :unsupported_version}

  defp parse(_decoded, _base_dir), do: {:error, :manifest_corrupt}

  defp parse_health(nil), do: {:ok, nil}

  defp parse_health(%{"ip" => ip, "port" => port}) do
    with {:ok, address} <- parse_loopback_ip(ip, :health),
         {:ok, port} <- parse_port(port, :health) do
      {:ok, [ip: address, port: port]}
    end
  end

  defp parse_health(_health), do: {:error, {:invalid_listener, :health}}

  defp parse_instances(instances, base_dir) do
    instances
    |> Enum.reduce_while({:ok, []}, fn instance, {:ok, acc} ->
      case parse_instance(instance, base_dir) do
        {:ok, parsed} -> {:cont, {:ok, [parsed | acc]}}
        {:error, _detail} = error -> {:halt, error}
      end
    end)
    |> case do
      {:ok, parsed} -> {:ok, Enum.reverse(parsed)}
      error -> error
    end
  end

  defp parse_instance(instance, base_dir) when is_map(instance) do
    name = Map.get(instance, "name")

    with :ok <- reject_inline_secrets(instance, name),
         :ok <- require_string(name, {:invalid_instance_name, name}),
         :ok <- require_string(Map.get(instance, "realm"), {:invalid_realm, name}),
         {:ok, identity, pub} <-
           load_identity(Map.get(instance, "identity_file"), Map.get(instance, "realm"), base_dir),
         {:ok, log_file, log_identity} <-
           require_log(Map.get(instance, "log_file"), base_dir, name),
         {:ok, listener} <- parse_listener(Map.get(instance, "listener"), name),
         {:ok, trusted_peers} <- parse_trusted_peers(Map.get(instance, "trusted_peers"), name),
         {:ok, relay_realms} <-
           parse_relay_realms(Map.get(instance, "relay_realms", []), trusted_peers, name),
         {:ok, state_reporter} <- parse_state_reporter(Map.get(instance, "state_reporter"), name) do
      {:ok,
       %{
         name: name,
         realm: Map.fetch!(instance, "realm"),
         identity: identity,
         pub: pub,
         log_file: log_file,
         log_identity: log_identity,
         listener: listener,
         trusted_peers: trusted_peers,
         relay_realms: relay_realms,
         state_reporter: state_reporter
       }}
    end
  end

  defp parse_instance(_instance, _base_dir), do: {:error, :manifest_corrupt}

  defp reject_inline_secrets(instance, name) do
    case Enum.find(@forbidden_instance_keys, &Map.has_key?(instance, &1)) do
      nil -> :ok
      key -> {:error, {:inline_secret_rejected, name, key}}
    end
  end

  defp require_string(value, _detail) when is_binary(value) and byte_size(value) > 0, do: :ok
  defp require_string(_value, detail), do: {:error, detail}

  defp load_identity(identity_file, realm, base_dir)
       when is_binary(identity_file) and is_binary(realm) do
    path = resolve(identity_file, base_dir)

    with {:ok, stat} <- identity_stat(path),
         :ok <- identity_permissions(stat, path),
         {:ok, seed} <- identity_seed(path) do
      {pub, priv} = :crypto.generate_key(:eddsa, :ed25519, seed)
      identity = %Identity{realm_id: realm, pub: pub, priv: priv}
      {:ok, Secret.wrap(identity), pub}
    end
  end

  defp load_identity(_identity_file, _realm, _base_dir),
    do: {:error, :identity_file_required}

  defp identity_stat(path) do
    case File.stat(path) do
      {:ok, %File.Stat{type: :regular} = stat} -> {:ok, stat}
      {:ok, %File.Stat{}} -> {:error, {:identity_file_missing, path}}
      {:error, _reason} -> {:error, {:identity_file_missing, path}}
    end
  end

  # The identity file must be private to the service user: any group/other
  # permission bit refuses startup.
  defp identity_permissions(%File.Stat{mode: mode}, path) do
    if (mode &&& 0o077) == 0 do
      :ok
    else
      {:error, {:identity_file_permissions, path}}
    end
  end

  defp identity_seed(path) do
    with {:ok, contents} <- File.read(path),
         trimmed = String.trim(contents),
         true <- byte_size(trimmed) == 64,
         {:ok, seed} <- Base.decode16(trimmed, case: :mixed) do
      {:ok, seed}
    else
      # Never include file contents in the error: a partially corrupt file
      # may still hold recoverable secret bytes.
      _other -> {:error, {:identity_file_corrupt, path}}
    end
  end

  defp require_log(log_file, base_dir, name) when is_binary(log_file) do
    path = resolve(log_file, base_dir)

    case File.stat(path) do
      {:ok,
       %File.Stat{
         type: :regular,
         major_device: major_device,
         minor_device: minor_device,
         inode: inode
       }} ->
        {:ok, path, {major_device, minor_device, inode}}

      _other ->
        {:error, {:log_missing, name, path}}
    end
  end

  defp require_log(_log_file, _base_dir, name), do: {:error, {:log_missing, name, nil}}

  defp parse_listener(%{"ip" => ip, "port" => port}, name) do
    with {:ok, address} <- parse_loopback_ip(ip, name),
         {:ok, port} <- parse_port(port, name) do
      {:ok, [ip: address, port: port]}
    end
  end

  defp parse_listener(_listener, name), do: {:error, {:invalid_listener, name}}

  # Carrier instances serve loopback only; the public edge (TLS/WSS) is a
  # separate deployment concern (plan 158, WSS Deployment and Recovery).
  defp parse_loopback_ip(ip, name) when is_binary(ip) do
    case :inet.parse_address(String.to_charlist(ip)) do
      {:ok, {127, _b, _c, _d} = address} -> {:ok, address}
      {:ok, _address} -> {:error, {:listener_not_loopback, name}}
      {:error, _reason} -> {:error, {:invalid_listener, name}}
    end
  end

  defp parse_loopback_ip(_ip, name), do: {:error, {:invalid_listener, name}}

  defp parse_port(port, _name) when is_integer(port) and port >= 0 and port <= 65_535,
    do: {:ok, port}

  defp parse_port(_port, name), do: {:error, {:invalid_listener, name}}

  defp parse_trusted_peers(peers, name) when is_list(peers) and peers != [] do
    Enum.reduce_while(peers, {:ok, %{}}, fn
      %{"realm" => realm, "pubkey" => pubkey}, {:ok, acc}
      when is_binary(realm) and byte_size(realm) > 0 and is_binary(pubkey) ->
        with {:ok, decoded} <- Base.decode64(pubkey),
             true <- byte_size(decoded) == 32,
             false <- Map.has_key?(acc, realm) do
          {:cont, {:ok, Map.put(acc, realm, decoded)}}
        else
          _other -> {:halt, {:error, {:invalid_trusted_peer, name, realm}}}
        end

      _peer, {:ok, _acc} ->
        {:halt, {:error, {:invalid_trusted_peer, name, nil}}}
    end)
  end

  defp parse_trusted_peers(_peers, name), do: {:error, {:invalid_trusted_peers, name}}

  defp parse_relay_realms(realms, trusted_peers, name) when is_list(realms) do
    if Enum.all?(realms, &(is_binary(&1) and Map.has_key?(trusted_peers, &1))) do
      {:ok, realms}
    else
      {:error, {:invalid_relay_realms, name}}
    end
  end

  defp parse_relay_realms(_realms, _trusted_peers, name),
    do: {:error, {:invalid_relay_realms, name}}

  defp parse_state_reporter(nil, _name), do: {:ok, nil}

  # The raw supplied value is never embedded in the refusal reason: an
  # operator could accidentally paste a copied seed/secret into this field,
  # and pilot_node.exs inspects the whole refusal reason to stderr, so any
  # value included here would break the no-secret-echo property this
  # loader exists to guarantee. A symbolic reason only.
  defp parse_state_reporter(reporter, _name) when is_binary(reporter) do
    case Map.fetch(@state_reporters, reporter) do
      {:ok, module} -> {:ok, module}
      :error -> {:error, :unknown_state_reporter}
    end
  end

  defp parse_state_reporter(_reporter, _name), do: {:error, :unknown_state_reporter}

  defp validate_unique(instances) do
    names = Enum.map(instances, & &1.name)

    ports =
      instances
      |> Enum.map(&Keyword.fetch!(&1.listener, :port))
      |> Enum.reject(&(&1 == 0))

    # Two instances sharing one log_file would each independently restore
    # from and atomic_dump to that shared path, so an acknowledged relay
    # accepted by one instance could be silently overwritten and lost by the
    # other's next dump — refuse regardless of distinct names/ports.
    log_files = Enum.map(instances, & &1.log_file)
    log_identities = Enum.map(instances, & &1.log_identity)

    cond do
      Enum.uniq(names) != names -> {:error, :duplicate_instance_names}
      Enum.uniq(ports) != ports -> {:error, :duplicate_listener_ports}
      Enum.uniq(log_files) != log_files -> {:error, :duplicate_log_file}
      Enum.uniq(log_identities) != log_identities -> {:error, :duplicate_log_file}
      log_temp_namespace_collision?(log_files) -> {:error, :log_temp_namespace_collision}
      true -> :ok
    end
  end

  defp log_temp_namespace_collision?(log_files) do
    Enum.any?(log_files, fn log_file ->
      prefix = log_file <> ".tmp."
      Enum.any?(log_files, &(&1 != log_file and String.starts_with?(&1, prefix)))
    end)
  end

  defp resolve(path, base_dir), do: Path.expand(path, base_dir)
end
