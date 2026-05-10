defmodule LatticeServer do
  @moduledoc """
  Lightweight HTTP/WebSocket server for the browser-facing Lattice demo.
  """

  def start_http(opts \\ []) do
    port = Keyword.get(opts, :port, 4040)
    ip = Keyword.get(opts, :ip, {127, 0, 0, 1})
    listener = Keyword.get(opts, :listener, :lattice_demo_http)
    static_dir = Keyword.get(opts, :static_dir, Path.expand("examples/browser_demo", File.cwd!()))
    grant_targets = Keyword.get(opts, :grant_targets, %{})
    auto_story? = Keyword.get(opts, :auto_story?, true)

    dispatch =
      :cowboy_router.compile([
        {:_,
         [
           {"/api/flagship/[...]", LatticeServer.FlagshipHandler, %{}},
           {"/ws", Lattice.Transport.WebSocket,
            %{grant_targets: grant_targets, auto_story?: auto_story?}},
           {:_, LatticeServer.StaticHandler, %{static_dir: static_dir}}
         ]}
      ])

    :cowboy.start_clear(listener, [{:ip, ip}, {:port, port}], %{env: %{dispatch: dispatch}})
  end

  def stop_http(listener \\ :lattice_demo_http) do
    :cowboy.stop_listener(listener)
  end
end
