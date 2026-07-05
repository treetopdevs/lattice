defmodule LatticeNodeSpike.PeerServer do
  @moduledoc """
  Starts the Cowboy listener that serves `LatticeNodeSpike.WsHandler` at
  `/carrier` on an OS-assigned port (`port: 0`), so concurrent runs never
  collide. Returns the actual port for the parent process to print/advertise.
  """

  @listener :lattice_node_spike_listener

  @spec start(pid() | atom()) :: {:ok, :inet.port_number()}
  def start(peer) do
    dispatch =
      :cowboy_router.compile([
        {:_, [{"/carrier", LatticeNodeSpike.WsHandler, %{peer: peer}}]}
      ])

    {:ok, _pid} =
      :cowboy.start_clear(@listener, [port: 0], %{env: %{dispatch: dispatch}})

    {:ok, :ranch.get_port(@listener)}
  end

  @spec stop() :: :ok | {:error, :not_found}
  def stop, do: :cowboy.stop_listener(@listener)
end
