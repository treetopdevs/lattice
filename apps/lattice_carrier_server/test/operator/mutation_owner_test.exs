defmodule LatticeCarrierServer.Operator.MutationOwnerTest do
  use ExUnit.Case, async: false
  alias LatticeCarrierServer.Operator.Journal
  @helper Path.expand("../../../../scripts/treehouse_operator_mutation.py", __DIR__)
  if :os.type() != {:unix, :linux},
    do: @moduletag(skip: "Actual Linux mutation-owner proof required")

  test "real journal mutation refuses while other mutation owner holds FD and proceeds after its death" do
    root = Path.expand(".operator-owner-#{System.unique_integer([:positive])}", File.cwd!())
    File.mkdir!(root)
    File.chmod!(root, 0o700)
    on_exit(fn -> File.rm_rf!(root) end)
    manifest = Path.join(root, "active.json")
    File.write!(manifest, "manifest")
    File.chmod!(manifest, 0o600)
    bytes = "public-artifact"
    attempt = Base.url_encode64(:crypto.hash(:sha256, "owner"), padding: false)

    artifact_path =
      LatticeCarrierServer.Operator.Staging.artifact_path(root, attempt, Journal.digest(bytes))

    record = %{
      "version" => 1,
      "phase" => "carrier_pending",
      "attempt" => attempt,
      "generation" => 0,
      "catalog_head" => nil,
      "manifest_digest" => Journal.digest("manifest"),
      "artifacts" => [
        %{
          "kind" => "manifest",
          "op_id" => nil,
          "replica" => nil,
          "review" => nil,
          "path" => artifact_path,
          "sha256" => Journal.digest(bytes)
        }
      ]
    }

    plan = %{
      version: 1,
      kind: "stage",
      expected: nil,
      record: nil,
      attempt: attempt,
      checks: [%{path: manifest, sha256: Journal.digest("manifest")}],
      artifacts: [%{sha256: Journal.digest(bytes), bytes: Base.encode64(bytes)}]
    }

    port =
      Port.open({:spawn_executable, System.find_executable("python3")}, [
        :binary,
        :exit_status,
        {:line, 1024},
        args: [@helper, root]
      ])

    on_exit(fn -> if Port.info(port) != nil, do: Port.close(port) end)
    true = Port.command(port, Jason.encode!(plan) <> "\n")
    assert_receive {^port, {:data, {:eol, staged}}}, 5_000
    assert Jason.decode!(staged) == %{"staged" => true}

    assert {:error, {:operator_refused, "operator_busy"}} =
             Journal.compare_and_set(root, nil, record)

    refute File.exists?(Journal.path(root))
    {:os_pid, pid} = Port.info(port, :os_pid)
    assert {_, 0} = System.cmd("kill", ["-KILL", Integer.to_string(pid)])
    assert_receive {^port, {:exit_status, _}}, 5_000
    # No keeper exists to perform a late write; the successor itself acquires flock.
    assert :ok = Journal.compare_and_set(root, nil, record)
    assert {:ok, raw} = Journal.read(root)
    assert {:ok, ^record} = Journal.decode(raw)
    assert File.read!(artifact_path) == bytes
  end
end
