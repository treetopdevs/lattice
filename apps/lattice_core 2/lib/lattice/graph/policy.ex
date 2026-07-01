defmodule Lattice.Graph.Policy do
  @moduledoc """
  Trust/fault graph invariants for the research demonstrator.
  """

  alias Lattice.Cap
  alias Lattice.Cap.{Attenuation, Caveat}

  def check_current do
    diagnostics = Lattice.diagnostics()
    topology = diagnostics.topology
    caps = diagnostics.caps.caps
    ifc = Lattice.IFC.snapshot()

    []
    |> live_caps_from_connected_tabs(caps, topology)
    |> bridges_have_policy(caps, topology)
    |> child_caps_attenuated(caps)
    |> restricted_caps_stay_in_realm(caps, topology)
    |> tab_edges_have_bridge(caps, topology)
    |> sensitive_flows_stay_private(ifc)
    |> case do
      [] -> %{status: "ok", violations: []}
      violations -> %{status: "violation", violations: Enum.reverse(violations)}
    end
  end

  defp live_caps_from_connected_tabs(violations, caps, topology) do
    Enum.reduce(caps, violations, fn {_id, cap}, acc ->
      if live?(cap) and not MapSet.member?(topology.connected_tab_ids, cap.owner_tab_id) do
        [violation(:live_cap_from_dead_tab, cap_id: cap.id, tab_id: cap.owner_tab_id) | acc]
      else
        acc
      end
    end)
  end

  defp bridges_have_policy(violations, caps, topology) do
    Enum.reduce(topology.bridges, violations, fn {bridge_id, bridge}, acc ->
      case Map.fetch(caps, bridge.cap_id) do
        {:ok, %Cap{owner_tab_id: from, target: {:tab, to}}}
        when from == bridge.from_tab_id and to == bridge.to_tab_id ->
          acc

        _ ->
          [
            violation(:bridge_without_explicit_policy,
              bridge_id: bridge_id,
              cap_id: bridge.cap_id
            )
            | acc
          ]
      end
    end)
  end

  defp child_caps_attenuated(violations, caps) do
    Enum.reduce(caps, violations, fn {_id, cap}, acc ->
      case if(cap.parent_id, do: Map.fetch(caps, cap.parent_id), else: nil) do
        {:ok, parent} ->
          if Attenuation.subset?(cap, parent),
            do: acc,
            else: [violation(:child_cap_exceeds_parent, cap_id: cap.id) | acc]

        nil ->
          acc

        :error ->
          [violation(:child_cap_missing_parent, cap_id: cap.id, parent_id: cap.parent_id) | acc]
      end
    end)
  end

  defp restricted_caps_stay_in_realm(violations, caps, topology) do
    Enum.reduce(caps, violations, fn {_id, cap}, acc ->
      allowed_realms = Caveat.values(cap.caveats, :allowed_realm)

      if allowed_realms == [] do
        acc
      else
        tab = Map.get(topology.tabs, cap.owner_tab_id)
        holder_realm = tab && tab.realm.type

        if holder_realm in allowed_realms do
          acc
        else
          [
            violation(:restricted_cap_outside_allowed_realm,
              cap_id: cap.id,
              holder_realm: holder_realm
            )
            | acc
          ]
        end
      end
    end)
  end

  defp tab_edges_have_bridge(violations, caps, topology) do
    Enum.reduce(caps, violations, fn {_id, cap}, acc ->
      case cap.target do
        {:tab, tab_id} ->
          if live?(cap) and cap.owner_tab_id != tab_id and
               not Map.has_key?(topology.bridges, cap.id) do
            [violation(:tab_to_tab_edge_without_bridge_policy, cap_id: cap.id) | acc]
          else
            acc
          end

        _ ->
          acc
      end
    end)
  end

  defp sensitive_flows_stay_private(violations, ifc) do
    Enum.reduce(ifc.flows, violations, fn flow, acc ->
      if flow.allowed? and not Lattice.IFC.allowed?(flow.payload_label, flow.to_label) do
        [violation(:sensitive_label_flowed_to_public_realm, flow_id: flow.id) | acc]
      else
        acc
      end
    end)
  end

  defp live?(%Cap{} = cap),
    do: not cap.revoked? and not Cap.expired?(cap) and not Cap.use_limited?(cap)

  defp violation(type, attrs) do
    attrs |> Map.new() |> Map.put(:type, type)
  end
end
