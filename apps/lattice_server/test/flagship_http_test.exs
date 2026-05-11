defmodule LatticeServer.FlagshipHttpTest do
  use ExUnit.Case, async: false

  alias LatticeServer.TestSupport.HTTP

  setup do
    Lattice.Flagship.reset()
    listener = :"lattice_flagship_http_test_#{System.unique_integer([:positive])}"
    port = HTTP.free_port()

    {:ok, _pid} =
      LatticeServer.start_http(
        listener: listener,
        port: port,
        static_dir: Path.expand("../../../examples/flagship_demo", __DIR__),
        auto_story?: false,
        grant_targets: %{}
      )

    on_exit(fn -> LatticeServer.stop_http(listener) end)

    {:ok, port: port}
  end

  test "flagship HTTP API serves UI, runs story, and exports graph", %{port: port} do
    assert {:ok, 200, html} = HTTP.http_get(port, "/")
    assert html =~ "Live process/trust graph inspector"

    assert {:ok, 200, snapshot_head, snapshot_body} =
             HTTP.raw_http_with_head(port, "GET", "/api/flagship/snapshot")

    refute Map.has_key?(Jason.decode!(snapshot_body), "action_token")
    assert action_cookie_from_head(snapshot_head) =~ "lattice_flagship_token="

    assert {:ok, 403, forbidden} = HTTP.raw_http(port, "POST", "/api/flagship/run_all")
    assert %{"error" => "forbidden"} = Jason.decode!(forbidden)

    assert {:ok, 403, forbidden} =
             HTTP.raw_http(port, "POST", "/api/flagship/run_all", [
               {"cookie", "lattice_flagship_token=not-the-token"}
             ])

    assert %{"error" => "forbidden"} = Jason.decode!(forbidden)

    assert {:ok, cookie} = action_cookie(port)

    assert {:ok, 403, forbidden} =
             HTTP.raw_http(port, "POST", "/api/flagship/run_all", [
               {"cookie", cookie},
               {"origin", "http://evil.example"}
             ])

    assert %{"error" => "forbidden"} = Jason.decode!(forbidden)

    assert {:ok, 413, too_large} =
             HTTP.raw_http(
               port,
               "POST",
               "/api/flagship/run_all",
               [{"cookie", cookie}, {"origin", "http://localhost:#{port}"}],
               String.duplicate("x", 1_025)
             )

    assert %{"error" => "request_body_too_large"} = Jason.decode!(too_large)

    assert {:ok, snapshot} = post_json(port, "/api/flagship/run_all")
    refute Map.has_key?(snapshot, "action_token")
    assert snapshot["wallet"]["delivery_count"] == 1
    assert snapshot["presenter"]["next_action"] =~ "inspect"
    assert snapshot["results"]["over_budget"]["delivered_to_wallet?"] == false
    assert snapshot["results"]["stolen"]["result"]["error"] == ":wrong_owner"
    assert snapshot["results"]["replay"]["result"]["error"] == ":revoked"
    assert_expected_results(snapshot)

    assert {:ok, 200, exported_json} = HTTP.http_get(port, "/api/flagship/export/json")
    refute Map.has_key?(Jason.decode!(exported_json), "action_token")

    assert {:ok, 200, mermaid} = HTTP.http_get(port, "/api/flagship/export/mermaid")
    assert mermaid =~ "graph TD"

    assert {:ok, 200, claims} = HTTP.http_get(port, "/api/flagship/claims")
    assert [%{"id" => "capability_wallet_edge"} | _] = Jason.decode!(claims)

    assert {:ok, 200, head, _body} =
             HTTP.raw_http_with_head(port, "GET", "/api/flagship/snapshot")

    refute String.downcase(head) =~ "access-control-allow-origin"
  end

  test "flagship action cookie is consumed once", %{port: port} do
    assert {:ok, cookie} = action_cookie(port)

    assert {:ok, 200, _head, _body} =
             HTTP.raw_http_with_head(port, "POST", "/api/flagship/reset", [{"cookie", cookie}])

    assert {:ok, 403, forbidden} =
             HTTP.raw_http(port, "POST", "/api/flagship/reset", [{"cookie", cookie}])

    assert %{"error" => "forbidden"} = Jason.decode!(forbidden)
  end

  defp post_json(port, path) do
    with {:ok, cookie} <- action_cookie(port),
         {:ok, status, body} when status in 200..299 <-
           HTTP.raw_http(port, "POST", path, [{"cookie", cookie}]) do
      {:ok, Jason.decode!(body)}
    end
  end

  defp action_cookie(port) do
    with {:ok, 200, head, body} <- HTTP.raw_http_with_head(port, "GET", "/api/flagship/snapshot"),
         snapshot when is_map(snapshot) <- Jason.decode!(body),
         nil <- Map.get(snapshot, "action_token"),
         cookie when is_binary(cookie) <- action_cookie_from_head(head) do
      {:ok, cookie}
    end
  end

  defp action_cookie_from_head(head) do
    HTTP.cookie_from_head(head, "lattice_flagship_token")
  end

  defp assert_expected_results(snapshot) do
    snapshot["story"]
    |> Enum.filter(&Map.has_key?(&1, "expected_result"))
    |> Enum.each(fn step ->
      result = Map.fetch!(snapshot["results"], step["id"])
      expected = step["expected_result"]

      assert result["expected_result"] == expected
      assert result["result"]["ok"] == expected["ok"]
      assert result["delivered_to_wallet?"] == expected["delivered_to_wallet?"]

      if Map.has_key?(expected, "error") do
        assert result["result"]["error"] == expected["error"]
      end
    end)
  end
end
