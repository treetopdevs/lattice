defmodule Lattice.FaultScenarioTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, FaultScenario, Log}
  alias Lattice.FaultScenario.{Evidence, Report}

  @moduletag :tmp_dir

  defp write!(dir, name, seed \\ "demo", opts \\ []) do
    {:ok, logs} = FaultScenario.run(name, seed, opts)
    path = Path.join(dir, name)
    {:ok, verdict} = Evidence.write(path, name, seed, logs)
    {path, logs, verdict}
  end

  defp checks(name, logs, seed \\ "demo"), do: Map.new(FaultScenario.checks(name, seed, logs))

  defp files(dir) do
    dir
    |> Path.join("**/*")
    |> Path.wildcard()
    |> Enum.filter(&File.regular?/1)
    |> Map.new(&{Path.relative_to(&1, dir), File.read!(&1)})
  end

  defp update_evidence!(dir, fun) do
    path = Path.join(dir, "evidence.json")
    evidence = path |> File.read!() |> Jason.decode!() |> fun.()
    File.write!(path, Jason.encode!(evidence, pretty: true) <> "\n")
  end

  defp rebuild_without(log, op_id),
    do: Log.from_ops(log.replica, Map.delete(Log.ops(log), op_id))

  describe "evidence format and checker" do
    test "a written directory round-trips through verify", %{tmp_dir: tmp} do
      {dir, _logs, "held"} = write!(tmp, "partition_converge")

      assert {:ok, %{scenario: "partition_converge", verdict: "held", checks: checks}} =
               Evidence.verify(dir)

      assert Enum.all?(checks, &(&1.ok and &1.source == :replay))

      assert Map.keys(files(dir)) |> Enum.sort() ==
               ~w(evidence.json logs/thread.a.log logs/thread.b.log trust_graph.thread.dot)
    end

    test "a flipped byte in a log is refused", %{tmp_dir: tmp} do
      {dir, _logs, _} = write!(tmp, "partition_converge")
      path = Path.join([dir, "logs", "thread.b.log"])
      bytes = File.read!(path)
      at = div(byte_size(bytes), 2)
      <<head::binary-size(at), byte, rest::binary>> = bytes
      File.write!(path, head <> <<Bitwise.bxor(byte, 0xFF)>> <> rest)

      assert {:error, [_ | _]} = Evidence.verify(dir)
    end

    test "a forged op re-encoded with matching evidence is refused by restore_verified",
         %{tmp_dir: tmp} do
      {:ok, logs} = FaultScenario.run("partition_converge", "demo")
      log = logs["thread.b"]
      [target | _] = Log.frontier(log)
      forged_op = %{Log.ops(log)[target] | body: {:post, ["forged"]}}
      forged = %{log | ops: Map.put(log.ops, target, forged_op)}
      dir = Path.join(tmp, "forged")

      # The evidence is recomputed from the forged logs, so only authenticity can catch it.
      {:ok, _} =
        Evidence.write(dir, "partition_converge", "demo", Map.put(logs, "thread.b", forged))

      assert {:error, [reason]} = Evidence.verify(dir)
      assert reason =~ "thread.b.log failed verification"
    end

    test "dropping the same leaf from every log is caught only by the seeded re-run",
         %{tmp_dir: tmp} do
      {:ok, logs} = FaultScenario.run("partition_converge", "demo")
      [leaf | _] = Log.frontier(logs["thread.a"])
      trimmed = Map.new(logs, fn {name, log} -> {name, rebuild_without(log, leaf)} end)
      dir = Path.join(tmp, "trimmed")
      {:ok, "held"} = Evidence.write(dir, "partition_converge", "demo", trimmed)

      assert {:error, [reason]} = Evidence.verify(dir)
      assert reason =~ "seeded re-run of partition_converge"
    end

    test "the verifier table pins fault, invariant, modules and check sources",
         %{tmp_dir: tmp} do
      tampers = [
        &Map.put(&1, "fault", "a different fault"),
        &Map.put(&1, "invariant", "something else"),
        &put_in(&1, ["module", "thread"], "Treehouse.Space"),
        fn ev ->
          update_in(ev["checks"], fn [c | rest] -> [%{c | "source" => "process"} | rest] end)
        end,
        fn ev ->
          update_in(ev["checks"], fn [c | rest] -> [%{c | "name" => "invented"} | rest] end)
        end,
        fn ev -> update_in(ev["checks"], &tl/1) end
      ]

      for {tamper, n} <- Enum.with_index(tampers) do
        {dir, _logs, _} = write!(Path.join(tmp, "t#{n}"), "partition_converge")
        update_evidence!(dir, tamper)
        assert {:error, [_ | _]} = Evidence.verify(dir), "tamper #{n} was accepted"
      end
    end

    test "missing, extra or altered DOT files are mismatches", %{tmp_dir: tmp} do
      {dir, _logs, _} = write!(Path.join(tmp, "missing"), "partition_converge")
      File.rm!(Path.join(dir, "trust_graph.thread.dot"))
      assert {:error, _} = Evidence.verify(dir)

      {dir, _logs, _} = write!(Path.join(tmp, "extra"), "partition_converge")
      File.write!(Path.join(dir, "trust_graph.other.dot"), "digraph {}\n")
      assert {:error, _} = Evidence.verify(dir)

      {dir, _logs, _} = write!(Path.join(tmp, "altered"), "partition_converge")
      File.write!(Path.join(dir, "trust_graph.thread.dot"), "digraph lattice {}\n")
      assert {:error, _} = Evidence.verify(dir)
    end

    test "an authentic log for another replica is refused before replay", %{tmp_dir: tmp} do
      {dir, _logs, _} = write!(Path.join(tmp, "a"), "revoke_offline")
      {other, _logs, _} = write!(Path.join(tmp, "b"), "revoke_offline", "other-seed")

      File.cp!(
        Path.join([other, "logs", "thread.peer.log"]),
        Path.join([dir, "logs", "thread.peer.log"])
      )

      assert {:error, [reason]} = Evidence.verify(dir)
      assert reason =~ "unexpected replica"
    end
  end

  describe "partition_converge" do
    test "holds, and the same seed writes byte-identical evidence", %{tmp_dir: tmp} do
      {first, logs, "held"} = write!(Path.join(tmp, "1"), "partition_converge")
      {second, _logs, "held"} = write!(Path.join(tmp, "2"), "partition_converge")

      assert Enum.all?(checks("partition_converge", logs), fn {_, ok} -> ok end)
      assert files(first) == files(second)
    end

    test "negative control: a log missing one frontier leaf fails frontiers_equal",
         %{tmp_dir: tmp} do
      {dir, logs, _} = write!(tmp, "partition_converge")
      b = logs["thread.b"]
      [leaf | _] = Log.frontier(b)
      rebuilt = rebuild_without(b, leaf)
      path = Path.join([dir, "logs", "thread.b.log"])
      :ok = Log.dump(rebuilt, path)

      assert {:ok, _} = Log.restore_verified(path)
      refute checks("partition_converge", Map.put(logs, "thread.b", rebuilt))["frontiers_equal"]
      assert {:error, [_ | _]} = Evidence.verify(dir)
    end
  end

  describe "revoke_offline" do
    test "holds: the revoked writer's offline post and transfer quarantine identically",
         %{tmp_dir: tmp} do
      {first, logs, "held"} = write!(Path.join(tmp, "1"), "revoke_offline")
      {second, _logs, "held"} = write!(Path.join(tmp, "2"), "revoke_offline")

      assert Enum.all?(checks("revoke_offline", logs), fn {_, ok} -> ok end)
      assert files(first) == files(second)
      assert {:ok, %{verdict: "held"}} = Evidence.verify(first)

      reasons =
        for {name, log} <- logs,
            module = FaultScenario.spec("revoke_offline").modules[hd(String.split(name, "."))],
            reason <- Map.values(Authority.analyze(module, log).reasons),
            do: reason

      # Two offline posts in each of three thread logs, one transfer in each of three space logs.
      assert Enum.frequencies(reasons) == %{revoked_capability: 9}
    end

    test "negative control: without the revoke nothing quarantines and the verdict is violated",
         %{tmp_dir: tmp} do
      {:ok, logs} = FaultScenario.run("revoke_offline", "demo", variant: :no_revoke)
      result = checks("revoke_offline", logs)

      refute result["post_revoke_posts_quarantined"]
      refute result["post_revoke_transfer_quarantined"]

      for {name, log} <- logs do
        module = FaultScenario.spec("revoke_offline").modules[hd(String.split(name, "."))]
        assert Authority.analyze(module, log).reasons == %{}, "#{name} quarantined something"
      end

      assert {:ok, "violated"} =
               Evidence.write(Path.join(tmp, "control"), "revoke_offline", "demo", logs)
    end
  end

  describe "report" do
    test "verified cards render, and a corrupted log turns its card unverified", %{tmp_dir: tmp} do
      for name <- FaultScenario.scenarios(), do: write!(tmp, name)
      {:ok, path, entries} = Report.write(tmp)
      html = File.read!(path)

      assert Enum.all?(entries, &match?({:ok, _}, &1.result))
      assert html =~ ~s(<span class="status good">verified</span>)
      refute html =~ "unverified</span>"

      File.write!(Path.join([tmp, "revoke_offline", "logs", "thread.peer.log"]), "garbage")
      {:ok, path, _entries} = Report.write(tmp)
      assert File.read!(path) =~ ~s(<span class="status bad">unverified</span>)
    end

    test "process-sourced checks render as recorded and every evidence value is escaped",
         %{tmp_dir: tmp} do
      {:ok, base} = FaultScenario.run("partition_converge", "demo")
      hostile = "<script>alert('x')\"<img>"

      spec = %{
        scenario: "synthetic",
        fault: "fault <img src=x onerror=alert(1)>",
        invariant: "inv'\"",
        realms: ["a", hostile],
        root: "a",
        modules: %{"thread" => Treehouse.Thread},
        checks: [{"replayed_check", :replay}, {hostile, :process}],
        rerun: false
      }

      logs = %{"thread.a" => base["thread.a"], "thread.#{hostile}" => base["thread.b"]}
      dir = Path.join(tmp, "synthetic")

      {:ok, "held"} =
        Evidence.write(dir, "synthetic", "s", logs,
          spec: spec,
          checks: [{"replayed_check", true}, {hostile, true}]
        )

      entry = Report.entry(dir, spec_fun: fn "synthetic" -> spec end)
      assert {:ok, %{checks: checks}} = entry.result
      assert Enum.map(checks, & &1.source) == [:replay, :process]

      html = Report.render([entry])
      assert html =~ "replay verified, process checks recorded"
      assert html =~ ~s(<span class="badge recorded">recorded</span>)
      refute html =~ "<script>"
      refute html =~ "<img"
      assert html =~ "&lt;script&gt;alert(&#39;x&#39;)&quot;&lt;img&gt;"
    end
  end
end
