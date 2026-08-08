defmodule LatticeCarrierServer.Listener do
  @moduledoc false

  alias LatticeCarrierServer.SocketOpts

  @spec ref(term()) :: term()
  def ref(instance), do: {__MODULE__, instance}

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

    :ranch.child_spec(ref(instance), :ranch_tcp, transport_opts, :cowboy_clear, protocol_opts)
  end
end
