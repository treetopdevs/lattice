defmodule Treehouse.NativePreviewReciprocalTest do
  use ExUnit.Case, async: false

  Code.require_file(Path.expand("../../../../scripts/treehouse_verify_preview.exs", __DIR__))

  test "the app workflow's exact signed frames match BEAM state, identity, order and restored evidence" do
    root = Path.expand("../../../..", __DIR__)
    client = Path.join(root, "clients/treehouse-tauri-shell")

    artifact =
      Path.join(System.tmp_dir!(), "treehouse-preview-#{System.unique_integer([:positive])}.json")

    on_exit(fn -> File.rm(artifact) end)

    {output, status} =
      System.cmd(Path.join(client, "node_modules/.bin/tsx"), ["test/workflow.ts"],
        cd: client,
        env: [{"TREEHOUSE_WORKFLOW_ARTIFACT", artifact}],
        stderr_to_stdout: true
      )

    assert status == 0, output
    captured = artifact |> File.read!() |> Jason.decode!()
    assert :ok = Treehouse.NativePreviewOracle.verify!(captured)
    wrong_identity = Map.put(captured, "publicKey", Base.encode64(:binary.copy(<<1>>, 32)))
    assert_raise MatchError, fn -> Treehouse.NativePreviewOracle.verify!(wrong_identity) end
  end
end
