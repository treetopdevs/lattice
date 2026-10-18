defmodule LatticeCarrierServer.ProbeRealm do
  @moduledoc """
  Ephemeral, single-use, read-only operator probe grants (plan 223, D-22).

  An operator call running inside this BEAM registers the public key of a probe
  identity for one admitted instance, connects once through the reserved realm
  `lattice-operator-probe`, and revokes the grant. A grant is `{instance,
  grant_ref, pubkey, deadline}` in an ETS table owned by a supervised process;
  nothing is persisted and no manifest field exists for it. Grants hold public
  keys only. The server consumes a grant with an exact compare-and-delete after
  the challenge verifies, so one grant admits at most one session, and that
  session may only read (`WebSocket` refuses every other request).
  """

  @realm "lattice-operator-probe"
  @table __MODULE__
  @ttl_ms 10_000

  alias LatticeCarrierServer.Runtime

  @type reason ::
          :readiness_probe_busy
          | :readiness_probe_key_reused
          | :readiness_probe_realm_collision
          | :readiness_probe_unknown_instance

  @spec realm() :: String.t()
  def realm, do: @realm

  @doc false
  @spec table() :: atom()
  def table, do: @table

  @doc """
  Register a grant for `instance_name`, checked deployment-wide from the running
  `Runtime`. Returns the opaque grant reference to revoke.
  """
  @spec register(String.t(), binary()) :: {:ok, reference()} | {:error, reason()}
  def register(instance_name, pubkey) when is_binary(instance_name) and is_binary(pubkey) do
    views = Runtime.instance_views()

    with :ok <- known_instance(views, instance_name),
         :ok <- key_unused(views, pubkey),
         :ok <- realm_free(views),
         {:ok, ref} <- insert(instance_name, pubkey) do
      {:ok, ref}
    end
  end

  @doc "Remove exactly this grant. Idempotent."
  @spec revoke(String.t(), reference()) :: :ok
  def revoke(instance, grant_ref) do
    _ = safe(fn -> :ets.select_delete(@table, [{{instance, grant_ref, :_, :_}, [], [true]}]) end)
    :ok
  end

  @doc false
  @spec live_grant(term()) :: {reference(), binary()} | nil
  def live_grant(instance) do
    now = now()

    case safe(fn -> :ets.lookup(@table, instance) end) do
      [{^instance, ref, pubkey, deadline}] when deadline > now -> {ref, pubkey}
      _other -> nil
    end
  end

  @doc false
  @spec consume(term(), reference()) :: :ok | :error
  def consume(instance, grant_ref) do
    now = now()

    spec = [{{instance, grant_ref, :_, :"$1"}, [{:>, :"$1", now}], [true]}]

    case safe(fn -> :ets.select_delete(@table, spec) end) do
      1 -> :ok
      _other -> :error
    end
  end

  defp known_instance(views, name) do
    if Enum.any?(views, &(&1.name == name)),
      do: :ok,
      else: {:error, :readiness_probe_unknown_instance}
  end

  defp key_unused(views, pubkey) do
    reused? =
      Enum.any?(views, fn view ->
        view.pub == pubkey or pubkey in Map.values(view.trusted_peers)
      end)

    if reused?, do: {:error, :readiness_probe_key_reused}, else: :ok
  end

  defp realm_free(views) do
    collides? =
      Enum.any?(views, fn view ->
        view.realm == @realm or Map.has_key?(view.trusted_peers, @realm)
      end)

    if collides?, do: {:error, :readiness_probe_realm_collision}, else: :ok
  end

  # One live grant per instance; an expired grant may be replaced. The replace
  # deletes only the exact expired object, then insert_new decides the race.
  defp insert(instance, pubkey) do
    ref = make_ref()
    now = now()
    object = {instance, ref, pubkey, now + @ttl_ms}

    try do
      :ets.select_delete(@table, [{{instance, :_, :_, :"$1"}, [{:"=<", :"$1", now}], [true]}])

      if :ets.insert_new(@table, object),
        do: {:ok, ref},
        else: {:error, :readiness_probe_busy}
    rescue
      ArgumentError -> {:error, :readiness_probe_unknown_instance}
    end
  end

  defp now, do: System.monotonic_time(:millisecond)

  defp safe(fun) do
    fun.()
  rescue
    ArgumentError -> nil
  end

  defmodule Owner do
    @moduledoc false
    use GenServer

    @spec start_link(keyword()) :: GenServer.on_start()
    def start_link(_opts), do: GenServer.start_link(__MODULE__, nil)

    @impl GenServer
    def init(nil) do
      :ets.new(LatticeCarrierServer.ProbeRealm.table(), [
        :named_table,
        :public,
        :set,
        read_concurrency: true
      ])

      {:ok, nil}
    end
  end
end
