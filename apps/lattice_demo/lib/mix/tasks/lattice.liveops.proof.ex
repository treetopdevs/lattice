defmodule Mix.Tasks.Lattice.Liveops.Proof do
  @moduledoc """
  Runs a deterministic LiveOps story through the WebSocket gateway and writes artifacts.
  """

  use Mix.Task

  alias Lattice.Transport.WebSocket.Client

  @shortdoc "Run the deterministic Lattice LiveOps proof"

  @impl true
  def run(args) do
    Mix.Task.run("app.start")

    {opts, _rest, _invalid} =
      OptionParser.parse(args,
        strict: [out: :string, port: :integer]
      )

    out_dir = Keyword.get(opts, :out, "output/liveops")
    port = Keyword.get(opts, :port, free_port())
    listener = :"lattice_liveops_proof_#{System.unique_integer([:positive])}"

    File.mkdir_p!(out_dir)
    Lattice.reset!()
    LatticeServer.DemoHub.reset()

    {:ok, _pid} =
      LatticeServer.start_http(
        listener: listener,
        port: port,
        auto_story?: false,
        static_dir: Path.expand("examples/liveops_demo", File.cwd!())
      )

    Process.put(:liveops_clients, [])

    try do
      producer = connect_role(:producer, port)
      graphics = connect_role(:graphics_operator, port)
      camera = connect_role(:remote_camera, port)
      observer = connect_role(:observer, port)

      results = []

      results = [
        result(:denied_before_approval, fn ->
          send_action(graphics, "publish", "missing-publish-cap", %{
            request_id: "approval-missing"
          })
        end)
        | results
      ]

      preview_cap = cap_for(graphics.tab_id, "preview_overlay")

      results = [
        result(:preview_allowed, fn ->
          send_action(graphics, "preview_overlay", preview_cap, %{
            overlay: "LiveOps CI lower third"
          })
        end)
        | results
      ]

      request_cap = cap_for(graphics.tab_id, "request_publish")

      {:ok, request_result} =
        send_action(graphics, "request_publish", request_cap, %{overlay: "LiveOps CI lower third"})

      approval_id = request_result["result"]["approval_id"]

      approve_cap = cap_for(producer.tab_id, "approve_publish")

      {:ok, approve_result} =
        send_action(producer, "approve_publish", approve_cap, %{
          request_id: approval_id,
          ttl_ms: 30_000
        })

      publish_cap = approve_result["result"]["publish_cap_id"]

      results = [
        result(:publish_after_approval, fn ->
          send_action(graphics, "publish", publish_cap, %{
            request_id: approval_id,
            overlay: "LiveOps CI lower third"
          })
        end)
        | results
      ]

      results = [
        result(:replay_after_revoke_denied, fn ->
          send_action(graphics, "publish", publish_cap, %{request_id: approval_id})
        end)
        | results
      ]

      expired_approval = request_publish(graphics, "Expired CI lower third")

      {:ok, expired_result} =
        send_action(producer, "approve_publish", approve_cap, %{
          request_id: expired_approval,
          ttl_ms: -1
        })

      expired_cap = expired_result["result"]["publish_cap_id"]

      results = [
        result(:expired_approval_denied, fn ->
          send_action(graphics, "publish", expired_cap, %{request_id: expired_approval})
        end)
        | results
      ]

      observe_cap = cap_for(observer.tab_id, "observe")

      results = [
        result(:wrong_role_publish_denied, fn ->
          send_action(observer, "publish", observe_cap, %{request_id: approval_id})
        end)
        | results
      ]

      camera_cap = cap_for(camera.tab_id, "camera_frame")
      tally_cap = cap_for(camera.tab_id, "set_tally")

      results = [
        result(:camera_frame_allowed, fn ->
          send_action(camera, "camera_frame", camera_cap, %{frame: "ci-frame-001"})
        end),
        result(:tally_allowed, fn ->
          send_action(camera, "set_tally", tally_cap, %{state: "on-air"})
        end)
        | results
      ]

      disconnect(camera)
      replacement_camera = connect_role(:remote_camera, port)

      results = [
        result(:reconnect_stale_camera_cap_denied, fn ->
          send_action(replacement_camera, "camera_frame", camera_cap, %{frame: "stale-ci-frame"})
        end)
        | results
      ]

      disconnect_request = request_publish(graphics, "Disconnect race lower third")
      disconnect(graphics)

      results = [
        result(:disconnect_during_approval_denied, fn ->
          send_action(producer, "approve_publish", approve_cap, %{
            request_id: disconnect_request,
            ttl_ms: 30_000
          })
        end)
        | results
      ]

      results = Enum.reverse(results)
      assert_expected_results!(results)
      write_artifacts(out_dir, port, results)

      IO.puts("Lattice LiveOps proof passed at http://localhost:#{port}")
      IO.puts("artifacts: #{Path.expand(out_dir)}")
    after
      Enum.each(Process.get(:liveops_clients, []), &safe_close/1)
      LatticeServer.stop_http(listener)
    end
  end

  defp connect_role(role, port) do
    {:ok, client} = Client.connect(port: port)
    Process.put(:liveops_clients, [client | Process.get(:liveops_clients, [])])

    :ok =
      Client.send_envelope(client, %{
        type: "hello",
        identity: %{surface: "liveops-demo", role: Atom.to_string(role)}
      })

    {:ok, %{"type" => "welcome", "tab_id" => tab_id}} = recv_type(client, "welcome")
    %{client: client, tab_id: tab_id, role: role}
  end

  defp request_publish(actor, overlay) do
    cap = cap_for(actor.tab_id, "request_publish")
    {:ok, result} = send_action(actor, "request_publish", cap, %{overlay: overlay})
    result["result"]["approval_id"]
  end

  defp send_action(actor, action, cap_id, payload, target \\ nil) do
    envelope =
      %{
        type: "liveops_action",
        action: action,
        cap_id: cap_id,
        payload: payload
      }
      |> maybe_put(:target, target)

    :ok = Client.send_envelope(actor.client, envelope)

    case recv_type(actor.client, "liveops_result") do
      {:ok, %{"ok" => true} = result} -> {:ok, result}
      {:ok, %{"ok" => false} = result} -> {:denied, result}
      other -> other
    end
  end

  defp result(name, fun) do
    case fun.() do
      {:ok, body} -> %{name: name, status: :allowed, body: body}
      {:denied, body} -> %{name: name, status: :denied, body: body}
      {:error, reason} -> %{name: name, status: :error, reason: inspect(reason)}
    end
  end

  defp assert_expected_results!(results) do
    expected = %{
      denied_before_approval: :denied,
      preview_allowed: :allowed,
      publish_after_approval: :allowed,
      replay_after_revoke_denied: :denied,
      expired_approval_denied: :denied,
      wrong_role_publish_denied: :denied,
      camera_frame_allowed: :allowed,
      tally_allowed: :allowed,
      reconnect_stale_camera_cap_denied: :denied,
      disconnect_during_approval_denied: :denied
    }

    Enum.each(results, fn result ->
      expected_status = Map.fetch!(expected, result.name)

      if result.status != expected_status do
        Mix.raise(
          "LiveOps proof step #{result.name} expected #{expected_status}, got #{result.status}"
        )
      end
    end)
  end

  defp cap_for(tab_id, action) do
    Lattice.LiveOps.snapshot().caps
    |> Enum.find(fn cap ->
      cap.owner_tab_id == tab_id and cap.action == action and cap.status == "active"
    end)
    |> case do
      nil -> Mix.raise("missing active cap #{action} for #{tab_id}")
      cap -> cap.id
    end
  end

  defp disconnect(actor) do
    :ok = Client.send_envelope(actor.client, %{type: "disconnect"})
    _ = recv_type(actor.client, "disconnect_result")
    :ok
  end

  defp write_artifacts(out_dir, port, results) do
    snapshot = Lattice.LiveOps.snapshot()
    audit = Lattice.audit_events()

    summary = %{
      port: port,
      result_count: length(results),
      results: results,
      counters: snapshot.counters,
      artifact_version: 1
    }

    File.write!(
      Path.join(out_dir, "liveops-topology.json"),
      Jason.encode!(snapshot, pretty: true)
    )

    File.write!(Path.join(out_dir, "liveops-topology.mmd"), Lattice.LiveOps.export(:mermaid))
    File.write!(Path.join(out_dir, "liveops-audit.json"), Jason.encode!(audit, pretty: true))
    File.write!(Path.join(out_dir, "liveops-summary.json"), Jason.encode!(summary, pretty: true))
  end

  defp recv_type(client, type, timeout \\ 5_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_recv_type(client, type, deadline)
  end

  defp do_recv_type(client, type, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 1)

    case Client.recv_envelope(client, remaining) do
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

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp safe_close(client) do
    Client.close(client)
  catch
    :exit, _reason -> :ok
  end
end
