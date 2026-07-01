defmodule Lattice.LiveOps do
  @moduledoc """
  Authoritative broadcast LiveOps demo state.

  Browser tabs may render this state, but they do not grant, infer, or mutate
  authority. Every operation that matters still arrives through `Lattice.Gateway`
  with a capability issued to the calling tab.

  Authority lives in exactly one place: `Lattice.CapStore`. This process is a
  domain executor and projection. It never re-authorizes a call — by the time a
  `{:lattice_call, …}` envelope arrives, `CapStore` has already enforced owner,
  revocation, expiry, use-limit, ops, schema, and the action caveat. LiveOps only
  executes the overlay/approval/publish workflow and renders state, deriving every
  capability's status from `CapStore` so the two can never drift.
  """

  use GenServer

  alias Lattice.{Audit, Tab}
  alias Lattice.LiveOps.{Policy, Serializer}

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

  def device_action(kind), do: Policy.device_action(normalize_action(kind))

  @impl true
  def init(_opts), do: {:ok, fresh_state()}

  @impl true
  def handle_call({:register_tab, %Tab{} = tab}, _from, state) do
    role = role_from(tab.identity)

    if Map.has_key?(state.actors, tab.id) do
      {:reply, {:ok, Serializer.actor_view(state, Map.fetch!(state.actors, tab.id))}, state}
    else
      actor = %{
        tab_id: tab.id,
        session_id: tab.session_id,
        role: role,
        label: label_for(role, state.role_counts[role] + 1),
        color: Policy.color_for(role),
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

      {:reply, {:ok, Serializer.actor_view(state, actor)}, state}
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

  def handle_call(:snapshot, _from, state), do: {:reply, Serializer.snapshot(state), state}
  def handle_call(:events, _from, state), do: {:reply, Enum.reverse(state.events), state}
  def handle_call(:reset, _from, _state), do: {:reply, :ok, fresh_state()}

  def handle_call({:export, :json}, _from, state) do
    {:reply, Jason.encode!(Serializer.snapshot(state), pretty: true), state}
  end

  def handle_call({:export, :mermaid}, _from, state) do
    {:reply, Serializer.mermaid(state), state}
  end

  def handle_call({:export, format}, from, state) when format in ["json", "mermaid"] do
    handle_call({:export, String.to_existing_atom(format)}, from, state)
  end

  def handle_call({:export, format}, _from, state) do
    {:reply, {:error, {:unknown_format, format}}, state}
  end

  def handle_call({:lattice_call, envelope}, _from, state) do
    tab_id = Map.fetch!(envelope, :from_tab_id)
    payload = Map.get(envelope, :payload, %{})

    case fetch_actor(state, tab_id) do
      {:ok, actor} ->
        {reply, state} = run_action(state, actor, payload)
        {:reply, reply, state}

      {:error, reason} ->
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
      cap_index: %{},
      approvals: %{},
      operations: [],
      events: [],
      sequence: 0,
      role_counts: Map.new(Policy.roles(), &{&1, 0}),
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
    Enum.reduce(Policy.role_actions(actor.role), {actor, state}, fn action, {actor, state} ->
      grant_role_cap(actor, state, action)
    end)
  end

  defp spawn_devices(actor, state) do
    Enum.reduce(Policy.role_devices(actor.role), {actor, state}, fn kind, {actor, state} ->
      device_id = "device-#{state.device_sequence + 1}-#{kind}"

      case Lattice.spawn_linked(
             actor.tab_id,
             Lattice.LiveOps.Device,
             [kind: kind, device_id: device_id, role: actor.role],
             []
           ) do
        {:ok, pid} ->
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
            grant_device_cap(actor, state, Policy.device_action(kind), pid, device_id, kind)

          state =
            emit(state, :liveops_device_joined, %{
              tab_id: actor.tab_id,
              role: actor.role,
              device_id: device_id,
              device_kind: kind
            })

          {actor, state}

        {:error, reason} ->
          state = %{state | device_sequence: state.device_sequence + 1}

          state =
            emit(state, :liveops_device_skipped, %{
              tab_id: actor.tab_id,
              role: actor.role,
              device_kind: kind,
              reason: inspect(reason)
            })

          {actor, state}
      end
    end)
  end

  defp grant_role_cap(actor, state, action) do
    {:ok, cap} =
      Lattice.grant(actor.tab_id, __MODULE__, [:call], Policy.role_cap_opts(action, actor.role))

    entry = %{
      owner_tab_id: cap.owner_tab_id,
      action: action,
      role: actor.role,
      target: "server_plane",
      kind: :role,
      device_id: nil,
      device_kind: nil,
      approval_id: nil,
      approved_by_tab_id: nil
    }

    put_cap(actor, state, cap, entry)
  end

  defp grant_device_cap(actor, state, action, pid, device_id, kind) do
    {:ok, cap} =
      Lattice.grant(
        actor.tab_id,
        pid,
        [:call],
        Policy.device_cap_opts(action, actor.role, device_id, kind)
      )

    entry = %{
      owner_tab_id: cap.owner_tab_id,
      action: action,
      role: actor.role,
      target: device_id,
      kind: :device,
      device_id: device_id,
      device_kind: kind,
      approval_id: nil,
      approved_by_tab_id: nil
    }

    put_cap(actor, state, cap, entry)
  end

  defp grant_publish_cap(state, operator, producer, approval, ttl_ms) do
    {:ok, cap} =
      Lattice.grant(
        operator.tab_id,
        __MODULE__,
        [:call],
        Policy.publish_cap_opts(approval, producer.tab_id, ttl_ms)
      )

    entry = %{
      owner_tab_id: cap.owner_tab_id,
      action: :publish,
      role: :graphics_operator,
      target: "server_plane",
      kind: :approval,
      device_id: nil,
      device_kind: nil,
      approval_id: approval.id,
      approved_by_tab_id: producer.tab_id
    }

    {operator, state} = put_cap(operator, state, cap, entry)
    state = put_actor(state, operator)
    {cap, state}
  end

  defp put_cap(actor, state, cap, entry) do
    actor = put_in(actor.caps[entry.action], cap.id)
    state = put_in(state.cap_index[cap.id], entry)

    state =
      emit(state, :liveops_cap_granted, %{
        tab_id: actor.tab_id,
        role: actor.role,
        cap_id: cap.id,
        action: entry.action,
        target: entry.target,
        ttl_ms: cap.ttl_ms,
        expires_at: cap.expires_at,
        approval_id: entry.approval_id,
        device_id: entry.device_id
      })

    {actor, state}
  end

  defp fetch_actor(state, tab_id) do
    case Map.fetch(state.actors, tab_id) do
      {:ok, %{state: :connected} = actor} -> {:ok, actor}
      {:ok, _actor} -> {:error, :actor_disconnected}
      :error -> {:error, :unknown_actor}
    end
  end

  defp run_action(state, actor, payload) do
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
        {{:ok, Serializer.snapshot(state)}, state}

      action ->
        {{:error, {:unknown_action, action}}, state}
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
      {:error, reason} -> {{:error, reason}, state}
    end
  end

  defp revoke_publish(state, actor, payload) do
    approval_id = string_field(payload, :request_id) || string_field(payload, :approval_id)

    case Map.fetch(state.approvals, approval_id) do
      {:ok, %{publish_cap_id: cap_id} = approval} when is_binary(cap_id) ->
        state = revoke_cap(state, cap_id, :producer_revoke)
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
        {{:error, :approval_has_no_publish_cap}, state}

      :error ->
        {{:error, :unknown_approval}, state}
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

      state = revoke_cap(state, approval.publish_cap_id, :publish_used)

      state =
        emit(state, :liveops_cap_revoked, %{
          approval_id: approval.id,
          cap_id: approval.publish_cap_id,
          tab_id: actor.tab_id,
          reason: :publish_used
        })

      {{:ok, %{operation_id: op.id, on_air: overlay}}, state}
    else
      {:error, reason} -> {{:error, reason}, state}
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

  defp revoke_cap(state, cap_id, reason) do
    _ = Lattice.revoke(cap_id, reason)
    state
  end

  defp cleanup_actor(state, tab_id, reason) do
    case Map.fetch(state.actors, tab_id) do
      {:ok, actor} ->
        state =
          actor.caps
          |> Map.values()
          |> Enum.reduce(state, fn cap_id, state -> revoke_cap(state, cap_id, reason) end)

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

  defp operation(state, action, tab_id, attrs) do
    %{
      id: operation_id(state),
      action: action,
      tab_id: tab_id,
      attrs: attrs
    }
  end

  defp operation_id(state), do: "operation-#{state.operation_sequence + 1}"

  defp role_from(identity), do: identity |> value_for(:role) |> Policy.normalize_role()

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
    |> Serializer.stringify_atom_values()
  end

  defp compact_payload(_payload), do: %{}
end
