defmodule Mix.Tasks.Lattice.Demo do
  @moduledoc """
  Runs the deterministic Lattice POC demo over the real WebSocket boundary.
  """

  use Mix.Task

  @shortdoc "Run the Lattice demo; pass a port to serve the browser demo"

  @impl true
  def run([]) do
    Mix.Task.run("app.start")
    Lattice.reset!()
    LatticeServer.DemoHub.reset()

    port = free_port()
    listener = :"lattice_demo_http_#{System.unique_integer([:positive])}"

    {:ok, _pid} =
      LatticeServer.start_http(
        listener: listener,
        port: port,
        auto_story?: false,
        grant_targets: %{"echo" => Lattice.Demo.EchoServer, {"echo", :ops} => ["call", "cast"]}
      )

    {:ok, tab_a_client} = Lattice.Transport.WebSocket.Client.connect(port: port)
    {:ok, tab_b_client} = Lattice.Transport.WebSocket.Client.connect(port: port)

    {:ok, tab_a} = hello(tab_a_client, "alice")
    {:ok, tab_b} = hello(tab_b_client, "bob")
    {:ok, echo_cap} = request_echo_cap(tab_a_client)
    {:ok, worker} = Lattice.spawn_linked(tab_a["tab_id"], Lattice.Demo.TabWorker, [], [])

    allowed = ws_call(tab_a_client, echo_cap["id"], %{message: "hello from tab A"})
    stolen = ws_call(tab_b_client, echo_cap["id"], %{message: "I should fail"})
    secret = ws_call(tab_a_client, "not-a-real-cap", %{target: "secret"})

    {:ok, bridge_cap} = Lattice.bridge(tab_a["tab_id"], tab_b["tab_id"], [:call], ttl: 10_000)
    bridge = mediated_bridge_call(tab_a_client, tab_b_client, bridge_cap.id)

    disconnected = disconnect(tab_a_client)
    worker_alive? = Process.alive?(worker)

    IO.puts("Lattice POC demo")
    IO.puts("transport: real WebSocket")
    IO.puts("tab A: #{tab_a["tab_id"]}")
    IO.puts("tab B: #{tab_b["tab_id"]}")
    IO.puts("tab A echo call: #{inspect(allowed)}")
    IO.puts("tab B using tab A cap: #{inspect(stolen)}")
    IO.puts("tab A reaching secret without grant: #{inspect(secret)}")
    IO.puts("bridge call A -> B: #{inspect(bridge)}")
    IO.puts("disconnect tab A: #{inspect(disconnected)}")
    IO.puts("tab A worker alive after disconnect?: #{inspect(worker_alive?)}")
    IO.puts("audit events:")

    Enum.each(Lattice.audit_events(), fn event ->
      IO.puts("  #{event.id}. #{event.type} #{inspect(event.metadata)}")
    end)

    Lattice.Transport.WebSocket.Client.close(tab_b_client)
    LatticeServer.stop_http(listener)
  end

  def run([port_arg]) do
    Mix.Task.run("app.start")
    Lattice.reset!()
    LatticeServer.DemoHub.reset()

    port = String.to_integer(port_arg)

    {:ok, _pid} =
      LatticeServer.start_http(
        port: port,
        grant_targets: %{"echo" => Lattice.Demo.EchoServer, {"echo", :ops} => ["call", "cast"]}
      )

    IO.puts("Lattice browser demo listening on http://localhost:#{port}")
    IO.puts("Press Ctrl-C twice to stop.")
    Process.sleep(:infinity)
  end

  defp hello(client, user) do
    :ok =
      Lattice.Transport.WebSocket.Client.send_envelope(client, %{
        type: "hello",
        identity: %{user: user}
      })

    recv_type(client, "welcome")
  end

  defp request_echo_cap(client) do
    :ok =
      Lattice.Transport.WebSocket.Client.send_envelope(client, %{
        type: "grant_request",
        target: "echo"
      })

    with {:ok, %{"type" => "grant", "cap" => cap}} <-
           recv_type(client, "grant") do
      {:ok, cap}
    end
  end

  defp ws_call(client, cap_id, payload) do
    :ok =
      Lattice.Transport.WebSocket.Client.send_envelope(client, %{
        type: "call",
        cap_id: cap_id,
        payload: payload
      })

    recv_type(client, "call_result")
  end

  defp mediated_bridge_call(tab_a_client, tab_b_client, bridge_cap_id) do
    task =
      Task.async(fn ->
        ws_call(tab_a_client, bridge_cap_id, %{op: "relay", body: "mediated hello"})
      end)

    with {:ok, %{"type" => "tab_call", "request_id" => request_id, "payload" => payload}} <-
           recv_type(tab_b_client, "tab_call"),
         :ok <-
           Lattice.Transport.WebSocket.Client.send_envelope(tab_b_client, %{
             type: "tab_render_result",
             request_id: request_id,
             result: %{relayed: payload}
           }) do
      Task.await(task)
    end
  end

  defp disconnect(client) do
    :ok = Lattice.Transport.WebSocket.Client.send_envelope(client, %{type: "disconnect"})
    recv_type(client, "disconnect_result")
  end

  defp recv_type(client, type, timeout \\ 5_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_recv_type(client, type, deadline)
  end

  defp do_recv_type(client, type, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 1)

    case Lattice.Transport.WebSocket.Client.recv_envelope(client, remaining) do
      {:ok, %{"type" => ^type} = envelope} -> {:ok, envelope}
      {:ok, _other} -> do_recv_type(client, type, deadline)
      {:error, reason} -> {:error, reason}
    end
  end

  defp free_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false])
    {:ok, port} = :inet.port(socket)
    :gen_tcp.close(socket)
    port
  end
end
