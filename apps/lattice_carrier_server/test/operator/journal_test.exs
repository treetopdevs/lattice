defmodule LatticeCarrierServer.Operator.JournalTest do
  use ExUnit.Case, async: false
  if :os.type() != {:unix, :linux}, do: @moduletag(skip: "Requires actual Linux OS lock")
  alias LatticeCarrierServer.Operator.Journal

  setup do
    root = Path.expand(".operator-test-#{System.unique_integer([:positive])}", File.cwd!())
    File.mkdir!(root)
    File.chmod!(root, 0o700)
    on_exit(fn -> File.rm_rf!(root) end)
    {:ok, root: root}
  end

  test "stale complete journal cannot replace retained candidate", %{root: root} do
    record = %{
      "version" => 1,
      "phase" => "carrier_pending",
      "attempt" => Base.url_encode64(:crypto.hash(:sha256, "attempt"), padding: false),
      "generation" => 1,
      "catalog_head" => nil,
      "manifest_digest" => Journal.digest("manifest"),
      "artifacts" => [
        %{
          "path" => Path.join(root, "artifact"),
          "sha256" => Journal.digest("bytes"),
          "kind" => "manifest",
          "review" => nil,
          "replica" => nil,
          "op_id" => nil
        }
      ]
    }

    assert :ok = Journal.compare_and_set(root, nil, record)

    assert {:error, {:operator_refused, "stale_operator_intent"}} =
             Journal.compare_and_set(root, nil, %{record | "generation" => 2})

    assert {:ok, bytes} = Journal.read(root)
    assert {:ok, ^record} = Journal.decode(bytes)
  end

  defp record(root) do
    %{
      "version" => 1,
      "phase" => "carrier_pending",
      "attempt" => Base.url_encode64(:crypto.hash(:sha256, "attempt"), padding: false),
      "generation" => 1,
      "catalog_head" => nil,
      "manifest_digest" => Journal.digest("manifest"),
      "artifacts" => [
        %{
          "path" => Path.join(root, "artifact"),
          "sha256" => Journal.digest("bytes"),
          "kind" => "manifest",
          "review" => nil,
          "replica" => nil,
          "op_id" => nil
        }
      ]
    }
  end

  test "same attempt cannot be rewritten and corruption preserves evidence", %{root: root} do
    old = record(root)
    :ok = Journal.compare_and_set(root, nil, old)
    {:ok, raw} = Journal.read(root)

    assert {:error, {:operator_refused, "stale_operator_intent"}} =
             Journal.compare_and_set(root, raw, %{old | "generation" => 2})

    for corrupt <- [
          "{}",
          raw <> "garbage",
          String.replace(raw, "\"version\":1", "\"version\":1,\"version\":1")
        ] do
      File.write!(Journal.path(root), corrupt)
      assert {:error, :corrupt_operator_journal} = Journal.read(root)
      assert File.read!(Journal.path(root)) == corrupt
    end
  end

  test "journal and directory symlinks refuse without touching their targets", %{root: root} do
    target = Path.join(root, "target")
    File.write!(target, "untouched")
    File.ln_s!(target, Journal.path(root))
    assert {:error, :corrupt_operator_journal} = Journal.read(root)
    assert File.read!(target) == "untouched"
    alias_path = root <> "-alias"
    File.ln_s!(root, alias_path)
    on_exit(fn -> File.rm(alias_path) end)
    assert {:error, :unsafe_operator_directory} = Journal.read(alias_path)
  end
end
