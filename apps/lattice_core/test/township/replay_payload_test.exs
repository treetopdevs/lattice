defmodule Township.ReplayPayloadTest do
  use ExUnit.Case, async: true

  alias Lattice.Log
  alias Township.{ReadModel, ReplayPayload}

  @repo_root Path.expand("../../../..", __DIR__)
  @matter_path Path.join(@repo_root, "artifacts/township/matter.log")

  setup_all do
    :lattice_core
    |> Application.spec(:modules)
    |> Enum.each(&Code.ensure_loaded/1)

    :ok
  end

  test "builds and encodes the versioned replay contract from a matter log" do
    assert {:ok, log} = Log.restore(@matter_path)

    payload = ReplayPayload.build(log)

    assert payload == ReadModel.replay(log)
    assert payload["schema"] == ReplayPayload.schema()
    assert Jason.decode!(ReplayPayload.encode!(payload)) == payload
    assert Jason.decode!(ReplayPayload.encode!(log)) == payload
  end

  test "refuses to encode a value outside the replay contract" do
    assert_raise ArgumentError, fn -> ReplayPayload.encode!(%{"schema" => "future"}) end
  end

  test "refuses payloads that the browser normalizer cannot consume" do
    assert {:ok, log} = Log.restore(@matter_path)
    payload = ReplayPayload.build(log)

    assert_raise ArgumentError, ~r/frames must not be empty/, fn ->
      payload |> Map.put("frames", []) |> ReplayPayload.encode!()
    end

    [frame | rest] = payload["frames"]
    invalid_frame = Map.put(frame, "visible_ids", ["missing-op"])

    assert_raise ArgumentError, ~r/visible_ids references unknown node missing-op/, fn ->
      payload |> Map.put("frames", [invalid_frame | rest]) |> ReplayPayload.encode!()
    end
  end
end
