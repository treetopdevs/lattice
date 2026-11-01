defmodule LatticeCarrierServer.Operator.CatalogEvidence.WorkflowTest do
  use ExUnit.Case, async: true
  alias Lattice.{Log, Op}
  alias Lattice.Carrier.Wire

  alias LatticeCarrierServer.Operator.{
    CatalogEvidence.Packet,
    CatalogEvidence.Workflow,
    PublicHistory
  }

  alias Treehouse.{CatalogTrustVectors, TransportCatalog}

  @history_bytes 1_048_576

  setup do
    fixture = CatalogTrustVectors.fixture()

    histories =
      Map.new([fixture.space_log | Enum.map(fixture.threads, & &1.log)], &{&1.replica, &1})

    %{f: fixture, histories: histories, head: TransportCatalog.catalog_id(fixture.catalog)}
  end

  test "a genuine listed snapshot's first-install record is a PreviewState under 1 MiB", %{
    f: f,
    histories: histories,
    head: head
  } do
    assert {:ok, record} = Workflow.record(f.space_log, histories)

    assert Enum.sort(Map.keys(record)) ==
             ~w(active clearedDrafts intent product profiles publicKey relay revision version)

    assert record["version"] == 2
    assert record["product"] == "treehouse"
    assert record["publicKey"] == Base.encode64(f.review.space_root)
    assert record["active"] == f.space_log.replica
    assert record["intent"] == nil
    assert record["clearedDrafts"] == %{}
    assert record["relay"] == nil
    assert length(record["profiles"]) == map_size(histories)

    for profile <- record["profiles"] do
      assert Enum.sort(Map.keys(profile)) == ~w(acked frames outbox product replica)
      assert profile["outbox"] == []
      assert profile["acked"] == []
      log = Map.fetch!(histories, profile["replica"])
      assert profile["frames"] == PublicHistory.frames(log)

      expected =
        if(profile["replica"] == f.space_log.replica,
          do: "Treehouse.Space",
          else: "Treehouse.Thread"
        )

      assert profile["product"] == expected
    end

    assert byte_size(PublicHistory.canonical(record)) < @history_bytes
    assert :ok = Workflow.fit(f.space_log, histories)
    assert {:ok, _} = Packet.encode(f.space_log, [f.catalog_json], histories, head)
  end

  test "an evaluator-valid page that misses the workflow store refuses preview_storage_limit", %{
    f: f,
    histories: histories,
    head: head
  } do
    thread = hd(f.threads)
    {fitting, overflowing} = adjacent(f.space_log, histories, thread)

    assert size(f.space_log, fitting) == @history_bytes
    assert size(f.space_log, overflowing) > @history_bytes
    assert :ok = Workflow.fit(f.space_log, fitting)
    assert {:error, :preview_storage_limit} = Workflow.fit(f.space_log, overflowing)
    assert {:ok, _} = Packet.encode(f.space_log, [f.catalog_json], fitting, head)
    assert {:ok, _} = Packet.encode(f.space_log, [f.catalog_json], overflowing, head)
  end

  defp adjacent(space, histories, thread) do
    count =
      Enum.find(1..64, fn n ->
        size(space, put(histories, thread, grown(thread, posts(thread, n, 36_000)))) >
          @history_bytes
      end)

    assert is_integer(count)
    last_deps = [thread.creation.id]

    # Post bodies ride the wire as base64, so compact JSON moves in 4-byte
    # steps. Three empty-dep prefix posts drop 45 bytes each and shift the
    # residue so a last-post body can land on exactly 1_048_576.
    {fitting, overflowing} =
      Enum.find_value([3, 7], fn empty ->
        Enum.find_value(max(count - 2, empty + 1)..(count + 2), fn n ->
          prefix = posts(thread, n - 1, 36_000, empty)
          bytes = search(space, histories, thread, prefix, n, last_deps, 0, 36_000)

          fitted =
            put(
              histories,
              thread,
              grown(thread, prefix ++ [post(thread, n, bytes, last_deps)])
            )

          if size(space, fitted) == @history_bytes do
            over =
              put(
                histories,
                thread,
                grown(thread, prefix ++ [post(thread, n, bytes + 1, last_deps)])
              )

            {fitted, over}
          end
        end)
      end)

    assert fitting
    {fitting, overflowing}
  end

  defp search(space, histories, thread, prefix, last, deps, low, high) when low >= high do
    next = put(histories, thread, grown(thread, prefix ++ [post(thread, last, low, deps)]))
    if size(space, next) <= @history_bytes, do: low, else: max(low - 1, 0)
  end

  defp search(space, histories, thread, prefix, last, deps, low, high) do
    middle = div(low + high + 1, 2)
    next = put(histories, thread, grown(thread, prefix ++ [post(thread, last, middle, deps)]))

    if size(space, next) <= @history_bytes,
      do: search(space, histories, thread, prefix, last, deps, middle, high),
      else: search(space, histories, thread, prefix, last, deps, low, middle - 1)
  end

  defp size(space, histories) do
    {:ok, record} = Workflow.record(space, histories)
    byte_size(PublicHistory.canonical(record))
  end

  defp put(histories, thread, log), do: Map.put(histories, thread.replica, log)

  defp grown(thread, posts) do
    ops = Map.merge(thread.log.ops, Map.new(posts, &{&1.id, &1}))
    log = Log.from_ops(thread.replica, ops)
    assert :ok = Log.verify_authenticity(log)

    assert Enum.all?(posts, fn op ->
             byte_size(
               PublicHistory.canonical(%{"type" => "push", "ops" => [Wire.encode_op(op)]})
             ) <=
               64_000
           end)

    log
  end

  defp posts(thread, count, bytes, empty \\ 0)

  defp posts(_thread, count, _bytes, _empty) when count < 1, do: []

  defp posts(thread, count, bytes, empty),
    do:
      Enum.map(1..count, fn index ->
        deps = if index <= empty, do: [], else: [thread.creation.id]
        post(thread, index, bytes, deps)
      end)

  defp post(thread, index, bytes, deps) do
    prefix = String.pad_leading(Integer.to_string(index), 6, "0")
    body = prefix <> String.duplicate("x", bytes)

    Op.new(thread.root, thread.replica, deps, :command, {:post, [body]},
      cap: thread.delegation.id
    )
  end
end
