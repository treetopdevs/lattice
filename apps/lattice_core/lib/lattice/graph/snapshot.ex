defmodule Lattice.Graph.Snapshot do
  @moduledoc """
  Builds a process graph/trust graph snapshot from live Lattice state.
  """

  alias Lattice.Cap
  alias Lattice.Cap.Caveat

  def build do
    diagnostics = Lattice.diagnostics()
    topology = diagnostics.topology
    cap_snapshot = diagnostics.caps
    ifc = Lattice.IFC.snapshot()
    annotations = Lattice.Graph.Annotations.snapshot()
    audit_events = Lattice.audit_events()

    %{
      generated_at: System.system_time(:millisecond),
      nodes: nodes(topology, cap_snapshot, ifc, annotations, audit_events),
      edges: edges(topology, cap_snapshot, ifc, annotations, audit_events),
      audit_event_count: length(audit_events),
      policy: Lattice.Graph.Policy.check_current()
    }
  end

  defp nodes(topology, cap_snapshot, ifc, annotations, audit_events) do
    server_node = %{
      id: "realm:server",
      kind: "realm",
      label: "server",
      realm: "server",
      lifecycle_state: "connected"
    }

    core_nodes = [
      %{
        id: "process:gateway",
        kind: "gateway",
        label: "Gateway",
        realm: "server",
        lifecycle_state: "connected"
      },
      %{
        id: "process:cap_store",
        kind: "cap_store",
        label: "CapStore",
        realm: "server",
        lifecycle_state: "connected",
        pid: named_pid(Lattice.CapStore)
      },
      %{
        id: "process:audit",
        kind: "audit",
        label: "Audit",
        realm: "server",
        lifecycle_state: "connected",
        pid: named_pid(Lattice.Audit)
      },
      %{
        id: "process:tab_worker_supervisor",
        kind: "supervisor",
        label: "TabWorkerSupervisor",
        realm: "server",
        lifecycle_state: "connected",
        pid: named_pid(Lattice.TabWorkerSupervisor)
      }
    ]

    tab_nodes =
      Enum.map(topology.tabs, fn {id, tab} ->
        %{
          id: "tab:#{id}",
          kind: "tab",
          label: id,
          session_id: tab.session_id,
          state: Atom.to_string(tab.state),
          lifecycle_state: Atom.to_string(tab.state),
          realm: Atom.to_string(tab.realm.type),
          audit_event_ids: audit_ids(audit_events, tab_id: id)
        }
      end)

    worker_nodes =
      topology.tabs
      |> Enum.flat_map(fn {_id, tab} -> tab.owned_workers end)
      |> Enum.uniq()
      |> Enum.map(fn pid ->
        %{
          id: process_id(pid),
          kind: "worker",
          label: inspect(pid),
          realm: "server",
          lifecycle_state: if(Process.alive?(pid), do: "connected", else: "down"),
          pid: inspect(pid)
        }
      end)

    target_process_nodes =
      cap_snapshot.caps
      |> Enum.map(fn {_id, cap} -> target_node(cap.target) end)
      |> Enum.reject(&is_nil/1)

    cap_nodes =
      Enum.map(cap_snapshot.caps, fn {id, cap} ->
        %{
          id: "cap:#{id}",
          kind: "capability",
          label: short(id),
          owner_tab_id: cap.owner_tab_id,
          parent_id: cap.parent_id,
          root_id: cap.root_id,
          ops: cap.ops |> MapSet.to_list() |> Enum.map(&Atom.to_string/1),
          target: target_id(cap.target),
          status: cap_status(cap),
          lifecycle_state: cap_status(cap),
          caveats: Enum.map(cap.caveats, &Caveat.external/1),
          provenance: cap.provenance,
          session_state: cap.session && Atom.to_string(cap.session.state),
          audit_event_ids: audit_ids(audit_events, cap_id: id)
        }
      end)

    bridge_nodes =
      Enum.map(topology.bridges, fn {id, bridge} ->
        %{
          id: "bridge:#{id}",
          kind: "bridge",
          label: short(id),
          from_tab_id: bridge.from_tab_id,
          to_tab_id: bridge.to_tab_id,
          lifecycle_state: bridge_status(bridge)
        }
      end)

    ifc_nodes =
      ifc.labels
      |> Enum.map(fn {subject, label} ->
        %{
          id: "ifc:#{subject}",
          kind: "ifc_subject",
          label: subject,
          realm: "ifc",
          ifc_label: Atom.to_string(label)
        }
      end)

    ([server_node] ++
       core_nodes ++
       tab_nodes ++
       worker_nodes ++
       target_process_nodes ++
       cap_nodes ++
       bridge_nodes ++ ifc_nodes ++ annotations.nodes)
    |> Enum.uniq_by(fn node -> node[:id] || node["id"] end)
  end

  defp edges(topology, cap_snapshot, ifc, annotations, audit_events) do
    tab_edges =
      Enum.flat_map(topology.tabs, fn {id, tab} ->
        realm_edge = %{from: "realm:server", to: "tab:#{id}", kind: "connected_realm"}

        worker_edges =
          Enum.flat_map(tab.owned_workers, fn pid ->
            [
              %{from: "tab:#{id}", to: process_id(pid), kind: "owns_worker"},
              %{from: "tab:#{id}", to: process_id(pid), kind: "monitors"}
            ]
          end)

        [realm_edge | worker_edges]
      end)

    cap_edges =
      Enum.flat_map(cap_snapshot.caps, fn {id, %Cap{} = cap} ->
        base = [
          %{
            from: "tab:#{cap.owner_tab_id}",
            to: "cap:#{id}",
            kind: "holds_cap",
            status: cap_status(cap),
            audit_event_ids: audit_ids(audit_events, cap_id: id, type: :grant)
          },
          %{
            from: "cap:#{id}",
            to: target_id(cap.target),
            kind: "authorizes",
            status: cap_status(cap),
            audit_event_ids: audit_ids(audit_events, cap_id: id)
          }
        ]

        if cap.parent_id do
          [%{from: "cap:#{cap.parent_id}", to: "cap:#{id}", kind: "delegates"} | base]
        else
          base
        end
      end)

    bridge_edges =
      Enum.flat_map(topology.bridges, fn {id, bridge} ->
        [
          %{from: "tab:#{bridge.from_tab_id}", to: "bridge:#{id}", kind: "opens_bridge"},
          %{from: "bridge:#{id}", to: "tab:#{bridge.to_tab_id}", kind: "bridge_policy"},
          %{from: "cap:#{bridge.cap_id}", to: "bridge:#{id}", kind: "bridge_cap"}
        ]
      end)

    ifc_edges =
      Enum.map(ifc.flows, fn flow ->
        %{
          from: "ifc:#{flow.from}",
          to: "ifc:#{flow.to}",
          kind: "ifc_flow",
          payload_label: Atom.to_string(flow.payload_label),
          to_label: Atom.to_string(flow.to_label),
          allowed?: flow.allowed?
        }
      end)

    cleanup_edges = cleanup_edges(audit_events)
    audit_edges = audit_edges(audit_events, cap_snapshot.caps)

    (tab_edges ++
       cap_edges ++ bridge_edges ++ ifc_edges ++ cleanup_edges ++ audit_edges ++ annotations.edges)
    |> Enum.uniq_by(fn edge ->
      {edge[:from] || edge["from"], edge[:to] || edge["to"], edge[:kind] || edge["kind"],
       edge[:audit_event_id] || edge["audit_event_id"]}
    end)
  end

  defp cap_status(%Cap{revoked?: true}), do: "revoked"

  defp cap_status(%Cap{} = cap) do
    cond do
      Cap.expired?(cap) -> "expired"
      Cap.use_limited?(cap) -> "use_limited"
      true -> "live"
    end
  end

  defp target_id({:server_pid, pid}), do: process_id(pid)
  defp target_id({:server_name, name}), do: "process:name:#{name}"
  defp target_id({:tab, id}), do: "tab:#{id}"
  defp target_id(other), do: "target:#{inspect(other)}"

  defp target_node({:server_pid, pid}) do
    %{
      id: process_id(pid),
      kind: "server_process",
      label: "server #{inspect(pid)}",
      realm: "server",
      lifecycle_state: if(Process.alive?(pid), do: "connected", else: "down"),
      pid: inspect(pid)
    }
  end

  defp target_node({:server_name, name}) do
    %{
      id: "process:name:#{name}",
      kind: "server_process",
      label: Atom.to_string(name),
      realm: "server",
      lifecycle_state: if(Process.whereis(name), do: "connected", else: "down")
    }
  end

  defp target_node(_target), do: nil

  defp process_id(pid) when is_pid(pid), do: "process:#{inspect(pid)}"
  defp short(id) when is_binary(id), do: String.slice(id, 0, 8)

  defp bridge_status(%{expires_at: nil}), do: "live"

  defp bridge_status(%{expires_at: expires_at}) do
    if System.monotonic_time(:millisecond) > expires_at, do: "expired", else: "live"
  end

  defp named_pid(name) do
    case Process.whereis(name) do
      nil -> nil
      pid -> inspect(pid)
    end
  end

  defp audit_edges(audit_events, caps) do
    Enum.flat_map(audit_events, fn event ->
      case event.type do
        :cap_use ->
          cap_id = metadata(event, :cap_id)
          cap = Map.get(caps, cap_id)

          [
            %{
              from: "tab:#{metadata(event, :tab_id)}",
              to: event_target(cap, cap_id),
              kind: "invokes",
              status: "allowed",
              audit_event_id: event.id,
              cap_id: cap_id,
              op: metadata(event, :op)
            }
          ]

        :deny ->
          cap_id = metadata(event, :cap_id)
          cap = Map.get(caps, cap_id)

          [
            %{
              from:
                "tab:#{metadata(event, :tab_id) || metadata(event, :owner_tab_id) || "unknown"}",
              to: event_target(cap, cap_id),
              kind: "denied_attempt",
              status: "denied",
              audit_event_id: event.id,
              cap_id: cap_id,
              reason: inspect(metadata(event, :reason))
            }
          ]

        :expired_cap ->
          cap_id = metadata(event, :cap_id)

          [
            %{
              from: "tab:#{metadata(event, :tab_id)}",
              to: "cap:#{cap_id}",
              kind: "expired",
              status: "expired",
              audit_event_id: event.id,
              reason: inspect(metadata(event, :reason))
            }
          ]

        :use_limit_exceeded ->
          cap_id = metadata(event, :cap_id)

          [
            %{
              from: "tab:#{metadata(event, :tab_id)}",
              to: "cap:#{cap_id}",
              kind: "denied_attempt",
              status: "denied",
              audit_event_id: event.id,
              reason: "use_limit_exceeded"
            }
          ]

        :revoke ->
          cap_id = metadata(event, :cap_id)

          [
            %{
              from: "tab:#{metadata(event, :tab_id)}",
              to: "cap:#{cap_id}",
              kind: "revoked",
              status: "revoked",
              audit_event_id: event.id,
              reason: metadata(event, :reason)
            }
          ]

        _ ->
          []
      end
    end)
  end

  defp cleanup_edges(audit_events) do
    audit_events
    |> Enum.filter(&(&1.type == :worker_cleanup))
    |> Enum.map(fn event ->
      worker = metadata(event, :worker)

      %{
        from: "tab:#{metadata(event, :tab_id)}",
        to: "process:#{worker}",
        kind: "cleans_up",
        status: "done",
        audit_event_id: event.id
      }
    end)
  end

  defp event_target(%Cap{} = cap, _cap_id), do: target_id(cap.target)
  defp event_target(_cap, nil), do: "target:unknown"
  defp event_target(_cap, cap_id), do: "cap:#{cap_id}"

  defp audit_ids(events, filters) do
    events
    |> Enum.filter(fn event ->
      Enum.all?(filters, fn
        {:type, type} -> event.type == type
        {key, value} -> metadata(event, key) == value
      end)
    end)
    |> Enum.map(& &1.id)
  end

  defp metadata(event, key) do
    Map.get(event.metadata, key) || Map.get(event.metadata, Atom.to_string(key))
  end
end
