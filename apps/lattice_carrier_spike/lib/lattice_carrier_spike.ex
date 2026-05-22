defmodule LatticeCarrierSpike do
  @moduledoc """
  Research spike for a browser BEAM carrier boundary.

  This application is deliberately separate from the main JSON WebSocket demo.
  It explores the minimum safe shape for `web_socket_dist`: a fail-closed
  distribution filter and a single logical gateway process that still routes
  all authority through `Lattice.Gateway`.
  """

  alias LatticeCarrierSpike.{BrowserGateway, Filter, Message}

  @gateway_name :lattice_browser_gateway

  def gateway_name, do: @gateway_name

  def logical_call_frame(attrs) when is_map(attrs) do
    attrs
    |> Map.put_new(:type, "lattice_call")
    |> Map.put_new(:reply_to, "lattice_browser_agent")
    |> Jason.encode!()
    |> to_charlist()
  end

  def hostile_frames do
    [
      {:registered_name_send, {:reg_send, self(), :unused, Lattice.CapStore},
       {:"$gen_call", {self(), make_ref()}, :snapshot}},
      {:pid_send, {:send, :unused, self()}, {:lattice_call, :ambient_pid_send}},
      {:rpc_shape, {:reg_send, self(), :unused, @gateway_name},
       {:rpc, Lattice, :diagnostics, []}},
      {:spawn_request, {:spawn_request, make_ref(), self(), self(), {Lattice, :diagnostics, 0}},
       []}
    ]
  end

  defdelegate decode_frame(frame), to: Message, as: :decode
  defdelegate filter(control_message, message), to: Filter
  defdelegate filter(control_message), to: Filter
  defdelegate start_gateway(opts), to: BrowserGateway, as: :start_link
end
