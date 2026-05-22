defmodule Lattice.LiveOps do
  @moduledoc """
  Authoritative broadcast LiveOps demo state.

  Browser tabs may render this state, but they do not grant, infer, or mutate
  authority. Every operation that matters still arrives through `Lattice.Gateway`
  with a capability issued to the calling tab.
  """

  use GenServer

  alias Lattice.{Audit, Cap, Tab}

  @roles [:producer, :graphics_operator, :remote_camera, :observer]
  @role_colors %{
    producer: "#2f6fed",
    graphics_operator: "#8a4fff",
    remote_camera: "#008f6b",
    observer: "#6b7280"
  }

  @role_actions %{
    producer: [:approve_publish, :revoke_publish, :observe],
    graphics_operator: [:preview_overlay, :request_publish, :observe],
    remote_camera: [:observe],
    observer: [:observe]
  }

  @role_devices %{
    producer: [:preview_monitor],
    graphics_operator: [:graphics_renderer],
    remote_camera: [:camera_feed, :tally_light],
    observer: []
  }

  @device_actions %{
    camera_feed: :camera_frame,
    graphics_renderer: :render_graphics,
    tally_light: :set_tally,
    preview_monitor: :monitor_preview
  }

  @default_publish_ttl_ms 15_000

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def register_tab(%Tab{} = tab), do: GenServer.call(__MODULE__, {:register_tab, tab})

  def cleanup_tab(tab_id, reason \\ :disconnect),
    do: GenServer.call(__MODULE__, {:cleanup_tab, tab_id, reason})

  def snapshot, do: GenServer.call(__MODULE__, :snapshot)
  def events, do: GenServer.call(__MODULE__, :events)
  def reset, do: GenServer.call(__MODULE__, :reset)
  def export(format \\ :json), do: GenServer.call(__MODULE__, {:export, format})

  def record_denial(tab_id, action, reason, metadata \\ %{}) do
    GenServer.call(
      __MODULE__,
      {:record_denial, tab_id, normalize_action(action), reason, metadata}
    )
  end

  def device_event(kind, tab_id, device_id, action, cap_id, payload) do
    GenServer.call(__MODULE__, {:device_event, kind, tab_id, device_id, action, cap_id, payload})
  end

  def device_action(kind), do: Map.fetch!(@device_actions, normalize_action(kind))

  @impl true
  def init(_opts), do: {:ok, fresh_state()}

  @impl true
  def handle_call({:register_tab, %Tab{} = tab}, _from, state) do
    role = role_from(tab.identity)

    if Map.has_key?(state.actors, tab.id) do
      {:reply, {:ok, public_actor(Map.fetch!(state.actors, tab.id), state)}, state}
    else
      actor = %{
        tab_id: tab.id,
        session_id: tab.session_id,
        role: role,
        label: label_for(role, state.role_counts[role] + 1),
        color: Map.fetch!(@role_colors, role),
        state: :connected,
        caps: %{},
        devices: %{},
        joined_seq: state.sequence + 1
      }

      state = put_actor(state, actor)
      state = put_in(state.role_counts[role], state.role_counts[role] + 1)
      {actor, state} = grant_role_caps(actor, state)
      {actor, state} = spawn_devices(actor, state)
      state = put_actor(state, actor)

      state =
        emit(state, :liveops_actor_joined, %{
          tab_id: actor.tab_id,
          session_id: actor.session_id,
          role: actor.role,
          label: actor.label,
          color: actor.color
        })

      {:reply, {:ok, public_actor(actor, state)}, state}
    end
  end

  def handle_call({:cleanup_tab, tab_id, reason}, _from, state) do
    {reply, state} = cleanup_actor(state, tab_id, reason)
    {:reply, reply, state}
  end

  def handle_call(
        {:record_denial, tab_id, action, reason, metadata},
        _from,
        state
      ) do
    state = deny(state, tab_id, action, reason, metadata)
    {:reply, :ok, state}
  end

  def handle_call(
        {:device_event, kind, tab_id, device_id, action, cap_id, payload},
        _from,
        state
      ) do
    op = %{
      id: operation_id(state),
      kind: kind,
      action: normalize_action(action),
      tab_id: tab_id,
      device_id: device_id,
      cap_id: cap_id,
      payload: compact_payload(payload)
    }

    state = %{state | operations: [op | state.operations]}

    state =
      emit(state, :liveops_device_operation, %{
        operation_id: op.id,
        kind: kind,
        action: op.action,
        tab_id: tab_id,
        device_id: device_id,
        cap_id: cap_id,
        payload: op.payload
      })

    {:reply, {:ok, op}, state}
  end

  def handle_call(:snapshot, _from, state), do: {:reply, snapshot_from(state), state}
  def handle_call(:events, _from, state), do: {:reply, Enum.reverse(state.events), state}
  def handle_call(:reset, _from, _state), do: {:reply, :ok, fresh_state()}

  def handle_call({:export, :json}, _from, state) do
    {:reply, Jason.encode!(snapshot_from(state), pretty: true), state}
  end

  def handle_call({:export, :mermaid}, _from, state) do
    {:reply, mermaid_from(state), state}
  end

  def handle_call({:export, format}, from, state) when format in ["json", "mermaid"] do
    handle_call({:export, String.to_existing_atom(format)}, from, state)
  end

  def handle_call({:export, format}, _from, state) do
    {:reply, {:error, {:unknown_format, format}}, state}
  end

  def handle_call({:lattice_call, envelope}, _from, state) do
    tab_id = Map.fetch!(envelope, :from_tab_id)
    cap_id = Map.get(envelope, :cap_id)
    payload = Map.get(envelope, :payload, %{})
    action = action_from(payload)

    case authorize_action(state, tab_id, cap_id, action) do
      {:ok, actor, cap_record} ->
        {reply, state} = run_action(state, actor, cap_record, payload)
        {:reply, reply, state}

      {:error, reason} ->
        state = deny(state, tab_id, action, reason, %{cap_id: cap_id})
        {:reply, {:error, reason}, state}
    end
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    case Map.pop(state.device_refs, ref) do
      {{tab_id, device_id}, device_refs} ->
        state = %{state | device_refs: device_refs}
        state = remove_device(state, tab_id, device_id, reason)
        {:noreply, state}

      {nil, _device_refs} ->
        {:noreply, state}
    end
  end

  defp fresh_state do
    %{
      actors: %{},
      order: [],
      caps: %{},
      approvals: %{},
      operations: [],
      events: [],
      sequence: 0,
      role_counts: Map.new(@roles, &{&1, 0}),
      approval_sequence: 0,
      operation_sequence: 0,
      device_sequence: 0,
      denials: 0,
      device_refs: %{}
    }
  end

  defp put_actor(state, actor) do
    order = if actor.tab_id in state.order, do: state.order, else: state.order ++ [actor.tab_id]
    %{state | actors: Map.put(state.actors, actor.tab_id, actor), order: order}
  end

  defp grant_role_caps(actor, state) do
    Enum.reduce(Map.fetch!(@role_actions, actor.role), {actor, state}, fn action,
                                                                          {actor, state} ->
      grant_action_cap(actor, state, action, __MODULE__, %{
        target: "server_plane",
        kind: :role
      })
    end)
  end

  defp spawn_devices(actor, state) do
    Enum.reduce(Map.fetch!(@role_devices, actor.role), {actor, state}, fn kind, {actor, state} ->
      device_id = "device-#{state.device_sequence + 1}-#{kind}"

      {:ok, pid} =
        Lattice.spawn_linked(
          actor.tab_id,
          Lattice.LiveOps.Device,
          [kind: kind, device_id: device_id, role: actor.role],
          []
        )

      ref = Process.monitor(pid)
      state = %{state | device_sequence: state.device_sequence + 1}
      state = put_in(state.device_refs[ref], {actor.tab_id, device_id})

      device = %{
        id: device_id,
        kind: kind,
        role: actor.role,
        tab_id: actor.tab_id,
        pid: inspect(pid),
        state: :connected
      }

      actor = put_in(actor.devices[device_id], device)

      {actor, state} =
        grant_action_cap(actor, state, Map.fetch!(@device_actions, kind), pid, %{
          target: device_id,
          device_id: device_id,
          device_kind: kind,
          kind: :device
        })

      state =
        emit(state, :liveops_device_joined, %{
          tab_id: actor.tab_id,
          role: actor.role,
          device_id: device_id,
          device_kind: kind
        })

      {actor, state}
    end)
  end

  defp grant_action_cap(actor, state, action, target, attrs) do
    {:ok, cap} =
      Lattice.grant(actor.tab_id, target, [:call],
        schema: %{action: :string},
        audit: %{
          liveops_action: Atom.to_string(action),
          liveops_role: Atom.to_string(actor.role),
          liveops_kind: Atom.to_string(attrs.kind),
          liveops_target: attrs.target
        }
      )

    record = cap_record(cap, action, actor.role, attrs)
    actor = put_in(actor.caps[action], record)
    state = %{state | caps: Map.put(state.caps, cap.id, record)}

    state =
      emit(state, :liveops_cap_granted, %{
        tab_id: actor.tab_id,
        role: actor.role,
        cap_id: cap.id,
        action: action,
        target: record.target,
        status: record.status,
        ttl_ms: record.ttl_ms,
        expires_at: record.expires_at,
        approval_id: Map.get(record, :approval_id),
        device_id: Map.get(record, :device_id)
      })

    {actor, state}
  end

  defp grant_publish_cap(state, operator, producer, approval, ttl_ms) do
    {:ok, cap} =
      Lattice.grant(operator.tab_id, __MODULE__, [:call],
        ttl: ttl_ms,
        use_limit: 1,
        schema: %{action: :string, request_id: :string},
        audit: %{
          liveops_action: "publish",
          liveops_role: "graphics_operator",
          liveops_kind: "approval",
          liveops_target: "server_plane",
          approval_id: approval.id,
          approved_by_tab_id: producer.tab_id
        }
      )

    record =
      cap_record(cap, :publish, :graphics_operator, %{
        target: "server_plane",
        kind: :approval,
        approval_id: approval.id,
        approved_by_tab_id: producer.tab_id
      })

    operator = put_in(operator, [:caps, :publish], record)

    state =
      state
      |> put_actor(operator)
      |> put_in([:caps, cap.id], record)

    state =
      emit(state, :liveops_cap_granted, %{
        tab_id: operator.tab_id,
        role: operator.role,
        cap_id: cap.id,
        action: :publish,
        target: "server_plane",
        status: :active,
        ttl_ms: cap.ttl_ms,
        expires_at: cap.expires_at,
        approval_id: approval.id,
        approved_by_tab_id: producer.tab_id
      })

    {record, state}
  end

  defp cap_record(%Cap{} = cap, action, role, attrs) do
    %{
      id: cap.id,
      action: normalize_action(action),
      role: normalize_role(role),
      owner_tab_id: cap.owner_tab_id,
      target: attrs.target,
      status: :active,
      ttl_ms: cap.ttl_ms,
      expires_at: cap.expires_at,
      use_limit: cap.use_limit,
      approval_id: Map.get(attrs, :approval_id),
      approved_by_tab_id: Map.get(attrs, :approved_by_tab_id),
      device_id: Map.get(attrs, :device_id),
      device_kind: Map.get(attrs, :device_kind),
      kind: attrs.kind
    }
  end

  defp authorize_action(state, tab_id, cap_id, action) do
    with {:ok, actor} <- fetch_actor(state, tab_id),
         {:ok, cap_record} <- fetch_cap_record(state, cap_id),
         :ok <- cap_action_matches(cap_record, action),
         :ok <- role_allows_action(actor.role, action),
         :ok <- cap_role_matches(cap_record, actor.role) do
      {:ok, actor, cap_record}
    end
  end

  defp fetch_actor(state, tab_id) do
    case Map.fetch(state.actors, tab_id) do
      {:ok, %{state: :connected} = actor} -> {:ok, actor}
      {:ok, _actor} -> {:error, :actor_disconnected}
      :error -> {:error, :unknown_actor}
    end
  end

  defp fetch_cap_record(_state, nil), do: {:error, :cap_required}

  defp fetch_cap_record(state, cap_id) do
    case Map.fetch(state.caps, cap_id) do
      {:ok, %{status: :active} = cap_record} -> {:ok, cap_record}
      {:ok, _cap_record} -> {:error, :cap_not_active}
      :error -> {:error, :unknown_liveops_cap}
    end
  end

  defp cap_action_matches(%{action: action}, action), do: :ok
  defp cap_action_matches(_cap_record, _action), do: {:error, :cap_action_mismatch}

  defp role_allows_action(role, :publish) when role == :graphics_operator, do: :ok

  defp role_allows_action(role, action) do
    if action in Map.fetch!(@role_actions, role) do
      :ok
    else
      {:error, :role_not_allowed}
    end
  end

  defp cap_role_matches(%{role: role}, role), do: :ok
  defp cap_role_matches(_cap_record, _role), do: {:error, :cap_role_mismatch}

  defp run_action(state, actor, _cap_record, payload) do
    case action_from(payload) do
      :preview_overlay ->
        preview_overlay(state, actor, payload)

      :request_publish ->
        request_publish(state, actor, payload)

      :approve_publish ->
        approve_publish(state, actor, payload)

      :revoke_publish ->
        revoke_publish(state, actor, payload)

      :publish ->
        publish(state, actor, payload)

      :observe ->
        {{:ok, snapshot_from(state)}, state}

      action ->
        {{:error, {:unknown_action, action}},
         deny(state, actor.tab_id, action, :unknown_action, %{})}
    end
  end

  defp preview_overlay(state, actor, payload) do
    overlay = overlay_from(payload)
    op = operation(state, :preview_overlay, actor.tab_id, %{overlay: overlay})

    state = %{
      state
      | operations: [op | state.operations],
        operation_sequence: state.operation_sequence + 1
    }

    state =
      emit(state, :liveops_operation_pulse, %{
        operation_id: op.id,
        action: :preview_overlay,
        tab_id: actor.tab_id,
        role: actor.role,
        overlay: overlay,
        result: :previewed
      })

    {{:ok, %{operation_id: op.id, previewed: overlay}}, state}
  end

  defp request_publish(state, actor, payload) do
    overlay = overlay_from(payload)
    approval_id = "approval-#{state.approval_sequence + 1}"

    approval = %{
      id: approval_id,
      operator_tab_id: actor.tab_id,
      overlay: overlay,
      status: :pending,
      publish_cap_id: nil,
      producer_tab_id: nil,
      expires_at: nil,
      published_operation_id: nil,
      requested_seq: state.sequence + 1
    }

    state = %{
      state
      | approvals: Map.put(state.approvals, approval_id, approval),
        approval_sequence: state.approval_sequence + 1
    }

    state =
      emit(state, :liveops_approval_requested, %{
        approval_id: approval_id,
        operator_tab_id: actor.tab_id,
        role: actor.role,
        overlay: overlay,
        status: :pending
      })

    {{:ok, %{approval_id: approval_id, status: :pending}}, state}
  end

  defp approve_publish(state, actor, payload) do
    approval_id = string_field(payload, :request_id) || string_field(payload, :approval_id)
    ttl_ms = integer_field(payload, :ttl_ms) || @default_publish_ttl_ms

    with {:ok, approval} <- fetch_pending_approval(state, approval_id),
         {:ok, operator} <- fetch_actor(state, approval.operator_tab_id) do
      {publish_cap, state} = grant_publish_cap(state, operator, actor, approval, ttl_ms)

      approval = %{
        approval
        | status: :approved,
          producer_tab_id: actor.tab_id,
          publish_cap_id: publish_cap.id,
          expires_at: publish_cap.expires_at
      }

      state = put_in(state.approvals[approval.id], approval)

      state =
        emit(state, :liveops_approval_granted, %{
          approval_id: approval.id,
          operator_tab_id: operator.tab_id,
          producer_tab_id: actor.tab_id,
          publish_cap_id: publish_cap.id,
          ttl_ms: publish_cap.ttl_ms,
          expires_at: publish_cap.expires_at,
          overlay: approval.overlay,
          status: :approved
        })

      {{:ok, %{approval_id: approval.id, publish_cap_id: publish_cap.id}}, state}
    else
      {:error, reason} ->
        {{:error, reason},
         deny(state, actor.tab_id, :approve_publish, reason, %{approval_id: approval_id})}
    end
  end

  defp revoke_publish(state, actor, payload) do
    approval_id = string_field(payload, :request_id) || string_field(payload, :approval_id)

    case Map.fetch(state.approvals, approval_id) do
      {:ok, %{publish_cap_id: cap_id} = approval} when is_binary(cap_id) ->
        state = revoke_cap_record(state, cap_id, :producer_revoke)
        approval = %{approval | status: :revoked}
        state = put_in(state.approvals[approval.id], approval)

        state =
          emit(state, :liveops_cap_revoked, %{
            approval_id: approval.id,
            cap_id: cap_id,
            tab_id: approval.operator_tab_id,
            producer_tab_id: actor.tab_id,
            reason: :producer_revoke
          })

        {{:ok, %{approval_id: approval.id, revoked: cap_id}}, state}

      {:ok, _approval} ->
        {{:error, :approval_has_no_publish_cap},
         deny(state, actor.tab_id, :revoke_publish, :approval_has_no_publish_cap, %{
           approval_id: approval_id
         })}

      :error ->
        {{:error, :unknown_approval},
         deny(state, actor.tab_id, :revoke_publish, :unknown_approval, %{approval_id: approval_id})}
    end
  end

  defp publish(state, actor, payload) do
    approval_id = string_field(payload, :request_id) || string_field(payload, :approval_id)
    cap_id = string_field(payload, :cap_id)

    with {:ok, approval} <- fetch_approved_publish(state, approval_id, cap_id, actor.tab_id) do
      overlay = overlay_from(payload) || approval.overlay
      op = operation(state, :publish, actor.tab_id, %{overlay: overlay, approval_id: approval.id})
      approval = %{approval | status: :published, published_operation_id: op.id}

      state = %{
        state
        | approvals: Map.put(state.approvals, approval.id, approval),
          operations: [op | state.operations],
          operation_sequence: state.operation_sequence + 1
      }

      state =
        emit(state, :liveops_operation_pulse, %{
          operation_id: op.id,
          action: :publish,
          tab_id: actor.tab_id,
          role: actor.role,
          approval_id: approval.id,
          cap_id: approval.publish_cap_id,
          overlay: overlay,
          result: :on_air
        })

      state = revoke_cap_record(state, approval.publish_cap_id, :publish_used)

      state =
        emit(state, :liveops_cap_revoked, %{
          approval_id: approval.id,
          cap_id: approval.publish_cap_id,
          tab_id: actor.tab_id,
          reason: :publish_used
        })

      {{:ok, %{operation_id: op.id, on_air: overlay}}, state}
    else
      {:error, reason} ->
        {{:error, reason},
         deny(state, actor.tab_id, :publish, reason, %{approval_id: approval_id, cap_id: cap_id})}
    end
  end

  defp fetch_pending_approval(_state, nil), do: {:error, :approval_id_required}

  defp fetch_pending_approval(state, approval_id) do
    case Map.fetch(state.approvals, approval_id) do
      {:ok, %{status: :pending} = approval} -> {:ok, approval}
      {:ok, _approval} -> {:error, :approval_not_pending}
      :error -> {:error, :unknown_approval}
    end
  end

  defp fetch_approved_publish(_state, nil, _cap_id, _tab_id), do: {:error, :approval_id_required}

  defp fetch_approved_publish(state, approval_id, cap_id, tab_id) do
    case Map.fetch(state.approvals, approval_id) do
      {:ok, %{status: :approved, operator_tab_id: ^tab_id, publish_cap_id: ^cap_id} = approval} ->
        {:ok, approval}

      {:ok, %{operator_tab_id: ^tab_id, publish_cap_id: ^cap_id}} ->
        {:error, :approval_not_active}

      {:ok, _approval} ->
        {:error, :approval_cap_mismatch}

      :error ->
        {:error, :unknown_approval}
    end
  end

  defp revoke_cap_record(state, cap_id, reason) do
    _ = Lattice.revoke(cap_id, reason)

    case Map.fetch(state.caps, cap_id) do
      {:ok, record} ->
        record = %{record | status: :revoked}

        state =
          update_in(state, [:actors, record.owner_tab_id, :caps], fn
            nil -> nil
            caps -> Map.put(caps, record.action, record)
          end)

        put_in(state.caps[cap_id], record)

      :error ->
        state
    end
  end

  defp cleanup_actor(state, tab_id, reason) do
    case Map.fetch(state.actors, tab_id) do
      {:ok, actor} ->
        state =
          actor.caps
          |> Map.values()
          |> Enum.reduce(state, fn cap, state -> revoke_cap_record(state, cap.id, reason) end)

        state =
          state.approvals
          |> Enum.reduce(state, fn {id, approval}, state ->
            if approval.operator_tab_id == tab_id or approval.producer_tab_id == tab_id do
              put_in(state.approvals[id], %{approval | status: :canceled})
            else
              state
            end
          end)

        device_ids = Map.keys(actor.devices)

        state = %{
          state
          | actors: Map.delete(state.actors, tab_id),
            order: Enum.reject(state.order, &(&1 == tab_id))
        }

        state =
          emit(state, :liveops_cleanup, %{
            tab_id: tab_id,
            role: actor.role,
            reason: reason,
            device_ids: device_ids
          })

        {{:ok, actor}, state}

      :error ->
        {{:error, :unknown_actor}, state}
    end
  end

  defp remove_device(state, tab_id, device_id, reason) do
    actor = Map.get(state.actors, tab_id)

    if actor && Map.has_key?(actor.devices, device_id) do
      actor = update_in(actor.devices, &Map.delete(&1, device_id))
      state = put_actor(state, actor)

      emit(state, :liveops_device_cleanup, %{
        tab_id: tab_id,
        device_id: device_id,
        reason: inspect(reason)
      })
    else
      state
    end
  end

  defp deny(state, tab_id, action, reason, metadata) do
    data =
      metadata
      |> Map.new()
      |> Map.merge(%{
        tab_id: tab_id,
        action: action,
        reason: reason
      })

    state = %{state | denials: state.denials + 1}
    emit(state, :liveops_denied, data)
  end

  defp emit(state, kind, data) do
    event = %{
      id: state.sequence + 1,
      kind: kind,
      data: data
    }

    Audit.record(kind, Map.put(data, :liveops_event_id, event.id))
    push_demo_event(kind, data)

    %{state | events: [event | state.events], sequence: event.id}
  end

  defp push_demo_event(kind, data) do
    module = Module.concat([LatticeServer, DemoHub])

    if Process.whereis(module) do
      apply(module, :event, [kind, data])
    end
  end

  defp snapshot_from(state) do
    now = System.monotonic_time(:millisecond)

    %{
      realm: "broadcast_liveops",
      server_plane: %{
        id: "liveops-server-plane",
        label: "LiveOps server plane",
        gateway: "Lattice.Gateway"
      },
      actors:
        state.order
        |> Enum.filter(&Map.has_key?(state.actors, &1))
        |> Enum.map(&public_actor(Map.fetch!(state.actors, &1), state, now)),
      caps:
        state.caps
        |> Map.values()
        |> Enum.sort_by(& &1.id)
        |> Enum.map(&public_cap(&1, now)),
      approvals:
        state.approvals
        |> Map.values()
        |> Enum.sort_by(& &1.id)
        |> Enum.map(&public_approval(&1, now)),
      operations:
        state.operations
        |> Enum.reverse()
        |> Enum.map(&stringify_atom_values/1),
      events: Enum.reverse(state.events),
      counters: %{
        actors: map_size(state.actors),
        caps: map_size(state.caps),
        approvals: map_size(state.approvals),
        operations: length(state.operations),
        denials: state.denials,
        audit: length(Audit.events())
      }
    }
  end

  defp public_actor(actor, state, now \\ System.monotonic_time(:millisecond)) do
    %{
      tab_id: actor.tab_id,
      session_id: actor.session_id,
      role: actor.role,
      label: actor.label,
      color: actor.color,
      state: actor.state,
      caps:
        actor.caps
        |> Map.values()
        |> Enum.sort_by(&Atom.to_string(&1.action))
        |> Enum.map(&public_cap(&1, now)),
      devices:
        actor.devices
        |> Map.values()
        |> Enum.sort_by(& &1.id)
        |> Enum.map(&stringify_atom_values/1),
      pending_approvals:
        state.approvals
        |> Map.values()
        |> Enum.filter(&(&1.operator_tab_id == actor.tab_id and &1.status == :pending))
        |> Enum.map(& &1.id)
    }
  end

  defp public_cap(cap, now) do
    cap
    |> stringify_atom_values()
    |> Map.put(:expires_in_ms, expires_in(cap.expires_at, now))
  end

  defp public_approval(approval, now) do
    approval
    |> stringify_atom_values()
    |> Map.put(:expires_in_ms, expires_in(Map.get(approval, :expires_at), now))
  end

  defp expires_in(nil, _now), do: nil
  defp expires_in(expires_at, now), do: max(expires_at - now, 0)

  defp mermaid_from(state) do
    snapshot = snapshot_from(state)

    actor_lines =
      Enum.map(snapshot.actors, fn actor ->
        id = mermaid_id(actor.tab_id)
        ~s(  #{id}["#{actor.label} #{actor.role}"])
      end)

    device_lines =
      snapshot.actors
      |> Enum.flat_map(fn actor ->
        Enum.map(actor.devices, fn device ->
          ~s(  #{mermaid_id(device.id)}["#{device.kind}"])
        end)
      end)

    cap_lines =
      Enum.map(snapshot.caps, fn cap ->
        from = mermaid_id(cap.owner_tab_id)
        to = mermaid_id(cap.target)
        arrow = if cap.status == "revoked", do: "-.->", else: "-->"
        ~s(  #{from} #{arrow}|"#{cap.action}"| #{to})
      end)

    ["graph TD", ~s(  server["LiveOps server plane"])]
    |> Kernel.++(actor_lines)
    |> Kernel.++(device_lines)
    |> Kernel.++(cap_lines)
    |> Enum.join("\n")
  end

  defp operation(state, action, tab_id, attrs) do
    %{
      id: operation_id(state),
      action: action,
      tab_id: tab_id,
      attrs: attrs
    }
  end

  defp operation_id(state), do: "operation-#{state.operation_sequence + 1}"

  defp role_from(identity) do
    identity
    |> value_for(:role)
    |> normalize_role()
  end

  defp normalize_role(role) when is_atom(role) and role in @roles, do: role

  defp normalize_role(role) when is_binary(role) do
    role
    |> String.trim()
    |> String.downcase()
    |> String.replace("-", "_")
    |> then(fn role ->
      Enum.find(@roles, :observer, &(Atom.to_string(&1) == role))
    end)
  end

  defp normalize_role(_role), do: :observer

  defp normalize_action(action) when is_atom(action), do: action

  defp normalize_action(action) when is_binary(action) do
    action
    |> String.trim()
    |> String.downcase()
    |> String.replace("-", "_")
    |> String.to_existing_atom()
  rescue
    ArgumentError -> :unknown
  end

  defp normalize_action(_action), do: :unknown

  defp action_from(payload), do: payload |> value_for(:action) |> normalize_action()

  defp overlay_from(payload) do
    value_for(payload, :overlay) || value_for(payload, :title) || "Lower third: LIVE"
  end

  defp string_field(payload, field) do
    case value_for(payload, field) do
      value when is_binary(value) -> value
      value when is_atom(value) -> Atom.to_string(value)
      _ -> nil
    end
  end

  defp integer_field(payload, field) do
    case value_for(payload, field) do
      value when is_integer(value) ->
        value

      value when is_binary(value) ->
        case Integer.parse(value) do
          {int, ""} -> int
          _ -> nil
        end

      _ ->
        nil
    end
  end

  defp value_for(map, field) when is_map(map) do
    Map.get(map, field) || Map.get(map, Atom.to_string(field))
  end

  defp value_for(_map, _field), do: nil

  defp label_for(:producer, index), do: "Producer #{index}"
  defp label_for(:graphics_operator, index), do: "Graphics #{index}"
  defp label_for(:remote_camera, index), do: "Camera #{index}"
  defp label_for(:observer, index), do: "Observer #{index}"

  defp compact_payload(payload) when is_map(payload) do
    payload
    |> Map.take(["action", "overlay", "frame", "state", :action, :overlay, :frame, :state])
    |> stringify_atom_values()
  end

  defp compact_payload(_payload), do: %{}

  defp stringify_atom_values(map) when is_map(map) do
    Map.new(map, fn {key, value} ->
      {key, stringify_atom_value(value)}
    end)
  end

  defp stringify_atom_value(value) when is_atom(value), do: Atom.to_string(value)
  defp stringify_atom_value(value) when is_map(value), do: stringify_atom_values(value)

  defp stringify_atom_value(value) when is_list(value),
    do: Enum.map(value, &stringify_atom_value/1)

  defp stringify_atom_value(value), do: value

  defp mermaid_id(value) do
    value
    |> to_string()
    |> String.replace(~r/[^a-zA-Z0-9_]/, "_")
    |> then(&("n_" <> &1))
  end
end
