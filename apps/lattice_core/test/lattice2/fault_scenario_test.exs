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
        fn ev -> update_in(ev["checks"], &tl/1) end,
        fn ev -> update_in(ev["checks"], &(&1 ++ [1])) end,
        fn ev -> update_in(ev["checks"], fn [c | rest] -> [Map.delete(c, "ok") | rest] end) end
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

  describe "handoff_lapse" do
    test "holds: the agent keeps its attributed result and loses permission at the beacon",
         %{tmp_dir: tmp} do
      {first, logs, "held"} = write!(Path.join(tmp, "1"), "handoff_lapse")
      {second, _logs, "held"} = write!(Path.join(tmp, "2"), "handoff_lapse")

      assert Enum.all?(checks("handoff_lapse", logs), fn {_, ok} -> ok end)
      assert files(first) == files(second)
      assert {:ok, %{verdict: "held", checks: verified}} = Evidence.verify(first)
      assert Enum.all?(verified, &(&1.ok and &1.source == :replay))

      assert Map.keys(logs) |> Enum.sort() == ~w(thread.agent thread.peer thread.root)

      reasons =
        for {_name, log} <- logs,
            reason <- Map.values(Authority.analyze(Treehouse.Thread, log).reasons),
            do: reason

      # One lapsed agent post and one misused citation in each of three logs.
      assert Enum.frequencies(reasons) == %{lease_expired: 3, capability_wrong_audience: 3}
    end

    test "negative control: without the beacon only the lapse check is violated",
         %{tmp_dir: tmp} do
      {:ok, logs} = FaultScenario.run("handoff_lapse", "demo", variant: :no_beacon)
      result = checks("handoff_lapse", logs)

      assert result |> Enum.reject(fn {_, ok} -> ok end) |> Enum.map(&elem(&1, 0)) ==
               ["post_lapse_quarantined_lease_expired"]

      assert {:ok, "violated"} =
               Evidence.write(Path.join(tmp, "control"), "handoff_lapse", "demo", logs)

      # The seeded re-run produces the beacon, so control evidence never verifies.
      assert {:error, [_ | _]} = Evidence.verify(Path.join(tmp, "control"))
    end

    test "a log that drops the agent's pre-lapse post fails attribution and honor",
         %{tmp_dir: tmp} do
      {dir, logs, "held"} = write!(tmp, "handoff_lapse")
      %{pre: pre} = FaultScenario.handoff_texts()
      root = logs["thread.root"]

      [pre_op] =
        for %{kind: :command, body: {:post, [^pre]}} = op <- Map.values(Log.ops(root)), do: op

      # Drop the post and everything that depends on it, so the log stays well-formed.
      kept =
        root
        |> Log.ops()
        |> Map.reject(fn {id, _op} ->
          id == pre_op.id or MapSet.member?(Lattice.Dag.ancestors(Log.ops(root), id), pre_op.id)
        end)

      rebuilt = Log.from_ops(root.replica, kept)
      result = checks("handoff_lapse", Map.put(logs, "thread.root", rebuilt))

      refute result["pre_lapse_honored"]
      refute result["pre_lapse_authored_by_agent"]

      :ok = Log.dump(rebuilt, Path.join([dir, "logs", "thread.root.log"]))
      assert {:error, [_ | _]} = Evidence.verify(dir)
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
        rerun: false,
        replicas: fn "s" -> %{"thread" => base["thread.a"].replica} end,
        replay_checks: fn "s", _logs -> [{"replayed_check", true}] end
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

    test "a non-re-runnable entry fails closed and never copies replay checks",
         %{tmp_dir: tmp} do
      {:ok, base} = FaultScenario.run("partition_converge", "demo")
      {:ok, other} = FaultScenario.run("partition_converge", "other-seed")
      logs = %{"thread.a" => base["thread.a"]}

      spec = %{
        scenario: "synthetic",
        fault: "f",
        invariant: "i",
        realms: ["a"],
        root: "a",
        modules: %{"thread" => Treehouse.Thread},
        checks: [{"replayed_check", :replay}, {"process_check", :process}],
        rerun: false,
        replicas: fn _ -> %{"thread" => base["thread.a"].replica} end,
        replay_checks: fn _, _ -> [{"replayed_check", false}] end
      }

      verify = fn dir, spec -> Evidence.verify(dir, spec_fun: fn "synthetic" -> spec end) end

      write = fn dir, logs ->
        Evidence.write(dir, "synthetic", "s", logs,
          spec: spec,
          checks: [{"replayed_check", true}, {"process_check", true}]
        )
      end

      # A replay check recorded as true but re-derived false is a mismatch, not a copy.
      {:ok, _} = write.(Path.join(tmp, "claimed"), logs)
      assert {:error, [reason]} = verify.(Path.join(tmp, "claimed"), spec)
      assert reason =~ "evidence.json differs"

      # Without the table's functions the entry fails closed.
      assert {:error, [reason]} = verify.(Path.join(tmp, "claimed"), Map.delete(spec, :replicas))
      assert reason =~ "names no expected replicas"

      assert {:error, [reason]} =
               verify.(Path.join(tmp, "claimed"), Map.delete(spec, :replay_checks))

      assert reason =~ "cannot re-derive the replay checks"

      # An authentic log for another replica is refused.
      {:ok, _} = write.(Path.join(tmp, "swapped"), %{"thread.a" => other["thread.a"]})
      assert {:error, [reason]} = verify.(Path.join(tmp, "swapped"), spec)
      assert reason =~ "unexpected replica"

      # A malformed check row is a mismatch, not a crash in the recorded-check copy.
      update_evidence!(Path.join(tmp, "claimed"), &update_in(&1["checks"], fn c -> c ++ [1] end))
      assert {:error, [reason]} = verify.(Path.join(tmp, "claimed"), spec)
      assert reason =~ "check names or sources differ"
    end

    test "a malformed quarantine row renders an unverified card", %{tmp_dir: tmp} do
      {dir, _logs, _} = write!(tmp, "revoke_offline")
      update_evidence!(dir, &Map.put(&1, "quarantine", [1 | &1["quarantine"]]))

      [entry] = Report.write(tmp) |> elem(2)
      assert {:error, _} = entry.result
      html = Report.render([entry])
      assert html =~ ~s(<span class="status bad">unverified</span>)
      assert html =~ "malformed: <code>1</code>"
    end
  end

  describe "carrier table entries (plan 204)" do
    # The server log a carrier scenario writes: a seeded Thread replica created by `owner`.
    defp carrier_logs(name, seed) do
      %{sim_realms: realms, root: root} = FaultScenario.spec(name)

      {sim, _} =
        Treehouse.Thread
        |> Lattice.Sim.new(FaultScenario.replica_name(name, "thread"), realms, seed: seed)
        |> Lattice.Sim.create_replica(root)

      %{"thread.server" => Lattice.Sim.log(sim, root)}
    end

    test "both entries bind the seeded replica and copy only recorded checks and timings",
         %{tmp_dir: tmp} do
      for name <- FaultScenario.carrier_scenarios() do
        spec = FaultScenario.spec(name)
        refute spec.rerun
        assert Enum.all?(spec.checks, &match?({_, :process}, &1))
        logs = carrier_logs(name, "s")
        assert logs["thread.server"].replica == spec.replicas.("s")["thread"]

        checks = Enum.map(spec.checks, fn {check, _} -> {check, true} end)
        dir = Path.join(tmp, name)
        opts = [checks: checks, observed_ms: %{"b" => 7, "a" => 0}]
        assert {:ok, "held"} = Evidence.write(dir, name, "s", logs, opts)
        json = File.read!(Path.join(dir, "evidence.json"))
        assert json =~ ~s("observed_ms": {\n    "a": 0,\n    "b": 7\n  },\n  "verdict")
        assert {:ok, %{verdict: "held"}} = Evidence.verify(dir)

        # Timings are recorded, outside byte identity; a malformed timing is not.
        File.write!(
          Path.join(dir, "evidence.json"),
          String.replace(json, ~s("b": 7), ~s("b": 99))
        )

        assert {:ok, _} = Evidence.verify(dir)

        File.write!(
          Path.join(dir, "evidence.json"),
          String.replace(json, ~s("b": 7), ~s("b": -1))
        )

        assert {:error, [reason]} = Evidence.verify(dir)
        assert reason =~ "evidence.json differs"

        # A log from another seed's replica is refused before any replay.
        :ok =
          Log.dump(
            carrier_logs(name, "t")["thread.server"],
            Path.join([dir, "logs", "thread.server.log"])
          )

        assert {:error, [reason]} = Evidence.verify(dir)
        assert reason =~ "unexpected replica"
      end
    end

    test "a re-runnable scenario refuses an added observed_ms", %{tmp_dir: tmp} do
      {dir, _logs, _} = write!(tmp, "partition_converge")
      path = Path.join(dir, "evidence.json")
      json = File.read!(path)

      File.write!(
        path,
        String.replace(json, ~s(  "verdict"), ~s(  "observed_ms": {},\n  "verdict"))
      )

      assert {:error, [reason]} = Evidence.verify(dir)
      assert reason =~ "evidence.json differs"
    end
  end
end
