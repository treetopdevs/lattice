defmodule Lattice.FaultScenario do
  @moduledoc """
  Scripted, seeded fault scenarios that turn Lattice's guarantees into replayable
  evidence (plan 203).

  Each scenario injects one fault into `Lattice.Sim`, names one invariant, and
  returns the final logs keyed by log name (`"<prefix>.<realm>"`, for example
  `"thread.writer"`). `checks/3` derives every check from those logs alone, so an
  outsider can recompute them with `Lattice.FaultScenario.Evidence.verify/2`.

  `spec/1` is the verifier-owned table: realms, the replica module for each log
  prefix, the fault and invariant text, and each check's name and source. The
  verifier never trusts those fields from an evidence file.

  Scenarios are deterministic from the seed, because `Sim` derives every key from
  it and signatures are deterministic, so the same seed yields byte-identical logs.
  """

  alias Lattice.{Authority, Log, Op, Sim}
  alias Treehouse.{Space, Thread}

  @type log_name :: String.t()
  @type logs :: %{log_name() => Log.t()}
  @type source :: :replay | :process
  @type spec :: %{
          scenario: String.t(),
          fault: String.t(),
          invariant: String.t(),
          realms: [String.t()],
          root: String.t(),
          modules: %{String.t() => module()},
          checks: [{String.t(), source()}],
          rerun: boolean()
        }

  @specs %{
    "partition_converge" => %{
      scenario: "partition_converge",
      fault: "partition a from b; each posts three times; heal",
      invariant: "convergence",
      realms: ["a", "b"],
      root: "a",
      modules: %{"thread" => Thread},
      checks: [
        {"frontiers_equal", :replay},
        {"op_ids_equal", :replay},
        {"states_equal", :replay},
        {"matches_oracle", :replay},
        {"nothing_quarantined", :replay}
      ],
      rerun: true
    },
    "revoke_offline" => %{
      scenario: "revoke_offline",
      fault:
        "partition writer; revoke writer's post cap and admin delegation; " <>
          "writer posts twice and transfers admin; heal",
      invariant: "identical_quarantine",
      realms: ["root", "writer", "peer"],
      root: "root",
      modules: %{"space" => Space, "thread" => Thread},
      checks: [
        {"writer_admin_before_revoke", :replay},
        {"pre_revoke_honored", :replay},
        {"post_revoke_posts_quarantined", :replay},
        {"post_revoke_transfer_quarantined", :replay},
        {"states_equal", :replay},
        {"reasons_identical_across_realms", :replay},
        {"admin_holder_identical", :replay},
        {"peer_never_admin", :replay}
      ],
      rerun: true
    }
  }

  @doc "Names of the scenarios this module can run, in report order."
  @spec scenarios() :: [String.t()]
  def scenarios, do: ["partition_converge", "revoke_offline"]

  @doc "The verifier-owned table entry for `name`, or `nil` for an unknown scenario."
  @spec spec(String.t()) :: spec() | nil
  def spec(name), do: Map.get(@specs, name)

  @doc """
  Run scenario `name` with `seed` and return its final logs.

  `opts[:variant]` selects a test-only negative control: `:no_revoke` skips the
  revocation step of `revoke_offline`.
  """
  @spec run(String.t(), String.t(), keyword()) :: {:ok, logs()} | {:error, :unknown_scenario}
  def run(name, seed, opts \\ []) when is_binary(name) and is_binary(seed) do
    case name do
      "partition_converge" -> {:ok, partition_converge(seed)}
      "revoke_offline" -> {:ok, revoke_offline(seed, Keyword.get(opts, :variant))}
      _other -> {:error, :unknown_scenario}
    end
  end

  @doc "The replica id each log prefix of `name` must carry for `seed`."
  @spec expected_replicas(String.t(), String.t()) :: %{String.t() => String.t()}
  def expected_replicas(name, seed) do
    %{realms: realms, root: root, modules: modules} = spec(name)

    Map.new(modules, fn {prefix, module} ->
      sim = Sim.new(module, replica_name(name, prefix), realms, seed: seed)
      {prefix, Authority.bind_replica(replica_name(name, prefix), Sim.identity(sim, root).pub)}
    end)
  end

  @doc """
  Evaluate every check of `name` against `logs` alone, in table order.

  `seed` is needed only to derive realm public keys, exactly as `Sim.new/4` does.
  """
  @spec checks(String.t(), String.t(), logs()) :: [{String.t(), boolean()}]
  def checks(name, seed, logs) do
    results = evaluate(name, seed, logs)
    Enum.map(spec(name).checks, fn {check, _source} -> {check, Map.fetch!(results, check)} end)
  end

  @doc "Split a log name such as `\"thread.writer\"` into `{prefix, realm}`."
  @spec split_log_name(log_name()) :: {String.t(), String.t()} | :error
  def split_log_name(name) do
    case String.split(name, ".", parts: 2) do
      [prefix, realm] when prefix != "" and realm != "" -> {prefix, realm}
      _other -> :error
    end
  end

  # --- Scenarios -------------------------------------------------------------

  defp partition_converge(seed) do
    {thread, _genesis} =
      Thread
      |> Sim.new(replica_name("partition_converge", "thread"), ["a", "b"], seed: seed)
      |> Sim.create_replica("a")

    {thread, cap} = Sim.grant(thread, "a", "b", ops: [:post], live: true)
    thread = thread |> Sim.sync_all() |> Sim.partition("a", "b")

    thread =
      Enum.reduce(1..3, thread, fn n, sim ->
        {sim, _} = Sim.command(sim, "a", :post, ["a#{n}"])
        {sim, _} = Sim.command(sim, "b", :post, ["b#{n}"], cap: cap.id)
        sim
      end)

    thread = thread |> Sim.heal("a", "b") |> Sim.sync_all()
    named_logs("thread", thread)
  end

  defp revoke_offline(seed, variant) do
    realms = spec("revoke_offline").realms

    {space, _} =
      Space
      |> Sim.new(replica_name("revoke_offline", "space"), realms, seed: seed)
      |> Sim.create_replica("root")

    {thread, _} =
      Thread
      |> Sim.new(replica_name("revoke_offline", "thread"), realms, seed: seed)
      |> Sim.create_replica("root")

    # Grants and transfers append only to the issuer's log; sync so the writer's
    # later ops cite delegations its own log has seen. `ops: []` attenuates the
    # Space genesis delegation, which the default `[:lock, :unlock]` does not.
    {thread, post_cap} = Sim.grant(thread, "root", "writer", ops: [:post], live: true)
    {space, admin_cap} = Sim.transfer(space, "root", "writer", :admin, ops: [])
    {thread, space} = {Sim.sync_all(thread), Sim.sync_all(space)}

    # The pre-revoke post must be a causal ancestor of the revoke to stay honored.
    {thread, _pre} = Sim.command(thread, "writer", :post, ["before revoke"], cap: post_cap.id)
    thread = Sim.sync_all(thread)

    {thread, space} = {isolate(thread, "writer"), isolate(space, "writer")}

    {thread, space} =
      if variant == :no_revoke do
        {thread, space}
      else
        {thread, _} = Sim.revoke(thread, "root", post_cap.id)
        {space, _} = Sim.revoke(space, "root", admin_cap.id)
        {thread, space}
      end

    {thread, _} = Sim.command(thread, "writer", :post, ["offline 1"], cap: post_cap.id)
    {thread, _} = Sim.command(thread, "writer", :post, ["offline 2"], cap: post_cap.id)
    {space, _} = Sim.transfer(space, "writer", "peer", :admin, ops: [])

    {thread, space} = {rejoin(thread, "writer"), rejoin(space, "writer")}
    Map.merge(named_logs("space", space), named_logs("thread", thread))
  end

  defp isolate(sim, realm),
    do: sim |> Sim.partition(realm, "root") |> Sim.partition(realm, "peer")

  defp rejoin(sim, realm),
    do: sim |> Sim.heal(realm, "root") |> Sim.heal(realm, "peer") |> Sim.sync_all()

  defp named_logs(prefix, sim),
    do: Map.new(sim.logs, fn {realm, log} -> {"#{prefix}.#{realm}", log} end)

  defp replica_name(name, prefix), do: "fault:#{name}:#{prefix}"

  # --- Checks ----------------------------------------------------------------

  defp evaluate("partition_converge", _seed, logs) do
    all = Map.values(logs)
    module = Thread

    # One log holding every op any realm saw: the state a correct merge must reach.
    # Built with `from_ops/2`, not `append!/2`, so a tampered input is judged, not raised.
    oracle =
      all
      |> Enum.flat_map(&Map.values(Log.ops(&1)))
      |> Map.new(&{&1.id, &1})
      |> then(&Log.from_ops(hd(all).replica, &1))

    oracle_state = Lattice.state(module, oracle)

    %{
      "frontiers_equal" => same?(all, &Enum.sort(Log.frontier(&1))),
      "op_ids_equal" => same?(all, &Log.op_ids/1),
      "states_equal" => same?(all, &Lattice.state(module, &1)),
      "matches_oracle" => Enum.all?(all, &(Lattice.state(module, &1) == oracle_state)),
      "nothing_quarantined" => Enum.all?(all, &(Authority.analyze(module, &1).reasons == %{}))
    }
  end

  defp evaluate("revoke_offline", seed, logs) do
    keys = realm_keys("revoke_offline", seed)
    space = for {"space." <> _, log} <- logs, do: log
    thread = for {"thread." <> _, log} <- logs, do: log

    %{
      "writer_admin_before_revoke" =>
        nonempty_all?(space, &writer_admin_before_revoke?(&1, keys["writer"])),
      "pre_revoke_honored" => nonempty_all?(thread, &pre_revoke_honored?(&1, keys["writer"])),
      "post_revoke_posts_quarantined" =>
        nonempty_all?(thread, &post_revoke_posts_quarantined?(&1, keys["writer"])),
      "post_revoke_transfer_quarantined" =>
        nonempty_all?(space, &writer_transfers_revoked?(&1, keys["writer"])),
      "states_equal" =>
        same?(space, &Lattice.state(Space, &1)) and same?(thread, &Lattice.state(Thread, &1)),
      "reasons_identical_across_realms" =>
        same?(space, &Authority.analyze(Space, &1).reasons) and
          same?(thread, &Authority.analyze(Thread, &1).reasons),
      "admin_holder_identical" => same?(space, &Authority.holder(Space, &1, :admin)),
      "peer_never_admin" =>
        nonempty_all?(space, &(Authority.holder(Space, &1, :admin) != keys["peer"]))
    }
  end

  defp writer_admin_before_revoke?(log, writer) do
    case revoke_op(log) do
      nil ->
        false

      revoke ->
        before =
          Log.from_ops(
            log.replica,
            Map.take(Log.ops(log), MapSet.to_list(ancestors(log, revoke.id)))
          )

        Authority.holder(Space, before, :admin) == writer
    end
  end

  defp pre_revoke_honored?(log, writer) do
    with %Op{} = revoke <- revoke_op(log),
         before = ancestors(log, revoke.id),
         [_ | _] = pre <- Enum.filter(writer_posts(log, writer), &(&1.id in before)) do
      reasons = Authority.analyze(Thread, log).reasons
      Enum.all?(pre, &(not Map.has_key?(reasons, &1.id)))
    else
      _ -> false
    end
  end

  defp post_revoke_posts_quarantined?(log, writer) do
    with %Op{} = revoke <- revoke_op(log),
         before = ancestors(log, revoke.id),
         [_ | _] = post <- Enum.reject(writer_posts(log, writer), &(&1.id in before)) do
      revoked?(Authority.analyze(Thread, log).reasons, post)
    else
      _ -> false
    end
  end

  defp writer_transfers_revoked?(log, writer) do
    transfers =
      for %Op{author: ^writer, body: {:transfer, :admin, _, _}} = op <- Map.values(Log.ops(log)),
          do: op

    transfers != [] and revoked?(Authority.analyze(Space, log).reasons, transfers)
  end

  defp revoked?(reasons, ops),
    do: Enum.all?(ops, &(Map.get(reasons, &1.id) == :revoked_capability))

  defp writer_posts(log, writer) do
    for %Op{kind: :command, author: ^writer, body: {:post, _}} = op <- Map.values(Log.ops(log)),
        do: op
  end

  # The scenario authors exactly one revoke per replica; more than one is not this script.
  defp revoke_op(log) do
    case for(%Op{body: {:revoke, _}} = op <- Map.values(Log.ops(log)), do: op) do
      [op] -> op
      _none_or_many -> nil
    end
  end

  defp ancestors(log, id) do
    ops = Log.ops(log)
    walk(ops[id].deps, MapSet.new(), ops)
  end

  defp walk([], seen, _ops), do: seen

  defp walk([id | rest], seen, ops) do
    if MapSet.member?(seen, id) or not Map.has_key?(ops, id),
      do: walk(rest, seen, ops),
      else: walk(ops[id].deps ++ rest, MapSet.put(seen, id), ops)
  end

  defp realm_keys(name, seed) do
    %{realms: realms} = spec(name)
    sim = Sim.new(Thread, "keys", realms, seed: seed)
    Map.new(realms, &{&1, Sim.identity(sim, &1).pub})
  end

  defp same?([], _fun), do: false
  defp same?(logs, fun), do: logs |> Enum.map(fun) |> Enum.uniq() |> length() == 1

  defp nonempty_all?([], _fun), do: false
  defp nonempty_all?(logs, fun), do: Enum.all?(logs, fun)
end
