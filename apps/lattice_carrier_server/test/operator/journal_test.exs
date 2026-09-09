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

  test "an artifact path outside the operator root is refused on write", %{root: root} do
    sibling = root <> "-sibling"
    outside = put_in(record(root), ["artifacts", Access.at(0), "path"], Path.join(sibling, "x"))

    assert {:error, :corrupt_operator_journal} = Journal.compare_and_set(root, nil, outside)
    assert {:ok, nil} = Journal.read(root)
  end

  test "a `..`-traversal artifact path is refused even textually prefixed by root", %{
    root: root
  } do
    traversal = put_in(record(root), ["artifacts", Access.at(0), "path"], root <> "/../escape")

    assert {:error, :corrupt_operator_journal} = Journal.compare_and_set(root, nil, traversal)
    assert {:ok, nil} = Journal.read(root)
  end

  test "read refuses a stored journal whose artifact path was rewritten outside the root", %{
    root: root
  } do
    good = record(root)
    :ok = Journal.compare_and_set(root, nil, good)
    {:ok, raw} = Journal.read(root)
    tampered = String.replace(raw, Path.join(root, "artifact"), "/tmp/escaped-artifact")
    refute tampered == raw
    File.write!(Journal.path(root), tampered)

    assert {:error, :corrupt_operator_journal} = Journal.read(root)
  end

  test "encode writes a fixed canonical field order that decode agrees with", %{root: root} do
    # `decode/1` deliberately refuses anything that is not byte-identical to
    # this canonical form (that is what catches tampering/corruption), so the
    # regression this guards against is write and read silently drifting
    # apart onto two different incidental orders — not decode accepting an
    # arbitrary reordering. Assert the concrete, fixed field order instead:
    # a future Elixir/Jason change to ordinary map iteration cannot move it.
    encoded = Journal.encode(record(root))
    assert {:ok, decoded} = Journal.decode(encoded)
    assert decoded == record(root)

    [artifact_json] = Regex.run(~r/"artifacts":\[(\{.*\})\]/, encoded, capture: :all_but_first)

    assert_ordered(
      encoded,
      ~w(version phase attempt generation catalog_head manifest_digest artifacts)
    )

    assert_ordered(artifact_json, ~w(kind op_id path replica review sha256))

    # Encoding is a pure function of the record's values, not of whatever
    # order its keys happened to be inserted in.
    shuffled = Map.new(Enum.shuffle(Map.to_list(record(root))))
    assert Journal.encode(shuffled) == encoded
  end

  defp assert_ordered(json, fields) do
    positions =
      Enum.map(fields, fn field ->
        {index, _len} = :binary.match(json, "\"#{field}\":")
        index
      end)

    assert positions == Enum.sort(positions)
  end

  test "secure_root refuses rather than raising when `id -u` exits nonzero", %{root: root} do
    decoy_dir = Path.expand(".operator-decoy-#{System.unique_integer([:positive])}", File.cwd!())
    File.mkdir!(decoy_dir)
    decoy_id = Path.join(decoy_dir, "id")
    File.write!(decoy_id, "#!/bin/sh\nexit 1\n")
    File.chmod!(decoy_id, 0o755)
    original_path = System.get_env("PATH")
    System.put_env("PATH", decoy_dir <> ":" <> original_path)

    on_exit(fn ->
      System.put_env("PATH", original_path)
      File.rm_rf!(decoy_dir)
    end)

    assert {:error, :unsafe_operator_directory} = Journal.secure_root(root)
  end
end
