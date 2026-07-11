defmodule TownshipWeb.InstrumentLive do
  @moduledoc false

  use TownshipWeb, :live_view

  alias TownshipWeb.InstrumentSource

  @impl true
  def mount(_params, _session, socket) do
    case InstrumentSource.load() do
      {:ok, payload} ->
        {:ok,
         assign(socket,
           page_title: "Township Instrument",
           source_state: :verified,
           model: payload.read_model,
           causal_replay: payload.causal_replay,
           provenance: payload.provenance,
           op_counts: op_counts(payload.read_model.op_dag.nodes)
         )}

      {:error, {:bundle_unverified, errors}} ->
        {:ok,
         assign(socket,
           page_title: "Township Instrument Unavailable",
           source_state: :unverified,
           source_errors: errors
         )}
    end
  end

  defp op_counts(nodes) do
    %{
      total: length(nodes),
      honored: Enum.count(nodes, &(&1.status == "honored")),
      quarantined: Enum.count(nodes, &(&1.status == "quarantined"))
    }
  end
end
