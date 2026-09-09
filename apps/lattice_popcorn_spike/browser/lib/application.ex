defmodule LatticeBrowser.Application do
  @moduledoc "Supervised, browser-local OTP signing realm. No server application is started."
  use Application

  @impl true
  def start(_type, _args) do
    Supervisor.start_link([LatticeBrowser.Realm, Popcorn.Proxy],
      strategy: :one_for_all,
      max_restarts: 0,
      name: LatticeBrowser.Supervisor
    )
  end
end
