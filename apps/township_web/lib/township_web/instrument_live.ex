defmodule TownshipWeb.InstrumentLive do
  @moduledoc false

  use TownshipWeb, :live_view

  alias TownshipWeb.{ActionIntent, CarrierProjection, InstrumentSource}

  @intent_slots [
    post: %{
      kind: :form,
      forms: [%{assign: :post_intent_form, as: :post, field: "text"}],
      url: :post_intent_url,
      replica: :post_intent_replica,
      error: :post_intent_error,
      command: nil,
      error_replica: nil,
      fallback: {:error_message, "A fresh carrier snapshot is required before opening the app."}
    },
    summary: %{
      kind: :form,
      forms: [%{assign: :summary_intent_form, as: :summary, field: "text"}],
      url: :summary_intent_url,
      replica: :summary_intent_replica,
      error: :summary_intent_error,
      command: nil,
      error_replica: nil,
      sibling: :title,
      fallback: :clear
    },
    title: %{
      kind: :form,
      forms: [%{assign: :title_intent_form, as: :title, field: "text"}],
      url: :title_intent_url,
      replica: :title_intent_replica,
      error: :title_intent_error,
      command: nil,
      error_replica: nil,
      sibling: :summary,
      fallback: :clear
    },
    grant: %{
      kind: :form,
      forms: [%{assign: :grant_intent_form, as: :grant, field: "audience"}],
      url: :grant_intent_url,
      replica: :grant_intent_replica,
      error: :grant_intent_error,
      command: nil,
      error_replica: :replica,
      fallback: :clear
    },
    revoke: %{
      kind: :form,
      forms: [%{assign: :revoke_intent_form, as: :revoke, field: "delegation"}],
      url: :revoke_intent_url,
      replica: :revoke_intent_replica,
      error: :revoke_intent_error,
      command: nil,
      error_replica: :replica,
      fallback: :clear
    },
    roster: %{
      kind: :form,
      forms: [
        %{assign: :admit_intent_form, as: :admit, field: "member"},
        %{assign: :roster_intent_form, as: :roster, field: "member"}
      ],
      url: :roster_intent_url,
      replica: :roster_intent_replica,
      error: :roster_intent_error,
      command: :roster_intent_command,
      error_replica: :replica,
      fallback: :clear
    },
    status: %{
      kind: :model_status,
      forms: [],
      url: :status_intent_url,
      replica: :status_intent_replica,
      error: nil,
      command: :status_intent_command,
      error_replica: nil,
      fallback: :clear
    }
  ]

  @intent_slots_by_name Map.new(@intent_slots)
  @intent_events %{
    "prepare_post" => %{
      slot: :post,
      param: {"post", "text"},
      form: :post_intent_form,
      builder: :post
    },
    "prepare_summary_edit" => %{
      slot: :summary,
      param: {"summary", "text"},
      form: :summary_intent_form,
      builder: {:field, :set_summary}
    },
    "prepare_title_edit" => %{
      slot: :title,
      param: {"title", "text"},
      form: :title_intent_form,
      builder: {:field, :set_title}
    },
    "prepare_grant" => %{
      slot: :grant,
      param: {"grant", "audience"},
      form: :grant_intent_form,
      builder: :grant
    },
    "prepare_revoke" => %{
      slot: :revoke,
      param: {"revoke", "delegation"},
      form: :revoke_intent_form,
      builder: :revoke
    },
    "prepare_admit" => %{
      slot: :roster,
      param: {"admit", "member"},
      form: :admit_intent_form,
      builder: {:roster, :admit},
      command: :admit
    },
    "prepare_remove_member" => %{
      slot: :roster,
      param: {"roster", "member"},
      form: :roster_intent_form,
      builder: {:roster, :remove_member},
      command: :remove_member
    },
    "prepare_status_action" => %{
      slot: :status,
      param: :none,
      builder: :status,
      command: :derived
    }
  }
  @intent_event_names Map.keys(@intent_events)

  @impl true
  def mount(_params, _session, socket) do
    socket = initialize_action_intent(socket)

    case configured_projection(socket) do
      {:ok, projection_state} -> {:ok, apply_projection(socket, projection_state)}
      :disabled -> load_snapshot(socket)
    end
  end

  @impl true
  def handle_event(event, params, socket) when event in @intent_event_names do
    {:noreply, prepare_intent(socket, Map.fetch!(@intent_events, event), params)}
  end

  @impl true
  def handle_info({:township_instrument, projection_state}, socket) do
    {:noreply, apply_projection(socket, projection_state)}
  end

  defp prepare_intent(
         %{assigns: %{source_state: :fresh, provenance: %{replica: replica}}} = socket,
         event,
         params
       ) do
    case intent_value(params, event.param) do
      {:ok, value} -> prepare_fresh_intent(socket, event, replica, value)
      :error -> apply_intent_fallback(socket, event.slot)
    end
  end

  defp prepare_intent(socket, event, _params), do: apply_intent_fallback(socket, event.slot)

  defp prepare_fresh_intent(socket, event, replica, value) do
    slot = Map.fetch!(@intent_slots_by_name, event.slot)
    command = intent_command(event, socket.assigns.model)

    socket =
      socket
      |> clear_sibling_intent(slot)
      |> assign_event_form(slot, event, value)

    case build_intent_url(event.builder, replica, value, command) do
      {:ok, url} -> assign_intent_success(socket, slot, replica, command, url)
      {:error, reason} -> assign_intent_error(socket, event.slot, slot, replica, reason)
    end
  end

  defp intent_value(_params, :none), do: {:ok, nil}

  defp intent_value(params, {group, field}) do
    case params do
      %{^group => %{^field => value}} -> {:ok, value}
      _other -> :error
    end
  end

  defp intent_command(%{command: :derived}, model), do: status_action_command(model)
  defp intent_command(event, _model), do: Map.get(event, :command)

  defp build_intent_url(:post, replica, value, _command),
    do: ActionIntent.post_url(replica, value)

  defp build_intent_url({:field, command}, replica, value, _slot_command),
    do: ActionIntent.field_url(replica, command, value)

  defp build_intent_url(:grant, replica, value, _command),
    do: ActionIntent.grant_url(replica, value)

  defp build_intent_url(:revoke, replica, value, _command),
    do: ActionIntent.revoke_url(replica, value)

  defp build_intent_url({:roster, command}, replica, value, _slot_command),
    do: ActionIntent.roster_url(replica, command, value)

  defp build_intent_url(:status, replica, _value, command),
    do: ActionIntent.status_url(replica, command)

  defp clear_sibling_intent(socket, %{sibling: sibling}),
    do: clear_intent_slot(socket, sibling)

  defp clear_sibling_intent(socket, _slot), do: socket

  defp assign_event_form(socket, slot, %{form: form_assign}, value) do
    form = Enum.find(slot.forms, &(&1.assign == form_assign))
    assign(socket, form_assign, intent_form(form, value))
  end

  defp assign_event_form(socket, _slot, _event, _value), do: socket

  defp assign_intent_success(socket, slot, replica, command, url) do
    assigns =
      %{slot.url => url, slot.replica => replica}
      |> maybe_put(slot.error, nil)
      |> maybe_put(slot.command, command)

    assign(socket, assigns)
  end

  defp assign_intent_error(socket, slot_name, %{kind: :model_status}, _replica, _reason),
    do: clear_intent_slot(socket, slot_name)

  defp assign_intent_error(socket, _slot_name, slot, replica, reason) do
    error_replica = if slot.error_replica == :replica, do: replica, else: nil

    assigns =
      %{slot.url => nil, slot.replica => error_replica, slot.error => action_intent_error(reason)}
      |> maybe_put(slot.command, nil)

    assign(socket, assigns)
  end

  defp apply_intent_fallback(socket, slot_name) do
    slot = Map.fetch!(@intent_slots_by_name, slot_name)

    case slot.fallback do
      :clear ->
        clear_intent_slot(socket, slot_name)

      {:error_message, message} ->
        assign(socket, %{slot.url => nil, slot.replica => nil, slot.error => message})
    end
  end

  defp maybe_put(map, nil, _value), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

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
    |> retain_action_intents(source_state, payload.read_model, payload.provenance.replica)
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
    assign(socket, action_intent_defaults())
  end

  defp retain_action_intents(socket, source_state, model, replica) do
    Enum.reduce(@intent_slots, socket, fn {slot_name, slot}, socket ->
      retain_intent_slot(socket, slot_name, slot, source_state, model, replica)
    end)
  end

  defp retain_intent_slot(
         socket,
         slot_name,
         %{kind: :model_status} = slot,
         :fresh,
         model,
         replica
       ) do
    cond do
      is_nil(socket.assigns[slot.url]) ->
        socket

      socket.assigns[slot.replica] != replica ->
        clear_intent_slot(socket, slot_name)

      socket.assigns[slot.command] != status_action_command(model) ->
        clear_intent_slot(socket, slot_name)

      true ->
        socket
    end
  end

  defp retain_intent_slot(socket, slot_name, slot, :fresh, _model, replica) do
    case socket.assigns[slot.replica] do
      nil -> socket
      ^replica -> socket
      _other_replica -> clear_intent_slot(socket, slot_name)
    end
  end

  defp retain_intent_slot(socket, slot_name, _slot, _source_state, _model, _replica),
    do: clear_intent_slot(socket, slot_name)

  defp clear_action_intent(socket) do
    assign(socket, action_intent_defaults())
  end

  defp clear_intent_slot(socket, slot_name) do
    slot_name
    |> then(&Map.fetch!(@intent_slots_by_name, &1))
    |> intent_slot_defaults()
    |> then(&assign(socket, &1))
  end

  defp action_intent_defaults do
    Enum.reduce(@intent_slots, %{}, fn {_slot_name, slot}, defaults ->
      Map.merge(defaults, intent_slot_defaults(slot))
    end)
  end

  defp intent_slot_defaults(slot) do
    defaults =
      [slot.url, slot.replica, slot.error, slot.command]
      |> Enum.reject(&is_nil/1)
      |> Map.new(&{&1, nil})

    Enum.reduce(slot.forms, defaults, fn form, defaults ->
      Map.put(defaults, form.assign, intent_form(form, ""))
    end)
  end

  defp intent_form(form, value) when is_binary(value),
    do: to_form(%{form.field => value}, as: form.as)

  defp intent_form(form, _value), do: intent_form(form, "")

  defp status_action_command(%{threads: %{clerk_locked?: true}}), do: :reopen_matter
  defp status_action_command(_model), do: :close_matter

  defp action_intent_error(:invalid_text), do: "Write an update before opening the app."
  defp action_intent_error(:text_too_large), do: "Keep the update within 4096 UTF-8 bytes."
  defp action_intent_error(:invalid_member), do: "Enter a member before opening the app."
  defp action_intent_error(:member_too_large), do: "Keep the member id within 4096 UTF-8 bytes."

  defp action_intent_error(:invalid_audience),
    do: "Enter a canonical recipient public key before opening the app."

  defp action_intent_error(:invalid_delegation),
    do: "Enter a canonical delegation id before opening the app."

  defp action_intent_error(_reason), do: "The participant action could not be prepared."

  attr(:id, :string, required: true)
  attr(:intent, :string, required: true)
  attr(:kicker, :string, required: true)
  attr(:title, :string, required: true)
  attr(:url, :string, default: nil)
  attr(:error, :string, default: nil)
  slot(:body, required: true)
  slot(:prepared, required: true)

  defp intent_panel(assigns) do
    ~H"""
    <section
      id={@id}
      class="participant-action"
      aria-labelledby={"participant-#{@intent}-title"}
    >
      <header>
        <p class="section-kicker">{@kicker}</p>
        <h2 id={"participant-#{@intent}-title"}>{@title}</h2>
      </header>
      {render_slot(@body)}
      <div :if={@url} class="participant-action__handoff">
        <p id={"participant-#{@intent}-prepared"} aria-live="polite">
          {render_slot(@prepared)}
        </p>
        <a id={"participant-#{@intent}-handoff"} href={@url}>Open in Township app</a>
      </div>
      <p
        :if={@error}
        id={"participant-#{@intent}-error"}
        class="participant-action__error"
        aria-live="polite"
      >
        {@error}
      </p>
    </section>
    """
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
