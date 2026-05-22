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
    resume_proxy_ttl_ms = Keyword.get(opts, :resume_proxy_ttl_ms, 15_000)
    resume_buffer_size = Keyword.get(opts, :resume_buffer_size, 64)

    dispatch =
      :cowboy_router.compile([
        {:_,
         [
           {"/api/flagship/[...]", LatticeServer.FlagshipHandler, %{}},
           {"/api/federated-workers/run", LatticeServer.FederatedWorkersHandler, %{}},
           {"/api/session-token", LatticeServer.SessionTokenHandler, %{format: :json}},
           {"/session-token", LatticeServer.SessionTokenHandler, %{format: :text}},
           {"/ws", Lattice.Transport.WebSocket,
            %{
              grant_targets: grant_targets,
              auto_story?: auto_story?,
              resume_proxy_ttl_ms: resume_proxy_ttl_ms,
              resume_buffer_size: resume_buffer_size
            }},
           {:_, LatticeServer.StaticHandler, %{static_dir: static_dir}}
         ]}
      ])

    :cowboy.start_clear(
      listener,
      [{:ip, ip}, {:port, port}],
      %{
        env: %{dispatch: dispatch},
        idle_timeout: 10_000,
        max_header_name_length: 64,
        max_header_value_length: 4_096,
        max_headers: 64,
        max_keepalive: 20,
        max_request_line_length: 2_048,
        request_timeout: 5_000
      }
    )
  end

  def stop_http(listener \\ :lattice_demo_http) do
    :cowboy.stop_listener(listener)
  end
end
