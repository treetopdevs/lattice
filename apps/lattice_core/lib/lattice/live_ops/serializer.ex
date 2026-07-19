defmodule Lattice.LiveOps.Serializer do
  @moduledoc """
  Projects LiveOps domain state into the public broadcast snapshot.

  Capability liveness is never stored in LiveOps. It is read from
  `Lattice.CapStore` (the authority) at serialization time, so the rendered
  status can never drift from the store's actual allow/deny decision. The wire
  keeps emitting `"active"` for a live cap to honor the existing browser/proof
  contract. If the authority process is unavailable, serialization treats the
  store as empty so every projected capability fails closed as `"revoked"`
  without crashing LiveOps.
  """

  alias Lattice.{Audit, Cap, CapStore}

  @empty_cap_store_snapshot %{caps: %{}, active_caps: %{}}

  def snapshot(state) do
    store = safe_cap_store_snapshot()
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
        |> Enum.map(&public_actor(Map.fetch!(state.actors, &1), state, store, now)),
      caps:
        state.cap_index
        |> Enum.map(fn {cap_id, entry} -> public_cap(cap_id, entry, store, now) end)
        |> Enum.sort_by(& &1.id),
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
        caps: map_size(state.cap_index),
        approvals: map_size(state.approvals),
        operations: length(state.operations),
        denials: state.denials,
        audit: length(Audit.events())
      }
    }
  end

  def actor_view(state, actor) do
    public_actor(actor, state, safe_cap_store_snapshot(), System.monotonic_time(:millisecond))
  end

  def mermaid(state) do
    snapshot = snapshot(state)

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

  defp public_actor(actor, state, store, now) do
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
        |> Enum.map(&public_cap(&1, Map.fetch!(state.cap_index, &1), store, now))
        |> Enum.sort_by(& &1.action),
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

  defp public_cap(cap_id, entry, store, now) do
    cap = Map.get(store.caps, cap_id)

    %{
      id: cap_id,
      action: entry.action,
      role: entry.role,
      owner_tab_id: entry.owner_tab_id,
      target: entry.target,
      status: wire_status(cap),
      ttl_ms: cap && cap.ttl_ms,
      expires_at: cap && cap.expires_at,
      use_limit: cap && cap.use_limit,
      approval_id: entry.approval_id,
      approved_by_tab_id: entry.approved_by_tab_id,
      device_id: entry.device_id,
      device_kind: entry.device_kind,
      kind: entry.kind
    }
    |> stringify_atom_values()
    |> Map.put(:expires_in_ms, expires_in(cap && cap.expires_at, now))
  end

  defp public_approval(approval, now) do
    approval
    |> stringify_atom_values()
    |> Map.put(:expires_in_ms, expires_in(Map.get(approval, :expires_at), now))
  end

  defp safe_cap_store_snapshot do
    CapStore.snapshot()
  catch
    :exit, _reason -> @empty_cap_store_snapshot
  end

  defp wire_status(nil), do: "revoked"
  defp wire_status(%Cap{revoked?: true}), do: "revoked"

  defp wire_status(%Cap{} = cap) do
    cond do
      Cap.expired?(cap) -> "expired"
      Cap.use_limited?(cap) -> "use_limited"
      true -> "active"
    end
  end

  defp expires_in(nil, _now), do: nil
  defp expires_in(expires_at, now), do: max(expires_at - now, 0)

  def stringify_atom_values(map) when is_map(map) do
    Map.new(map, fn {key, value} -> {key, stringify_atom_value(value)} end)
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
