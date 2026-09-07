defmodule LatticeCarrierServer.Operator.LauncherTest do
  use ExUnit.Case, async: false
  @launcher Path.expand("../../../../scripts/treehouse_operator.sh", __DIR__)

  if :os.type() != {:unix, :linux} do
    test "unsupported host refuses without executing the requested mutation" do
      assert {"unsupported_operator_platform\n", 78} =
               System.cmd(@launcher, ["/", "/bin/false"], stderr_to_stdout: true)
    end
  end

  if :os.type() != {:unix, :linux} do
    test "direct journal mutation cannot bypass OS lock on unsupported host" do
      root = Path.expand(".operator-direct-#{System.unique_integer([:positive])}", File.cwd!())
      File.mkdir!(root)
      File.chmod!(root, 0o700)
      on_exit(fn -> File.rm_rf!(root) end)

      record = %{
        "version" => 1,
        "phase" => "carrier_pending",
        "attempt" => Base.url_encode64(<<0::256>>, padding: false),
        "generation" => 0,
        "catalog_head" => nil,
        "manifest_digest" => LatticeCarrierServer.Operator.Journal.digest("manifest"),
        "artifacts" => [
          %{
            "kind" => "manifest",
            "review" => nil,
            "op_id" => nil,
            "replica" => nil,
            "path" => Path.join(root, "artifact"),
            "sha256" => LatticeCarrierServer.Operator.Journal.digest("artifact")
          }
        ]
      }

      assert {:error, :unsupported_operator_platform} =
               LatticeCarrierServer.Operator.Journal.compare_and_set(root, nil, record)

      refute File.exists?(LatticeCarrierServer.Operator.Journal.path(root))
    end
  end
end
