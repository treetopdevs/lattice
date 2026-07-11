defmodule TownshipWeb.ReplayContractBridgeTest do
  use ExUnit.Case, async: true

  alias TownshipWeb.VerifiedInstrumentSnapshot

  @moduletag :node_bridge

  @repo_root Path.expand("../../../..", __DIR__)
  @bundle_dir Path.join(@repo_root, "artifacts/township")
  @normalizer Path.join(@repo_root, "apps/township_web/assets/js/replay_contract.js")

  test "the JavaScript normalizer accepts a real BEAM replay payload" do
    assert {:ok, snapshot} = VerifiedInstrumentSnapshot.load_bundle(@bundle_dir)

    payload_path =
      Path.join(
        System.tmp_dir!(),
        "township_replay_#{System.unique_integer([:positive])}.json"
      )

    on_exit(fn -> File.rm(payload_path) end)
    File.write!(payload_path, Jason.encode!(snapshot.causal_replay))

    script = """
    import fs from "node:fs";
    import { pathToFileURL } from "node:url";
    const normalizer = await import(pathToFileURL(process.argv[1]).href);
    const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const replay = normalizer.normalizeReplayPayload(payload);
    if (replay.frames.length !== payload.frames.length) process.exit(1);
    """

    {output, status} =
      System.cmd(
        node_executable(),
        ["--input-type=module", "--eval", script, @normalizer, payload_path],
        stderr_to_stdout: true
      )

    assert status == 0, output
  end

  defp node_executable do
    System.find_executable("node") || raise "node executable not found"
  end
end
