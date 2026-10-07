defmodule Treehouse.EnrollmentVectorsTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Carrier.Wire
  alias Treehouse.{EnrollmentVectors, ReadModel, Space, Thread}

  @modules %{"Treehouse.Space" => Space, "Treehouse.Thread" => Thread}

  setup_all do
    vectors = EnrollmentVectors.build()
    {:ok, vectors: vectors, by_name: Map.new(vectors, &{&1.name, &1})}
  end

  defp log_of(vector, label), do: Enum.find(vector.logs, &(&1.label == label))

  defp reasons(vector, label), do: log_of(vector, label).reasons

  defp step(vector, label), do: Enum.find(vector.steps, &(&1[:label] == label))

  defp rebuild(entry) do
    ops =
      Enum.map(entry.frames, fn frame ->
        assert {:ok, op} = Wire.decode_op(frame)
        assert Op.valid?(op)
        op
      end)

    Enum.reduce(ops, Log.new(entry.replica), fn op, log ->
      assert {:ok, log} = Log.accept(log, op)
      log
    end)
  end

  test "the corpus covers the positive flow and every named negative", %{by_name: by_name} do
    assert Enum.sort(Map.keys(by_name)) ==
             Enum.sort([
               "archived_thread_scope",
               "four_thread_cap",
               "grantless_post",
               "join_flow",
               "replayed_admit",
               "revoked_invitation",
               "scope_mismatch_after_new_thread",
               "wrong_parent_grant",
               "wrong_recipient_acceptance"
             ])
  end

  test "two builds and two writes are byte-identical", %{vectors: vectors} do
    assert Jason.encode!(vectors) == Jason.encode!(EnrollmentVectors.build())

    dir = Path.join(System.tmp_dir!(), "enrollment-vectors-#{System.unique_integer([:positive])}")

    try do
      assert :ok = EnrollmentVectors.write(Path.join(dir, "a"))
      assert :ok = EnrollmentVectors.write(Path.join(dir, "b"))
      first = File.read!(Path.join([dir, "a", "treehouse_enrollment", "enrollment.json"]))
      second = File.read!(Path.join([dir, "b", "treehouse_enrollment", "enrollment.json"]))
      assert first == second
      assert Jason.decode!(first) == vectors |> Jason.encode!() |> Jason.decode!()
    after
      File.rm_rf!(dir)
    end
  end

  test "the committed corpus is exactly what the exporter produces" do
    committed =
      Path.expand(
        "../../../../clients/lattice-client/test/vectors/treehouse_enrollment/enrollment.json",
        __DIR__
      )

    assert File.read!(committed) == EnrollmentVectors.encode(),
           "regenerate with: MIX_ENV=test mix run -e 'Treehouse.EnrollmentVectors.write(\"clients/lattice-client/test/vectors\")'"
  end

  test "every vector log is rebuilt from its frames to the exported ids, verdicts and state", %{
    vectors: vectors
  } do
    for vector <- vectors, entry <- vector.logs do
      module = Map.fetch!(@modules, entry.product)
      log = rebuild(entry)
      assert Enum.map(Log.topo_ops(log), & &1.id) == entry.order
      analysis = Authority.analyze(module, log)

      assert EnrollmentVectors.json(analysis.reasons) == entry.reasons,
             "#{vector.name}/#{entry.label} verdicts drifted"

      assert EnrollmentVectors.json(ReadModel.observe(module, log)) == entry.observed,
             "#{vector.name}/#{entry.label} state drifted"

      assert entry.honored == Enum.reject(entry.order, &Map.has_key?(entry.reasons, &1))
    end
  end

  test "authoring steps are reproducible from public seeds and carry their own frontier", %{
    vectors: vectors
  } do
    for vector <- vectors do
      frames = Map.new(vector.logs, &{&1.label, Map.new(&1.frames, fn f -> {f["id"], f} end)})

      for %{id: id} = step <- vector.steps do
        frame = frames[step.log][id]
        assert frame, "#{vector.name}/#{step[:label]} is absent from its log"
        assert frame["deps"] == step.deps
        assert frame["replica"] == log_of(vector, step.log).replica
        assert frame["author"] == vector.pubkeys[step.realm]
        identity = Identity.from_seed(step.realm, vector.seeds[step.realm])
        assert Base.encode64(identity.pub) == vector.pubkeys[step.realm]
        assert {:ok, op} = Wire.decode_op(frame)
        assert op.author == identity.pub
        assert Op.valid?(op)
        assert Op.new(identity, op.replica, op.deps, op.kind, op.body, cap: op.cap) == op
      end
    end
  end

  test "the positive flow admits, grants and honors a delegated member post", %{
    by_name: by_name
  } do
    vector = by_name["join_flow"]
    assert reasons(vector, "space") == %{}
    assert reasons(vector, "thread:general") == %{}

    space = log_of(vector, "space")
    thread = log_of(vector, "thread:general")
    joiner = vector.pubkeys["joiner"]
    assert space.observed["state"]["members"] == [joiner]
    assert space.observed["initialization"] == "ready"
    assert space.observed["state"]["name"] == "Canopy"

    assert [%{"id" => post_id, "author" => ^joiner, "text" => "from the joiner, edited"}] =
             thread.observed["posts"]

    assert step(vector, "joiner post").id == post_id
    assert post_id in thread.honored

    grant = step(vector, "grant general")
    assert grant.input["audience"] == "joiner"
    assert grant.input["ops"] == ["author_edit", "author_tombstone", "post"]
    assert grant.input["parentId"] == step(vector, "thread genesis").input["delegationId"]
    assert step(vector, "joiner post").cap == grant.input["delegationId"]
    assert step(vector, "joiner post").deps == [grant.id]
    assert step(vector, "admit").input["args"] |> Enum.at(1) == joiner
  end

  test "a grantless or under-granted member post quarantines with the exact reason", %{
    by_name: by_name
  } do
    vector = by_name["grantless_post"]
    thread = reasons(vector, "thread:general")
    assert thread[step(vector, "post without capability").id] == "no_capability"
    assert thread[step(vector, "post under unknown capability").id] == "no_capability"

    assert thread[step(vector, "post under capability lacking post").id] ==
             "operation_not_granted"

    assert thread[step(vector, "archive under capability lacking moderator").id] ==
             "role_not_granted"

    assert log_of(vector, "thread:general").observed["posts"] == []
  end

  test "a grant with the wrong parent is quarantined and its post follows", %{by_name: by_name} do
    vector = by_name["wrong_parent_grant"]
    thread = reasons(vector, "thread:general")
    grant = step(vector, "grant with unrooted parent")
    post = step(vector, "post under unrooted grant")
    assert thread[grant.id] == "nongenesis_root"
    assert thread[post.id] == "invalid_capability"
    assert log_of(vector, "thread:general").observed["posts"] == []
  end

  test "wrong recipient, wrong replica, rebinding, revoked and stale scope admissions quarantine",
       %{
         by_name: by_name
       } do
    invalid = "application_invalid_invitation"

    wrong = by_name["wrong_recipient_acceptance"]
    assert reasons(wrong, "space")[step(wrong, "admit with other's acceptance").id] == invalid

    assert reasons(wrong, "space")[step(wrong, "admit with wrong replica acceptance").id] ==
             invalid

    assert reasons(wrong, "space")[step(wrong, "admit naming other").id] == invalid
    assert log_of(wrong, "space").observed["state"]["members"] == []

    revoked = by_name["revoked_invitation"]
    assert reasons(revoked, "space")[step(revoked, "admit after revoke").id] == invalid
    assert log_of(revoked, "space").observed["state"]["members"] == []

    stale = by_name["scope_mismatch_after_new_thread"]
    assert reasons(stale, "space")[step(stale, "admit with stale scope").id] == invalid
    assert reasons(stale, "space")[step(stale, "issue with stale scope").id] == invalid
    refute Map.has_key?(reasons(stale, "space"), step(stale, "admit with fresh scope").id)
    assert log_of(stale, "space").observed["state"]["members"] == [stale.pubkeys["joiner"]]
  end

  test "a replayed admit is idempotent in state", %{by_name: by_name} do
    vector = by_name["replayed_admit"]
    assert reasons(vector, "space") == %{}
    first = step(vector, "admit")
    second = step(vector, "admit again")
    assert first.id != second.id
    assert log_of(vector, "space").observed["state"]["members"] == [vector.pubkeys["joiner"]]
  end

  test "an archived Thread stays in the invitation scope and keeps its grant", %{
    by_name: by_name
  } do
    vector = by_name["archived_thread_scope"]
    space = log_of(vector, "space")
    live = log_of(vector, "thread:live")
    archived = log_of(vector, "thread:archived")
    assert vector.expect["archivedReplicas"] == [archived.replica]
    assert vector.expect["scope"] == Enum.sort([live.replica, archived.replica])

    assert step(vector, "invite").input["args"] |> Enum.at(1) == vector.expect["scope"]
    refute Map.has_key?(space.reasons, step(vector, "invite").id)
    refute Map.has_key?(space.reasons, step(vector, "admit").id)

    assert space.reasons[step(vector, "invite without archived").id] ==
             "application_invalid_invitation"

    assert step(vector, "grant archived").input["audience"] == "joiner"
    assert archived.reasons[step(vector, "post to archived").id] == "application_archived_thread"
    refute Map.has_key?(live.reasons, step(vector, "post to live").id)
    assert archived.observed["state"]["archived"] == true
    assert archived.observed["posts"] == []
    assert [%{"text" => "live post"}] = live.observed["posts"]
  end

  test "four honored Threads exceed the lite route cap while the domain still honors the scope",
       %{
         by_name: by_name
       } do
    vector = by_name["four_thread_cap"]
    space = log_of(vector, "space")
    assert length(vector.expect["scope"]) == 4
    assert vector.expect["honoredThreads"] == 4
    assert vector.expect["liteRouteCap"] == 3
    assert vector.expect["liteRefusal"] == "thread_scope_exceeds_routes"
    refute Map.has_key?(space.reasons, step(vector, "invite all four").id)

    assert space.reasons[step(vector, "invite three").id] == "application_invalid_invitation"
    assert length(space.observed["state"]["threads"]) == 4
  end
end
