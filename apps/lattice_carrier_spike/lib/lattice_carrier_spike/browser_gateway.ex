defmodule LatticeCarrierSpike.BrowserGateway do
  @moduledoc """
  Single registered process allowed by the browser-carrier distribution filter.
  """

  use GenServer

  alias LatticeCarrierSpike.Message

  @gateway_name LatticeCarrierSpike.gateway_name()

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, @gateway_name)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  def logical_call(pid, frame) do
    send(pid, frame)
    :ok
  end

  @impl true
  def init(opts) do
    {:ok,
     %{
       reply_to: Keyword.get(opts, :reply_to, :lattice_browser_agent),
       reply_nodes: Keyword.get(opts, :reply_nodes, fn -> Node.list(:hidden) end),
       replies: [],
       deny_count: 0
     }}
  end

  @impl true
  def handle_info(frame, state) do
    case Message.decode(frame) do
      {:ok, request} ->
        {reply, state} = handle_request(request, state)
        broadcast_reply(reply, state)
        {:noreply, put_reply(state, reply)}

      {:error, reason} ->
        Lattice.Audit.record(:browser_beam_carrier_denied, %{
          reason: reason,
          frame_type: frame |> elem_type() |> Atom.to_string()
        })

        {:noreply, %{state | deny_count: state.deny_count + 1}}
    end
  end

  @impl true
  def handle_call(:state, _from, state), do: {:reply, state, state}

  defp handle_request(request, state) do
    result = Lattice.call(request.tab_id, request.cap_id, request.payload)

    metadata = %{
      request_id: request.request_id,
      tab_id: request.tab_id,
      cap_id: request.cap_id
    }

    case result do
      {:ok, value} ->
        Lattice.Audit.record(:browser_beam_carrier_call, metadata)

        {%{
           type: "lattice_result",
           ok: true,
           request_id: request.request_id,
           result: normalize_result(value)
         }, state}

      {:error, reason} ->
        Lattice.Audit.record(
          :browser_beam_carrier_denied,
          Map.put(metadata, :reason, reason)
        )

        {%{
           type: "lattice_result",
           ok: false,
           request_id: request.request_id,
           error: inspect(reason)
         }, state}
    end
  end

  defp broadcast_reply(reply, state) do
    json = Jason.encode!(reply) |> to_charlist()

    state.reply_nodes.()
    |> Enum.each(fn node -> send({state.reply_to, node}, json) end)
  end

  defp put_reply(state, reply), do: %{state | replies: [reply | state.replies]}

  defp normalize_result({:ok, value}), do: normalize_result(value)
  defp normalize_result(value) when is_map(value), do: value
  defp normalize_result(value), do: inspect(value)

  defp elem_type(value) when is_tuple(value), do: elem(value, 0)
  defp elem_type(value) when is_binary(value), do: :binary
  defp elem_type(value) when is_list(value), do: :list
  defp elem_type(_value), do: :term
end
