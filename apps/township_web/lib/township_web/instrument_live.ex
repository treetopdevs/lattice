defmodule TownshipWeb.InstrumentLive do
  @moduledoc false

  use TownshipWeb, :live_view

  alias TownshipWeb.InstrumentSource

  @impl true
  def mount(_params, _session, socket) do
    case InstrumentSource.load() do
      {:ok, snapshot} ->
        {:ok,
         assign(socket,
           page_title: "Township Instrument",
           source_state: :verified,
           snapshot: snapshot
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
end
