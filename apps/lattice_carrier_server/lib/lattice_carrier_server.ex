defmodule LatticeCarrierServer do
  @moduledoc """
  Supervised carrier server for one configured replica log.

  The server is read-only by default: authenticated transport realms may request
  frontier and pull data. Path-backed instances may opt selected trusted realms
  into relaying already-signed operations. Changed relays are acknowledged only
  after a temporary dump is synced and atomically renamed. This is process-crash
  durability, not power-loss durability: the parent directory is not synced and
  macOS `F_FULLFSYNC` is not requested. The server never authors operations or
  decides their semantic authority.
  """

  use Supervisor

  alias Lattice.Identity
  alias LatticeCarrierServer.{Holder, Listener}

  @type instance :: term()

  @spec start_link(keyword()) :: Supervisor.on_start()
  def start_link(opts) do
    relay_realms = Keyword.get(opts, :relay_realms, [])
    trusted_peers = Keyword.get(opts, :trusted_peers)
    opts = Keyword.put(opts, :relay_realms, relay_realms)

    with :ok <- validate_identity(Keyword.get(opts, :identity)),
         :ok <- validate_trusted_peers(trusted_peers),
         :ok <- validate_relay_realms(relay_realms, trusted_peers, Keyword.get(opts, :source)) do
      Supervisor.start_link(__MODULE__, opts)
    end
  end

  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(opts) do
    instance = Keyword.get(opts, :instance, :default)

    %{
      id: {__MODULE__, instance},
      start: {__MODULE__, :start_link, [opts]},
      type: :supervisor
    }
  end

  @spec port(instance()) :: :inet.port_number()
  def port(instance \\ :default) do
    instance
    |> Listener.ref()
    |> :ranch.get_port()
  end

  @impl Supervisor
  def init(opts) do
    instance = Keyword.get(opts, :instance, :default)
    identity = Keyword.fetch!(opts, :identity)
    trusted_peers = Keyword.fetch!(opts, :trusted_peers)
    relay_realms = Keyword.fetch!(opts, :relay_realms)
    source = Keyword.fetch!(opts, :source)
    listener_opts = Keyword.get(opts, :listener, [])
    holder = Holder.via(instance)

    children = [
      {Holder, name: holder, identity: identity, source: source, relay_realms: relay_realms},
      Listener.child_spec(
        instance: instance,
        holder: holder,
        trusted_peers: trusted_peers,
        listener: listener_opts
      )
    ]

    Supervisor.init(children, strategy: :rest_for_one)
  end

  defp validate_identity(%Identity{realm_id: realm, pub: pub, priv: priv})
       when is_binary(realm) and byte_size(realm) > 0 and byte_size(pub) == 32 and
              byte_size(priv) == 32,
       do: :ok

  defp validate_identity(_identity), do: {:error, {:invalid_config, :identity}}

  defp validate_trusted_peers(peers) when is_map(peers) and map_size(peers) > 0 do
    if Enum.all?(peers, fn
         {realm, pub} when is_binary(realm) and byte_size(realm) > 0 and byte_size(pub) == 32 ->
           true

         _peer ->
           false
       end) do
      :ok
    else
      {:error, {:invalid_config, :trusted_peers}}
    end
  end

  defp validate_trusted_peers(_peers), do: {:error, {:invalid_config, :trusted_peers}}

  defp validate_relay_realms([], _trusted_peers, _source), do: :ok

  defp validate_relay_realms(realms, trusted_peers, {:path, path})
       when is_list(realms) and is_map(trusted_peers) and is_binary(path) do
    valid_realms? =
      Enum.all?(realms, fn realm ->
        is_binary(realm) and byte_size(realm) > 0 and Map.has_key?(trusted_peers, realm)
      end)

    if valid_realms?, do: :ok, else: {:error, {:invalid_config, :relay_realms}}
  end

  defp validate_relay_realms(_realms, _trusted_peers, _source) do
    {:error, {:invalid_config, :relay_realms}}
  end
end
