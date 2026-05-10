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

    %{
      generated_at: System.system_time(:millisecond),
      nodes: nodes(topology, cap_snapshot, ifc),
      edges: edges(topology, cap_snapshot, ifc),
      policy: Lattice.Graph.Policy.check_current()
    }
  end

  defp nodes(topology, cap_snapshot, ifc) do
    server_node = %{id: "realm:server", kind: "realm", label: "server", state: "connected"}

    tab_nodes =
      Enum.map(topology.tabs, fn {id, tab} ->
        %{
          id: "tab:#{id}",
          kind: "tab",
          label: id,
          session_id: tab.session_id,
          state: Atom.to_string(tab.state),
          realm: Atom.to_string(tab.realm.type)
        }
      end)

    worker_nodes =
      topology.tabs
      |> Enum.flat_map(fn {_id, tab} -> tab.owned_workers end)
      |> Enum.uniq()
      |> Enum.map(fn pid ->
        %{id: process_id(pid), kind: "worker", label: inspect(pid), alive?: Process.alive?(pid)}
      end)

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
          caveats: Enum.map(cap.caveats, &Caveat.external/1),
          provenance: cap.provenance
        }
      end)

    bridge_nodes =
      Enum.map(topology.bridges, fn {id, bridge} ->
        %{
          id: "bridge:#{id}",
          kind: "bridge",
          label: short(id),
          from_tab_id: bridge.from_tab_id,
          to_tab_id: bridge.to_tab_id
        }
      end)

    ifc_nodes =
      ifc.labels
      |> Enum.map(fn {subject, label} ->
        %{
          id: "ifc:#{subject}",
          kind: "ifc_subject",
          label: subject,
          ifc_label: Atom.to_string(label)
        }
      end)

    [server_node | tab_nodes ++ worker_nodes ++ cap_nodes ++ bridge_nodes ++ ifc_nodes]
  end

  defp edges(topology, cap_snapshot, ifc) do
    tab_edges =
      Enum.flat_map(topology.tabs, fn {id, tab} ->
        realm_edge = %{from: "realm:server", to: "tab:#{id}", kind: "connected_realm"}

        worker_edges =
          Enum.flat_map(tab.owned_workers, fn pid ->
            [
              %{from: "tab:#{id}", to: process_id(pid), kind: "owns_worker"},
              %{from: "tab:#{id}", to: process_id(pid), kind: "monitor_link"}
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
            status: cap_status(cap)
          },
          %{
            from: "cap:#{id}",
            to: target_id(cap.target),
            kind: "authorizes",
            status: cap_status(cap)
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

    tab_edges ++ cap_edges ++ bridge_edges ++ ifc_edges
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

  defp process_id(pid) when is_pid(pid), do: "process:#{inspect(pid)}"
  defp short(id) when is_binary(id), do: String.slice(id, 0, 8)
end
