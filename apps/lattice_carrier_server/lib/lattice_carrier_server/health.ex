defmodule LatticeCarrierServer.Health do
  @moduledoc """
  Loopback health listener for the pilot carrier runtime (plan 158).

  `/livez` is unauthenticated liveness: 200 whenever the VM answers HTTP.
  `/readyz` is content-free readiness: 204 only when every manifest instance
  has its identity loaded and source restore complete (the holder answers),
  its carrier listener bound, and writable durable storage proven by a full
  durability-sequence rehearsal in the log's directory; otherwise 503. Both
  responses carry an empty body — readiness detail never leaks content.
  `/carrier` application authentication is a separate listener and is
  unchanged.
  """

  alias LatticeCarrierServer.{Durability, Holder, Listener, Runtime}

  @listener_ref {__MODULE__, :listener}

  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(health_opts) do
    ip = Keyword.fetch!(health_opts, :ip)
    port = Keyword.fetch!(health_opts, :port)

    dispatch =
      :cowboy_router.compile([
        {:_,
         [
           {"/livez", __MODULE__, :livez},
           {"/readyz", __MODULE__, :readyz}
         ]}
      ])

    transport_opts = %{socket_opts: [ip: ip, port: port]}

    protocol_opts = %{
      env: %{dispatch: dispatch},
      max_header_name_length: 64,
      max_header_value_length: 4_096,
      max_headers: 64,
      max_request_line_length: 2_048,
      request_timeout: 5_000
    }

    :ranch.child_spec(@listener_ref, :ranch_tcp, transport_opts, :cowboy_clear, protocol_opts)
  end

  @doc "Bound health port, or nil when no health listener is running."
  @spec port() :: :inet.port_number() | nil
  def port do
    :ranch.get_port(@listener_ref)
  catch
    _kind, _reason -> nil
  end

  @doc false
  def init(req, :livez) do
    {:ok, :cowboy_req.reply(200, %{}, "", req), :livez}
  end

  def init(req, :readyz) do
    status = if ready?(), do: 204, else: 503
    {:ok, :cowboy_req.reply(status, %{}, "", req), :readyz}
  end

  @doc """
  True only when every manifest instance is ready: holder answering
  (identity loaded, source restored), listener bound, and durable storage
  writable through the full rehearsal sequence.
  """
  @spec ready?() :: boolean()
  def ready? do
    case Runtime.deployment() do
      nil -> false
      %{instances: instances} -> Enum.all?(instances, &instance_ready?/1)
    end
  end

  defp instance_ready?(%{name: name, log_file: log_file}) do
    holder_ready?(name) and listener_bound?(name) and storage_writable?(log_file)
  end

  defp holder_ready?(name) do
    Holder.ready?(Holder.via(name)) == :ok
  catch
    _kind, _reason -> false
  end

  defp listener_bound?(name) do
    name |> Listener.ref() |> :ranch.get_port() |> is_integer()
  catch
    _kind, _reason -> false
  end

  defp storage_writable?(log_file) do
    Durability.rehearse(Durability.Posix, Path.dirname(log_file)) == :ok
  end
end
