defmodule LatticeCarrierServer.Operator.JournalTest do
  use ExUnit.Case, async: false
  alias LatticeCarrierServer.Operator.Journal

  defmodule LocalSequence do
    def sync_file(path), do: LatticeCarrierServer.Durability.Posix.sync_file(path)
    def rename(a, b), do: File.rename(a, b)
    # Host-only fault/ordering adapter; never Linux directory durability evidence.
    def sync_directory(_), do: :ok
  end

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
      "attempt" => Base.encode64(:crypto.hash(:sha256, "attempt")),
      "generation" => 1,
      "catalog_head" => nil,
      "manifest_digest" => Journal.digest("manifest"),
      "artifacts" => [
        %{
          "path" => Path.join(root, "artifact"),
          "sha256" => Journal.digest("bytes"),
          "kind" => "manifest",
          "replica" => nil,
          "op_id" => nil
        }
      ]
    }

    assert :ok = Journal.compare_and_set(root, nil, record, LocalSequence)

    assert {:error, :stale_operator_intent} =
             Journal.compare_and_set(root, nil, %{record | "generation" => 2}, LocalSequence)

    assert {:ok, bytes} = Journal.read(root)
    assert {:ok, ^record} = Journal.decode(bytes)
  end

  defmodule RenameFailure do
    def sync_file(path), do: LocalSequence.sync_file(path)
    def rename(_, _), do: {:error, :injected_rename_failure}
    def sync_directory(_), do: :ok
  end

  defmodule DirectoryFailure do
    def sync_file(path), do: LocalSequence.sync_file(path)
    def rename(a, b), do: File.rename(a, b)
    def sync_directory(_), do: {:error, :injected_directory_failure}
  end

  defp record(root) do
    %{
      "version" => 1,
      "phase" => "carrier_pending",
      "attempt" => Base.encode64(:crypto.hash(:sha256, "attempt")),
      "generation" => 1,
      "catalog_head" => nil,
      "manifest_digest" => Journal.digest("manifest"),
      "artifacts" => [
        %{
          "path" => Path.join(root, "artifact"),
          "sha256" => Journal.digest("bytes"),
          "kind" => "manifest",
          "replica" => nil,
          "op_id" => nil
        }
      ]
    }
  end

  test "failed rename preserves old intent and failed post-rename sync never acknowledges", %{
    root: root
  } do
    old = record(root)
    assert :ok = Journal.compare_and_set(root, nil, old, LocalSequence)
    {:ok, raw} = Journal.read(root)
    next = %{old | "attempt" => Base.encode64(:crypto.hash(:sha256, "new")), "generation" => 2}

    assert {:error, :injected_rename_failure} =
             Journal.compare_and_set(root, raw, next, RenameFailure)

    assert {:ok, ^raw} = Journal.read(root)

    assert {:error, :injected_directory_failure} =
             Journal.compare_and_set(root, raw, next, DirectoryFailure)

    assert {:ok, new_raw} = Journal.read(root)
    assert {:ok, ^next} = Journal.decode(new_raw)

    assert {:error, :injected_directory_failure} =
             Journal.compare_and_set(root, new_raw, next, DirectoryFailure)

    assert :ok = Journal.compare_and_set(root, new_raw, next, LocalSequence)
  end

  test "same attempt cannot be rewritten and corruption preserves evidence", %{root: root} do
    old = record(root)
    :ok = Journal.compare_and_set(root, nil, old, LocalSequence)
    {:ok, raw} = Journal.read(root)

    assert {:error, :stale_operator_intent} =
             Journal.compare_and_set(root, raw, %{old | "generation" => 2}, LocalSequence)

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
