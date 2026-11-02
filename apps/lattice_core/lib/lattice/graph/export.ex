defmodule Lattice.Graph.Export do
  @moduledoc """
  Exports graph snapshots to JSON, DOT, or Mermaid.
  """

  def export(snapshot, :json), do: Jason.encode!(snapshot, pretty: true)
  def export(snapshot, "json"), do: export(snapshot, :json)

  def export(snapshot, :dot) do
    lines =
      ["digraph lattice {"]
      |> Kernel.++(omitted_comment(snapshot, "//"))
      |> Kernel.++(Enum.map(snapshot.nodes, &dot_node/1))
      |> Kernel.++(Enum.map(snapshot.edges, &dot_edge/1))
      |> Kernel.++(["}"])

    Enum.join(lines, "\n")
  end

  def export(snapshot, "dot"), do: export(snapshot, :dot)

  def export(snapshot, :mermaid) do
    lines =
      ["graph TD"]
      |> Kernel.++(omitted_comment(snapshot, "%%"))
      |> Kernel.++(Enum.map(snapshot.nodes, &mermaid_node/1))
      |> Kernel.++(Enum.map(snapshot.edges, &mermaid_edge/1))

    Enum.join(lines, "\n")
  end

  def export(snapshot, "mermaid"), do: export(snapshot, :mermaid)

  # Row 306: a snapshot may name ops it could not draw. Without the key, or with
  # an empty list, the output is byte-identical to before.
  defp omitted_comment(snapshot, marker) do
    case Map.get(snapshot, :omitted, []) do
      [] ->
        []

      ids ->
        ["  #{marker} omitted #{length(ids)} ill-formed delegation op(s): #{Enum.join(ids, " ")}"]
    end
  end

  defp dot_node(node) do
    id = node.id
    label = node[:label] || id
    kind = node.kind
    ~s(  "#{escape(id)}" [label="#{escape(label)}", shape="#{shape(kind)}"];)
  end

  defp dot_edge(edge) do
    label =
      [
        edge.kind,
        edge[:status],
        edge[:reason]
      ]
      |> Enum.reject(&is_nil/1)
      |> Enum.join(" ")

    ~s(  "#{escape(edge.from)}" -> "#{escape(edge.to)}" [label="#{escape(label)}"];)
  end

  defp mermaid_node(node) do
    id = node.id
    label = node[:label] || id
    ~s(  #{mermaid_id(id)}["#{escape(label)}"])
  end

  defp mermaid_edge(edge) do
    line =
      if edge[:status] == "denied" do
        "-.->"
      else
        "-->"
      end

    ~s(  #{mermaid_id(edge.from)} #{line}|"#{edge.kind}"| #{mermaid_id(edge.to)})
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
