defmodule TownshipWeb.Router do
  use TownshipWeb, :router

  @secure_browser_headers %{
    "content-security-policy" =>
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " <>
        "font-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; " <>
        "object-src 'none'; form-action 'self'"
  }

  pipeline :browser do
    plug(:accepts, ["html"])
    plug(:fetch_session)
    plug(:fetch_live_flash)
    plug(:put_root_layout, html: {TownshipWeb.Layouts, :root})
    plug(:protect_from_forgery)
    plug(:put_secure_browser_headers, @secure_browser_headers)
  end

  scope "/", TownshipWeb do
    pipe_through(:browser)

    live("/", InstrumentLive, :show)
    live("/township", InstrumentLive, :show)
  end
end
