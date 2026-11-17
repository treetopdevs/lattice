defmodule Township.DivergenceTest do
  use ExUnit.Case, async: false
  use ExUnitProperties

  alias Lattice.{Log, Op, Sim}
  alias Mix.Tasks.Lattice.Township.ExplainDivergence
  alias Township.{AuditBundle, Divergence, Matter}

  @moduletag timeout: 300_000

  @replica "replica:matter:explain"
  @secret "SECRET-TOWN-HALL-TEXT"

  defp base do
    sim = Sim.new(Matter, @replica, ["clerk", "resident"], seed: "explain")
    {sim, _} = Sim.create_replica(sim, "clerk")
    {sim, _} = Sim.grant(sim, "clerk", "resident", ops: [:post, :set_title])
    Sim.sync_all(sim)
  end

  defp replica, do: Sim.replica(base())

  defp diverged do
    sim = Sim.partition(base(), "clerk", "resident")
    {sim, post} = Sim.command(sim, "resident", :post, [@secret])
    {sim, post}
  end

  defp state_bytes(log) do
    :erlang.term_to_binary(Lattice.state(Matter, log), [:deterministic, {:minor_version, 2}])
  end

  # Clerk transfers the role while a concurrent clerk close_matter, authored from the
  # pre-transfer history, lands afterwards. Returns {full_log, prefix_log, close}.
  defp stale_clerk do
    pre = Sim.partition(base(), "clerk", "resident")

    {post_transfer, _delegation} =
      Sim.transfer(pre, "clerk", "resident", :clerk,
        at_tick: 1,
        ops: [:close_matter, :reopen_matter]
      )

    {_stale_sim, close} = Sim.command(pre, "clerk", :close_matter, [])
    full = Log.append!(Sim.log(post_transfer, "clerk"), close)
    transfer_op = Enum.find(Map.values(full.ops), &match?(%{body: {:transfer, _, _, _}}, &1))
    prefix = Log.from_ops(full.replica, Map.delete(full.ops, transfer_op.id))
    {full, prefix, close}
  end

  test "two synced logs converge with every delta empty" do
    sim = base()
    {sim, _} = Sim.command(sim, "resident", :post, ["hello"])
    sim = Sim.sync_all(sim)
    a = Sim.log(sim, "clerk")
    b = Sim.log(sim, "resident")

    assert %{
             converged?: true,
             state_equal?: true,
             only_in_a: [],
             only_in_b: [],
             state_mismatches: [],
             quarantine_delta: [],
             holder_delta: [],
             structural_delta: []
           } = report = Divergence.explain(a, b)

    assert report.frontier_a == report.frontier_b
  end

  test "a missing op is named and the posts field is attributed" do
    {sim, post} = diverged()
    report = Divergence.explain(Sim.log(sim, "clerk"), Sim.log(sim, "resident"))

    refute report.converged?
    refute report.state_equal?
    assert report.only_in_a == []
    assert report.only_in_b == [post.id]
    assert [%{field: :posts, a: %{entries: 0}, b: %{entries: 1}}] = report.state_mismatches
    assert report.frontier_a != report.frontier_b
  end

  test "an op quarantined by authority on one side only lands in quarantine_delta" do
    {full, prefix, close} = stale_clerk()
    report = Divergence.explain(full, prefix)

    assert [transfer_op] = report.only_in_a
    refute transfer_op == close.id
    assert [%{op_id: id, reason_a: :stale_holder, reason_b: nil}] = report.quarantine_delta
    assert id == close.id
    assert report.structural_delta == []
  end

  test "a role transfer shows as a holder delta with differing fingerprints" do
    pre = base()

    {post_transfer, _delegation} =
      Sim.transfer(pre, "clerk", "resident", :clerk,
        at_tick: 1,
        ops: [:close_matter, :reopen_matter]
      )

    report = Divergence.explain(Sim.log(pre, "clerk"), Sim.log(post_transfer, "clerk"))

    assert [transfer_op] = report.only_in_b

    assert {:ok, %{body: {:transfer, :clerk, _, _}}} =
             Log.fetch(Sim.log(post_transfer, "clerk"), transfer_op)

    assert [%{role: :clerk, a: fp_a, b: fp_b}] = report.holder_delta
    assert is_binary(fp_a) and is_binary(fp_b) and fp_a != fp_b
  end

  test "structural quarantine is reported in its own list, never as an authority reason" do
    sim = base()
    {sim, post} = Sim.command(sim, "clerk", :post, ["accepted"])
    good = Sim.log(sim, "clerk")
    rejected = %{post | body: {:post, ["tampered"]}, sig: <<0::512>>}
    rejected = %{rejected | id: Op.recompute_id(rejected)}
    {:quarantined, bad, :bad_signature} = Log.accept(good, rejected)

    report = Divergence.explain(bad, good)

    assert [%{op_id: id, reason_a: :bad_signature, reason_b: nil}] = report.structural_delta
    assert id == rejected.id
    assert report.quarantine_delta == []
    refute report.converged?
    assert report.state_equal?
  end

  test "logs of different replicas return the error map" do
    other = Sim.new(Matter, "replica:matter:other", ["clerk"], seed: "other")
    {other, _} = Sim.create_replica(other, "clerk")

    assert %{error: :different_replicas, a: a, b: b} =
             Divergence.explain(Sim.log(base(), "clerk"), Sim.log(other, "clerk"))

    assert a == replica()
    assert b == Sim.replica(other)
  end

  test "output is deterministic and explain(b, a) is the exact mirror" do
    {full, prefix, _close} = stale_clerk()
    {sim, _post} = diverged()
    mixed_a = Sim.log(sim, "clerk")
    mixed_b = Sim.log(sim, "resident")

    for {a, b} <- [{full, prefix}, {mixed_a, mixed_b}] do
      forward = Divergence.explain(a, b)
      assert forward == Divergence.explain(a, b)
      assert mirror(forward) == Divergence.explain(b, a)
    end
  end

  defp mirror(report) do
    %{
      report
      | only_in_a: report.only_in_b,
        only_in_b: report.only_in_a,
        frontier_a: report.frontier_b,
        frontier_b: report.frontier_a,
        state_mismatches: Enum.map(report.state_mismatches, &%{&1 | a: &1.b, b: &1.a}),
        quarantine_delta:
          Enum.map(report.quarantine_delta, &%{&1 | reason_a: &1.reason_b, reason_b: &1.reason_a}),
        holder_delta: Enum.map(report.holder_delta, &%{&1 | a: &1.b, b: &1.a}),
        structural_delta:
          Enum.map(report.structural_delta, &%{&1 | reason_a: &1.reason_b, reason_b: &1.reason_a})
    }
  end

  test "participant content never appears in the explanation" do
    {sim, _post} = diverged()
    report = Divergence.explain(Sim.log(sim, "clerk"), Sim.log(sim, "resident"))

    refute inspect(report, limit: :infinity, printable_limit: :infinity) =~ @secret
    refute :erlang.term_to_binary(report) =~ @secret
    assert [%{field: :posts, b: %{entries: 1, sha256: sha}}] = report.state_mismatches
    assert byte_size(sha) == 8
  end

  describe "completeness property" do
    @realms ["r0", "r1", "r2"]

    defp action_gen do
      one_of([
        tuple({constant(:post), idx(), string(:alphanumeric, min_length: 1, max_length: 5)}),
        tuple({constant(:title), idx(), string(:alphanumeric, min_length: 1, max_length: 5)}),
        tuple({constant(:join), idx()}),
        tuple({constant(:lock), idx()}),
        tuple({constant(:transfer), idx()}),
        tuple({constant(:partition), idx(), idx()}),
        tuple({constant(:heal), idx(), idx()}),
        tuple({constant(:sync), idx(), idx()})
      ])
    end

    defp idx, do: StreamData.member_of([0, 1, 2])
    defp realm(i), do: Enum.at(@realms, i)

    defp run(actions, seed) do
      sim = Sim.new(Matter, "replica:matter:explain-prop", @realms, seed: seed)

      {sim, _} =
        Sim.create_replica(sim, "r0", policies: %{clerk: %{successor: "r1", dormant_ticks: 2}})

      {sim, _} = Sim.grant(sim, "r0", "r1", ops: [:post, :set_title, :admit])
      {sim, _} = Sim.grant(sim, "r0", "r2", ops: [:post, :set_title, :admit])
      sim = Sim.sync_all(sim)
      {sim, _tick} = Enum.reduce(actions, {sim, 1}, &apply_action/2)
      sim
    end

    defp apply_action({:post, i, text}, {sim, t}),
      do: {elem(Sim.command(sim, realm(i), :post, [text]), 0), t}

    defp apply_action({:title, i, text}, {sim, t}),
      do: {elem(Sim.command(sim, realm(i), :set_title, [text]), 0), t}

    defp apply_action({:join, i}, {sim, t}),
      do: {elem(Sim.command(sim, realm(i), :admit, [realm(i)]), 0), t}

    defp apply_action({:lock, i}, {sim, t}),
      do: {elem(Sim.command(sim, realm(i), :close_matter, []), 0), t}

    defp apply_action({:transfer, to_i}, {sim, t}) do
      case Enum.find(@realms, fn r -> Sim.holder(sim, r, :clerk) == Sim.identity(sim, r).pub end) do
        nil ->
          {sim, t}

        from ->
          {elem(
             Sim.transfer(sim, from, realm(to_i), :clerk,
               at_tick: t,
               ops: [:close_matter, :reopen_matter]
             ),
             0
           ), t + 1}
      end
    end

    defp apply_action({:partition, i, j}, {sim, t}),
      do: {if(i == j, do: sim, else: Sim.partition(sim, realm(i), realm(j))), t}

    defp apply_action({:heal, i, j}, {sim, t}), do: {Sim.heal(sim, realm(i), realm(j)), t}

    defp apply_action({:sync, i, j}, {sim, t}),
      do: {if(i == j, do: sim, else: Sim.sync(sim, realm(i), realm(j))), t}

    property "a byte difference is always attributed and a byte match never is" do
      check all(
              actions <- list_of(action_gen(), max_length: 12),
              seed <- string(:alphanumeric, min_length: 1, max_length: 6),
              max_runs: 25
            ) do
        sim = run(actions, seed)

        for {x, y} <- [{"r0", "r1"}, {"r0", "r2"}, {"r1", "r2"}] do
          a = Sim.log(sim, x)
          b = Sim.log(sim, y)
          report = Divergence.explain(a, b)
          bytes_equal? = state_bytes(a) == state_bytes(b)

          assert report.state_equal? == bytes_equal?

          if bytes_equal? do
            assert report.state_mismatches == []
          else
            refute report.converged?
            assert report.state_mismatches != []
          end

          if report.converged?, do: assert(bytes_equal?)
        end
      end
    end
  end

  describe "mix lattice.township.explain_divergence" do
    setup do
      previous = Mix.shell()
      Mix.shell(Mix.Shell.Process)
      on_exit(fn -> Mix.shell(previous) end)
      :ok
    end

    defp output do
      receive do
        {:mix_shell, :info, [line]} -> [line | output()]
      after
        0 -> []
      end
    end

    defp write_pair(tmp_dir) do
      {sim, post} = diverged()
      dir_a = Path.join(tmp_dir, "a")
      dir_b = Path.join(tmp_dir, "b")
      {:ok, _} = AuditBundle.write(dir_a, Sim.log(sim, "clerk"))
      {:ok, _} = AuditBundle.write(dir_b, Sim.log(sim, "resident"))
      {dir_a, dir_b, post}
    end

    @tag :tmp_dir
    test "names the op, the field and the verdict, without participant content", %{tmp_dir: tmp} do
      {dir_a, dir_b, post} = write_pair(tmp)
      ExplainDivergence.run(["--a", dir_a, "--b", dir_b])
      lines = output()
      text = Enum.join(lines, "\n")

      assert hd(lines) ==
               "DIVERGED: replica #{replica()}, 1 op only in B, state differs in 1 field"

      assert text =~ "only in B: #{post.id}"

      assert text =~
               ~r/state mismatch :posts  a: 0 entries \(sha [0-9a-f]{8}\)  b: 1 entry \(sha [0-9a-f]{8}\)/

      assert text =~ "frontier A:"
      refute text =~ @secret
    end

    @tag :tmp_dir
    test "identical bundles print only the CONVERGED line", %{tmp_dir: tmp} do
      {dir_a, _dir_b, _post} = write_pair(tmp)
      ExplainDivergence.run(["--a", dir_a, "--b", dir_a])
      assert output() == ["CONVERGED: replica #{replica()}"]
    end

    @tag :tmp_dir
    test "--format json emits the same map with string atoms", %{tmp_dir: tmp} do
      {dir_a, dir_b, post} = write_pair(tmp)
      ExplainDivergence.run(["--a", dir_a, "--b", dir_b, "--format", "json"])
      json = output() |> Enum.join("\n")
      assert {:ok, decoded} = Jason.decode(json)
      assert decoded["converged?"] == false
      assert decoded["only_in_b"] == [post.id]
      assert [%{"field" => "posts"}] = decoded["state_mismatches"]
      refute json =~ @secret
    end

    test "missing arguments raise the usage text" do
      assert_raise Mix.Error, ~r/usage: mix lattice.township.explain_divergence/, fn ->
        ExplainDivergence.run([])
      end

      assert_raise Mix.Error, ~r/usage:/, fn ->
        ExplainDivergence.run(["--a", "x", "--b", "y", "--format", "xml"])
      end
    end

    @tag :tmp_dir
    test "a tampered bundle is refused with its verification errors", %{tmp_dir: tmp} do
      {dir_a, dir_b, _post} = write_pair(tmp)
      File.write!(Path.join(dir_b, "state.json"), "{}")

      assert_raise Mix.Error, ~r/verification failed for .*state\.json mismatch/s, fn ->
        ExplainDivergence.run(["--a", dir_a, "--b", dir_b])
      end
    end
  end
end
