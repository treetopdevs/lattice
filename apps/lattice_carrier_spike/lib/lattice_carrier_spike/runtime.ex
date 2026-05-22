defmodule LatticeCarrierSpike.Runtime do
  @moduledoc """
  Runtime helpers for the WebSocket distribution carrier spike.

  These helpers expect the VM to be launched with
  `--erl "-proto_dist Elixir.TCPFilter"` before `Node.start/1`.
  """

  alias LatticeCarrierSpike.Filter

  def proto_dist_enabled? do
    case :init.get_argument(:proto_dist) do
      {:ok, args} ->
        args
        |> inspect()
        |> String.contains?("Elixir.TCPFilter")

      _other ->
        false
    end
  end

  def start_tcp_filter(opts \\ []) do
    name = Keyword.get(opts, :name, TCPFilter)

    case Process.whereis(name) do
      nil ->
        TCPFilter.start_link(
          filter: Keyword.get(opts, :filter, Filter),
          socket: Keyword.get(opts, :socket, WebSocketDist.WebSocket),
          name: name
        )

      pid ->
        TCPFilter.set_filter(Keyword.get(opts, :filter, Filter))
        TCPFilter.set_socket(Keyword.get(opts, :socket, WebSocketDist.WebSocket))
        {:ok, pid}
    end
  end

  def start_distribution(opts \\ []) do
    port = Keyword.get(opts, :port, 5_000)
    node_name = Keyword.get(opts, :node_name, :"lattice_carrier@127.0.0.1")
    cookie = opts |> Keyword.get(:cookie, :lattice_carrier_cookie) |> normalize_cookie()

    Application.put_env(:kernel, :inet_dist_listen_min, port)
    Application.put_env(:kernel, :inet_dist_listen_max, port)

    with {:ok, _pid} <- start_tcp_filter(opts),
         {:ok, node} <- ensure_node_started(node_name) do
      Node.set_cookie(node, cookie)
      {:ok, %{node: node, cookie: cookie, port: port}}
    end
  end

  defp ensure_node_started(node_name) do
    if Node.alive?() do
      {:ok, Node.self()}
    else
      case Node.start(node_name) do
        {:ok, _pid} -> {:ok, Node.self()}
        {:error, {:already_started, _pid}} -> {:ok, Node.self()}
        {:error, reason} -> {:error, reason}
      end
    end
  end

  defp normalize_cookie(cookie) when is_atom(cookie), do: cookie
  defp normalize_cookie(cookie) when is_binary(cookie), do: String.to_atom(cookie)
end
