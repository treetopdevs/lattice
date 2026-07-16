defmodule TownshipWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :township_web

  @session_options [
    store: :cookie,
    key: "_township_web_key",
    signing_salt: "township-session",
    same_site: "Lax"
  ]

  socket("/live", Phoenix.LiveView.Socket,
    websocket: [connect_info: [session: @session_options]],
    longpoll: false
  )

  plug(Plug.Static,
    at: "/",
    from: :township_web,
    gzip: false,
    only: ~w(assets favicon.ico robots.txt)
  )

  plug(Plug.RequestId)
  plug(Plug.Telemetry, event_prefix: [:phoenix, :endpoint])

  plug(Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()
  )

  plug(Plug.MethodOverride)
  plug(Plug.Head)
  plug(Plug.Session, @session_options)
  plug(TownshipWeb.Router)
end
