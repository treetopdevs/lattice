defmodule TownshipWeb.InstrumentLive do
  @moduledoc false

  use TownshipWeb, :live_view

  alias TownshipWeb.{CarrierProjection, InstrumentSource}

  @impl true
  def mount(_params, _session, socket) do
    case configured_projection(socket) do
      {:ok, projection_state} -> {:ok, apply_projection(socket, projection_state)}
      :disabled -> load_snapshot(socket)
    end
  end

  @impl true
  def handle_info({:township_instrument, projection_state}, socket) do
    {:noreply, apply_projection(socket, projection_state)}
  end

  defp configured_projection(socket) do
    with true <- connected?(socket),
         server when not is_nil(server) <- projection_server() do
      subscribe_projection(server)
    else
      _disabled -> :disabled
    end
  end

  defp projection_server do
    Application.get_env(:township_web, :instrument_projection_server) ||
      default_projection_server()
  end

  defp default_projection_server do
    case Application.get_env(:township_web, :instrument_projection_options) do
      opts when is_list(opts) -> CarrierProjection
      _not_configured -> nil
    end
  end

  defp subscribe_projection(server) do
    CarrierProjection.subscribe(server)
  catch
    :exit, {:noproc, _call} -> {:ok, {:unavailable, {:projection_absent, server}}}
  end

  defp load_snapshot(socket) do
    case InstrumentSource.load() do
      {:ok, payload} ->
        {:ok, assign_payload(socket, :verified, payload)}

      {:error, {:bundle_unverified, errors}} ->
        {:ok, assign_unavailable(socket, :bundle, errors)}
    end
  end

  defp apply_projection(socket, :connecting) do
    assign(socket,
      page_title: "Township Instrument Connecting",
      source_state: :connecting
    )
  end

  defp apply_projection(socket, {:fresh, payload}), do: assign_payload(socket, :fresh, payload)
  defp apply_projection(socket, {:stale, payload}), do: assign_payload(socket, :stale, payload)

  defp apply_projection(socket, {:unavailable, reason}) do
    assign_unavailable(socket, :carrier, [format_source_error(reason)])
  end

  defp assign_payload(socket, source_state, payload) do
    assign(socket,
      page_title: "Township Instrument",
      source_state: source_state,
      model: payload.read_model,
      causal_replay: payload.causal_replay,
      provenance: payload.provenance,
      op_counts: op_counts(payload.read_model.op_dag.nodes)
    )
  end

  defp assign_unavailable(socket, source_kind, errors) do
    assign(socket,
      page_title: "Township Instrument Unavailable",
      source_state: :unverified,
      source_kind: source_kind,
      source_errors: errors
    )
  end

  defp source_label(:verified), do: "verified snapshot"
  defp source_label(:fresh), do: "carrier fresh"
  defp source_label(:stale), do: "carrier stale"
  defp source_label(:connecting), do: "carrier connecting"
  defp source_label(:unverified), do: "source unavailable"

  defp unavailable_copy(:carrier), do: "The configured carrier peer is unavailable."

  defp unavailable_copy(:bundle) do
    "The audit bundle did not verify. No Township state, authority, attestation, or graph data has been rendered."
  end

  defp format_source_error(reason) when is_binary(reason), do: reason
  defp format_source_error({:projection_absent, _server}), do: "projection process is not running"
  defp format_source_error(reason) when is_atom(reason), do: ":#{reason}"
  defp format_source_error(_reason), do: "carrier source unavailable"

  defp format_last_error(reason) when is_atom(reason), do: ":#{reason}"

  defp format_last_error({:peer_regression, ids}) when is_list(ids) do
    shown = ids |> Enum.filter(&is_binary/1) |> Enum.take(3) |> Enum.map(&String.slice(&1, 0, 12))
    remaining = max(length(ids) - length(shown), 0)
    suffix = if remaining > 0, do: " +#{remaining} more", else: ""
    "peer regression: #{Enum.join(shown, ", ")}#{suffix}"
  end

  defp format_last_error({:incomplete_delivery, report}) when is_map(report) do
    rejected = report |> Map.get(:rejected, []) |> length()
    pending = report |> Map.get(:pending, []) |> length()
    "incomplete delivery: #{rejected} rejected, #{pending} pending"
  end

  defp format_last_error({:refresh_worker_down, _reason}), do: "refresh worker unavailable"
  defp format_last_error(_reason), do: "carrier error"

  defp op_counts(nodes) do
    %{
      total: length(nodes),
      honored: Enum.count(nodes, &(&1.status == "honored")),
      quarantined: Enum.count(nodes, &(&1.status == "quarantined"))
    }
  end
end
