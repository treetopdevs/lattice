defmodule Lattice.Graph.Export do
  @moduledoc """
  Exports graph snapshots to JSON, DOT, or Mermaid.
  """

  def export(snapshot, :json), do: Jason.encode!(snapshot, pretty: true)
  def export(snapshot, "json"), do: export(snapshot, :json)

  def export(snapshot, :dot) do
    lines =
      ["digraph lattice {"]
      |> Kernel.++(Enum.map(snapshot.nodes, &dot_node/1))
      |> Kernel.++(Enum.map(snapshot.edges, &dot_edge/1))
      |> Kernel.++(["}"])

    Enum.join(lines, "\n")
  end

  def export(snapshot, "dot"), do: export(snapshot, :dot)

  def export(snapshot, :mermaid) do
    lines =
      ["graph TD"]
      |> Kernel.++(Enum.map(snapshot.nodes, &mermaid_node/1))
      |> Kernel.++(Enum.map(snapshot.edges, &mermaid_edge/1))

    Enum.join(lines, "\n")
  end

  def export(snapshot, "mermaid"), do: export(snapshot, :mermaid)

  defp dot_node(node) do
    ~s(  "#{node.id}" [label="#{escape(node.label || node.id)}", shape="#{shape(node.kind)}"];)
  end

  defp dot_edge(edge) do
    ~s(  "#{edge.from}" -> "#{edge.to}" [label="#{edge.kind}"];)
  end

  defp mermaid_node(node) do
    ~s(  #{mermaid_id(node.id)}["#{escape(node.label || node.id)}"])
  end

  defp mermaid_edge(edge) do
    ~s(  #{mermaid_id(edge.from)} -->|"#{edge.kind}"| #{mermaid_id(edge.to)})
  end

  defp shape("capability"), do: "hexagon"
  defp shape("bridge"), do: "diamond"
  defp shape("tab"), do: "box"
  defp shape(_kind), do: "ellipse"

  defp mermaid_id(id) do
    id
    |> String.replace(~r/[^a-zA-Z0-9_]/, "_")
    |> then(&("n_" <> &1))
  end

  defp escape(value) do
    value
    |> to_string()
    |> String.replace("\"", "\\\"")
  end
end
