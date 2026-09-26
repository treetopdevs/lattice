defmodule LatticeCarrierServer.Listener do
  @moduledoc false

  alias LatticeCarrierServer.Operator.ReleaseGate
  alias LatticeCarrierServer.SocketOpts

  @spec ref(term()) :: term()
  def ref(instance) do
    case LatticeCarrierServer.Runtime.deployment() do
      %{owner: owner, instances: instances} ->
        if Enum.any?(instances, &(&1.name == instance)),
          do: owned_ref(instance, owner),
          else: {__MODULE__, instance}

      _ ->
        {__MODULE__, instance}
    end
  end

  @doc false
  @spec owned_ref(term(), ReleaseGate.owner()) :: term()
  def owned_ref(instance, {_pid, incarnation}), do: {__MODULE__, instance, incarnation}

  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(opts) do
    instance = Keyword.fetch!(opts, :instance)
    holder = Keyword.fetch!(opts, :holder)
    trusted_peers = Keyword.fetch!(opts, :trusted_peers)
    listener_opts = Keyword.fetch!(opts, :listener)
    ip = Keyword.get(listener_opts, :ip, {127, 0, 0, 1})
    port = Keyword.get(listener_opts, :port, 4041)

    dispatch =
      :cowboy_router.compile([
        {:_,
         [
           {"/carrier", LatticeCarrierServer.WebSocket,
            %{holder: holder, trusted_peers: trusted_peers, authenticated?: false}}
         ]}
      ])

    transport_opts = %{
      connection_type: :supervisor,
      socket_opts: SocketOpts.build(ip, port)
    }

    protocol_opts = %{
      connection_type: :supervisor,
      env: %{dispatch: dispatch},
      idle_timeout: LatticeCarrierServer.WebSocket.authenticated_idle_timeout_ms(),
      max_header_name_length: 64,
      max_header_value_length: 4_096,
      max_headers: 64,
      max_request_line_length: 2_048,
      request_timeout: 5_000
    }

    {transport, transport_opts} =
      case Keyword.get(opts, :release_owner) do
        nil -> {:ranch_tcp, transport_opts}
        owner -> {__MODULE__.Transport, Map.put(transport_opts, :release_bind, {owner, instance})}
      end

    reference =
      case Keyword.get(opts, :release_owner) do
        nil -> {__MODULE__, instance}
        owner -> owned_ref(instance, owner)
      end

    spec = :ranch.child_spec(reference, transport, transport_opts, :cowboy_clear, protocol_opts)

    case Keyword.get(opts, :release_owner) do
      nil -> spec
      owner -> %{spec | start: {__MODULE__, :start_owned, [owner, instance, spec.start]}}
    end
  end

  @doc false
  @spec start_owned(ReleaseGate.owner(), term(), {module(), atom(), list()}) ::
          Supervisor.on_start()
  def start_owned(owner, instance, {module, function, args}) do
    with {:ok, lease} <- ReleaseGate.acquire(owner, {:listener, instance}) do
      case apply(module, function, args) do
        {:ok, listener} ->
          case ReleaseGate.complete(owner, lease, {:listener, instance}, listener) do
            :ok ->
              {:ok, listener}

            error ->
              Supervisor.stop(listener)
              error
          end

        error ->
          ReleaseGate.abandon(owner, lease)
          error
      end
    end
  end
end

defmodule LatticeCarrierServer.Listener.Transport do
  @moduledoc false
  @behaviour :ranch_transport
  alias LatticeCarrierServer.Operator.ReleaseGate

  @impl true
  def listen(%{release_bind: {owner, instance}} = opts) do
    with {:ok, lease} <- ReleaseGate.acquire(owner, {:bind, instance}) do
      case :ranch_tcp.listen(Map.delete(opts, :release_bind)) do
        {:ok, socket} ->
          case ReleaseGate.finish(owner, lease) do
            :ok ->
              {:ok, socket}

            error ->
              :ranch_tcp.close(socket)
              error
          end

        error ->
          ReleaseGate.abandon(owner, lease)
          error
      end
    end
  end

  def listen(_), do: {:error, :release_closed}
  @impl true
  def name, do: :ranch_tcp.name()
  @impl true
  def secure, do: :ranch_tcp.secure()
  @impl true
  def messages, do: :ranch_tcp.messages()
  @impl true
  def accept(arg0, arg1), do: :ranch_tcp.accept(arg0, arg1)
  @impl true
  def handshake(arg0, arg1), do: :ranch_tcp.handshake(arg0, arg1)
  @impl true
  def handshake(arg0, arg1, arg2), do: :ranch_tcp.handshake(arg0, arg1, arg2)
  @impl true
  def handshake_continue(arg0, arg1), do: :ranch_tcp.handshake_continue(arg0, arg1)
  @impl true
  def handshake_continue(arg0, arg1, arg2), do: :ranch_tcp.handshake_continue(arg0, arg1, arg2)
  @impl true
  def handshake_cancel(arg0), do: :ranch_tcp.handshake_cancel(arg0)
  @impl true
  def connect(arg0, arg1, arg2), do: :ranch_tcp.connect(arg0, arg1, arg2)
  @impl true
  def connect(arg0, arg1, arg2, arg3), do: :ranch_tcp.connect(arg0, arg1, arg2, arg3)
  @impl true
  def recv(arg0, arg1, arg2), do: :ranch_tcp.recv(arg0, arg1, arg2)
  @impl true
  def recv_proxy_header(arg0, arg1), do: :ranch_tcp.recv_proxy_header(arg0, arg1)
  @impl true
  def send(arg0, arg1), do: :ranch_tcp.send(arg0, arg1)
  @impl true
  def sendfile(arg0, arg1), do: :ranch_tcp.sendfile(arg0, arg1)
  @impl true
  def sendfile(arg0, arg1, arg2, arg3), do: :ranch_tcp.sendfile(arg0, arg1, arg2, arg3)
  @impl true
  def sendfile(arg0, arg1, arg2, arg3, arg4),
    do: :ranch_tcp.sendfile(arg0, arg1, arg2, arg3, arg4)

  @impl true
  def setopts(arg0, arg1), do: :ranch_tcp.setopts(arg0, arg1)
  @impl true
  def getopts(arg0, arg1), do: :ranch_tcp.getopts(arg0, arg1)
  @impl true
  def getstat(arg0), do: :ranch_tcp.getstat(arg0)
  @impl true
  def getstat(arg0, arg1), do: :ranch_tcp.getstat(arg0, arg1)
  @impl true
  def controlling_process(arg0, arg1), do: :ranch_tcp.controlling_process(arg0, arg1)
  @impl true
  def peername(arg0), do: :ranch_tcp.peername(arg0)
  @impl true
  def sockname(arg0), do: :ranch_tcp.sockname(arg0)
  @impl true
  def shutdown(arg0, arg1), do: :ranch_tcp.shutdown(arg0, arg1)
  @impl true
  def close(arg0), do: :ranch_tcp.close(arg0)
  @impl true
  def cleanup(arg0), do: :ranch_tcp.cleanup(arg0)
  @impl true
  def format_error(arg0), do: :ranch_tcp.format_error(arg0)
end
