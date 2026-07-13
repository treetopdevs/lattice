defmodule TownshipWeb.InstrumentLive do
  @moduledoc false

  use TownshipWeb, :live_view

  alias TownshipWeb.{ActionIntent, CarrierProjection, InstrumentSource}

  @impl true
  def mount(_params, _session, socket) do
    socket = initialize_action_intent(socket)

    case configured_projection(socket) do
      {:ok, projection_state} -> {:ok, apply_projection(socket, projection_state)}
      :disabled -> load_snapshot(socket)
    end
  end

  @impl true
  def handle_event(
        "prepare_post",
        %{"post" => %{"text" => text}},
        %{assigns: %{source_state: :fresh, provenance: %{replica: replica}}} = socket
      ) do
    case ActionIntent.post_url(replica, text) do
      {:ok, url} ->
        {:noreply,
         assign(socket,
           post_intent_form: post_intent_form(text),
           post_intent_url: url,
           post_intent_replica: replica,
           post_intent_error: nil
         )}

      {:error, reason} ->
        {:noreply,
         assign(socket,
           post_intent_form: post_intent_form(text),
           post_intent_url: nil,
           post_intent_replica: nil,
           post_intent_error: action_intent_error(reason)
         )}
    end
  end

  def handle_event("prepare_post", _params, socket) do
    {:noreply,
     assign(socket,
       post_intent_url: nil,
       post_intent_replica: nil,
       post_intent_error: "A fresh carrier snapshot is required before opening the app."
     )}
  end

  def handle_event(
        "prepare_summary_edit",
        %{"summary" => %{"text" => text}},
        %{assigns: %{source_state: :fresh, provenance: %{replica: replica}}} = socket
      ) do
    case ActionIntent.field_url(replica, :set_summary, text) do
      {:ok, url} ->
        {:noreply,
         socket
         |> clear_title_intent()
         |> assign(
           summary_intent_form: summary_intent_form(text),
           summary_intent_url: url,
           summary_intent_replica: replica,
           summary_intent_error: nil
         )}

      {:error, reason} ->
        {:noreply,
         socket
         |> clear_title_intent()
         |> assign(
           summary_intent_form: summary_intent_form(text),
           summary_intent_url: nil,
           summary_intent_replica: nil,
           summary_intent_error: action_intent_error(reason)
         )}
    end
  end

  def handle_event("prepare_summary_edit", _params, socket) do
    {:noreply, clear_summary_intent(socket)}
  end

  def handle_event(
        "prepare_title_edit",
        %{"title" => %{"text" => text}},
        %{assigns: %{source_state: :fresh, provenance: %{replica: replica}}} = socket
      ) do
    case ActionIntent.field_url(replica, :set_title, text) do
      {:ok, url} ->
        {:noreply,
         socket
         |> clear_summary_intent()
         |> assign(
           title_intent_form: title_intent_form(text),
           title_intent_url: url,
           title_intent_replica: replica,
           title_intent_error: nil
         )}

      {:error, reason} ->
        {:noreply,
         socket
         |> clear_summary_intent()
         |> assign(
           title_intent_form: title_intent_form(text),
           title_intent_url: nil,
           title_intent_replica: nil,
           title_intent_error: action_intent_error(reason)
         )}
    end
  end

  def handle_event("prepare_title_edit", _params, socket) do
    {:noreply, clear_title_intent(socket)}
  end

  def handle_event(
        "prepare_status_action",
        _params,
        %{
          assigns: %{
            source_state: :fresh,
            model: model,
            provenance: %{replica: replica}
          }
        } = socket
      ) do
    command = status_action_command(model)

    case ActionIntent.status_url(replica, command) do
      {:ok, url} ->
        {:noreply,
         assign(socket,
           status_intent_url: url,
           status_intent_command: command,
           status_intent_replica: replica
         )}

      {:error, _reason} ->
        {:noreply, clear_status_intent(socket)}
    end
  end

  def handle_event("prepare_status_action", _params, socket) do
    {:noreply, clear_status_intent(socket)}
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
    socket
    |> clear_action_intent()
    |> assign(
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
    socket
    |> retain_action_intent(source_state, payload.provenance.replica)
    |> retain_summary_intent(source_state, payload.provenance.replica)
    |> retain_title_intent(source_state, payload.provenance.replica)
    |> retain_status_intent(source_state, payload.read_model, payload.provenance.replica)
    |> assign(
      page_title: "Township Instrument",
      source_state: source_state,
      model: payload.read_model,
      causal_replay: payload.causal_replay,
      provenance: payload.provenance,
      op_counts: op_counts(payload.read_model.op_dag.nodes)
    )
  end

  defp assign_unavailable(socket, source_kind, errors) do
    socket
    |> clear_action_intent()
    |> assign(
      page_title: "Township Instrument Unavailable",
      source_state: :unverified,
      source_kind: source_kind,
      source_errors: errors
    )
  end

  defp initialize_action_intent(socket) do
    assign(socket,
      post_intent_form: post_intent_form(""),
      post_intent_url: nil,
      post_intent_replica: nil,
      post_intent_error: nil,
      summary_intent_form: summary_intent_form(""),
      summary_intent_url: nil,
      summary_intent_replica: nil,
      summary_intent_error: nil,
      title_intent_form: title_intent_form(""),
      title_intent_url: nil,
      title_intent_replica: nil,
      title_intent_error: nil,
      status_intent_url: nil,
      status_intent_command: nil,
      status_intent_replica: nil
    )
  end

  defp retain_action_intent(socket, :fresh, replica) do
    case socket.assigns.post_intent_replica do
      nil -> socket
      ^replica -> socket
      _other_replica -> clear_action_intent(socket)
    end
  end

  defp retain_action_intent(socket, _source_state, _replica), do: clear_action_intent(socket)

  defp retain_summary_intent(socket, :fresh, replica) do
    case socket.assigns.summary_intent_replica do
      nil -> socket
      ^replica -> socket
      _other_replica -> clear_summary_intent(socket)
    end
  end

  defp retain_summary_intent(socket, _source_state, _replica), do: clear_summary_intent(socket)

  defp retain_title_intent(socket, :fresh, replica) do
    case socket.assigns.title_intent_replica do
      nil -> socket
      ^replica -> socket
      _other_replica -> clear_title_intent(socket)
    end
  end

  defp retain_title_intent(socket, _source_state, _replica), do: clear_title_intent(socket)

  defp retain_status_intent(socket, :fresh, model, replica) do
    cond do
      is_nil(socket.assigns.status_intent_url) ->
        socket

      socket.assigns.status_intent_replica != replica ->
        clear_status_intent(socket)

      socket.assigns.status_intent_command != status_action_command(model) ->
        clear_status_intent(socket)

      true ->
        socket
    end
  end

  defp retain_status_intent(socket, _source_state, _model, _replica),
    do: clear_status_intent(socket)

  defp clear_action_intent(socket) do
    assign(socket,
      post_intent_form: post_intent_form(""),
      post_intent_url: nil,
      post_intent_replica: nil,
      post_intent_error: nil,
      summary_intent_form: summary_intent_form(""),
      summary_intent_url: nil,
      summary_intent_replica: nil,
      summary_intent_error: nil,
      title_intent_form: title_intent_form(""),
      title_intent_url: nil,
      title_intent_replica: nil,
      title_intent_error: nil,
      status_intent_url: nil,
      status_intent_command: nil,
      status_intent_replica: nil
    )
  end

  defp clear_status_intent(socket) do
    assign(socket,
      status_intent_url: nil,
      status_intent_command: nil,
      status_intent_replica: nil
    )
  end

  defp clear_summary_intent(socket) do
    assign(socket,
      summary_intent_form: summary_intent_form(""),
      summary_intent_url: nil,
      summary_intent_replica: nil,
      summary_intent_error: nil
    )
  end

  defp clear_title_intent(socket) do
    assign(socket,
      title_intent_form: title_intent_form(""),
      title_intent_url: nil,
      title_intent_replica: nil,
      title_intent_error: nil
    )
  end

  defp status_action_command(%{threads: %{clerk_locked?: true}}), do: :reopen_matter
  defp status_action_command(_model), do: :close_matter

  defp post_intent_form(text) when is_binary(text), do: to_form(%{"text" => text}, as: :post)
  defp post_intent_form(_text), do: post_intent_form("")

  defp summary_intent_form(text) when is_binary(text),
    do: to_form(%{"text" => text}, as: :summary)

  defp summary_intent_form(_text), do: summary_intent_form("")

  defp title_intent_form(text) when is_binary(text),
    do: to_form(%{"text" => text}, as: :title)

  defp title_intent_form(_text), do: title_intent_form("")

  defp action_intent_error(:invalid_text), do: "Write an update before opening the app."
  defp action_intent_error(:text_too_large), do: "Keep the update within 4096 UTF-8 bytes."
  defp action_intent_error(_reason), do: "The participant action could not be prepared."

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
