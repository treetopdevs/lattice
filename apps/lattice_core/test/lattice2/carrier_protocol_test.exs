defmodule Lattice.Carrier.ProtocolTest do
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Protocol

  test "request constructors round-trip through typed request decoding" do
    assert {:ok, :frontier} = Protocol.frontier_request() |> Protocol.decode_request()

    assert {:ok, {:pull, ["a", "b"]}} =
             ["b", "a"] |> Protocol.pull_request() |> Protocol.decode_request()

    assert {:ok, {:push, [%{"id" => "op-1"}]}} =
             [%{"id" => "op-1"}] |> Protocol.push_request() |> Protocol.decode_request()

    assert {:ok, {:live, %{"typing" => true}}} =
             %{"typing" => true} |> Protocol.live_request() |> Protocol.decode_request()

    assert {:ok, :status} = Protocol.status_request() |> Protocol.decode_request()
    assert {:ok, :state} = Protocol.state_request() |> Protocol.decode_request()
    assert {:ok, :shutdown} = Protocol.shutdown_request() |> Protocol.decode_request()
  end

  test "request decoding rejects malformed shapes and unknown vocabulary" do
    assert {:error, :malformed_request} =
             Protocol.decode_request(%{"type" => "pull", "have" => 1})

    assert {:error, :malformed_request} =
             Protocol.decode_request(%{"type" => "push", "ops" => :not_a_list})

    assert {:error, :unknown_type} = Protocol.decode_request(%{"type" => "future"})
    assert {:error, :malformed_request} = Protocol.decode_request(%{})
  end

  test "response constructors and decoders share one frame vocabulary" do
    report = %{accepted: ["op-1"], quarantined: [], rejected: [], pending: []}

    assert {:ok, ["a", "b"]} =
             ["b", "a"] |> Protocol.frontier_result() |> Protocol.decode_frontier_result()

    assert {:ok, [%{"id" => "op-1"}]} =
             [%{"id" => "op-1"}] |> Protocol.ops_result() |> Protocol.decode_ops_result()

    assert {:ok, ^report} = report |> Protocol.push_result() |> Protocol.decode_push_result()

    assert {:ok, "diverged"} =
             "diverged" |> Protocol.status_result() |> Protocol.decode_status_result()

    assert {:ok, %{"type" => "state_result", "log_size" => 2}} =
             %{log_size: 2}
             |> Protocol.state_result()
             |> Jason.encode!()
             |> Jason.decode!()
             |> Protocol.decode_state_result()

    assert :ok =
             %{live_seen: 1, log_size: 2}
             |> Protocol.live_result()
             |> Protocol.decode_live_result()

    assert {:ok, %{"type" => "shutdown_result"}} =
             Protocol.shutdown_result() |> Protocol.decode_shutdown_result()
  end

  test "response decoding reports peer errors and off-protocol replies consistently" do
    assert {:error, {:peer_error, "unauthenticated"}} =
             Protocol.error(:unauthenticated) |> Protocol.decode_status_result()

    assert {:error, {:unexpected_reply, "live_result"}} =
             %{type: "live_result"}
             |> Jason.encode!()
             |> Jason.decode!()
             |> Protocol.decode_status_result()
  end
end
