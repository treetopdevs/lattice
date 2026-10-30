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
  @typedoc """
  A verifier table entry. A `rerun: false` entry must also supply `:replicas`
  (seed -> expected replica id per prefix) and, when it has replay checks,
  `:replay_checks` (seed, logs -> re-derived replay check results).

  `:realms` names the evidence logs. `:sim_realms`, when present, are the realms the
  seed's `Sim` derives keys for (a carrier scenario's logs are the server's, not a
  Sim realm's); `:root` is the realm among them that creates each replica.
  """
  @type spec :: %{
          required(:scenario) => String.t(),
          required(:fault) => String.t(),
          required(:invariant) => String.t(),
          required(:realms) => [String.t()],
          required(:root) => String.t(),
          required(:modules) => %{String.t() => module()},
          required(:checks) => [{String.t(), source()}],
          required(:rerun) => boolean(),
          optional(:sim_realms) => [String.t()],
          optional(:replicas) => (String.t() -> %{String.t() => String.t()}),
          optional(:replay_checks) => (String.t(), logs() -> [{String.t(), boolean()}])
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
    },
    # Plan 287: a leased delegate keeps its attributed pre-lapse result but loses
    # permission once a root beacon passes the lease; nobody else can cite the lease.
    "handoff_lapse" => %{
      scenario: "handoff_lapse",
      fault:
        "root leases post to agent (expires_epoch 3); agent posts; root beacons 4; " <>
          "agent posts again; peer posts citing the agent's delegation",
      invariant: "attributed_result_survives_lost_permission",
      realms: ["root", "agent", "peer"],
      root: "root",
      modules: %{"thread" => Thread},
      checks: [
        {"pre_lapse_honored", :replay},
        {"pre_lapse_authored_by_agent", :replay},
        {"post_lapse_quarantined_lease_expired", :replay},
        {"peer_cannot_cite_agent_delegation", :replay},
        {"beacon_honored", :replay},
        {"states_equal", :replay},
        {"reasons_identical_across_realms", :replay}
      ],
      rerun: true
    },
    # Plan 204: process-level scenarios run by the lattice_carrier_server test suite.
    # Their checks are recorded, never re-derived; the log hashes, quarantine table
    # and DOT are still recomputed from the verified server log.
    "stall_shutdown" => %{
      scenario: "stall_shutdown",
      fault:
        "hold the carrier holder inside the fsync of one accepted relay; " <>
          "drain the release with a short deadline",
      invariant: "fail_closed",
      realms: ["server"],
      sim_realms: ["owner", "writer"],
      root: "owner",
      modules: %{"thread" => Thread},
      checks: [
        {"drain_returned_error", :process},
        {"drain_call_reached_holder", :process},
        {"bytes_unchanged_while_stalled", :process},
        {"admission_closed", :process},
        {"acked_subset_of_persisted", :process}
      ],
      rerun: false
    },
    "crash_relay" => %{
      scenario: "crash_relay",
      fault:
        "relay signed posts to a second-BEAM carrier; halt that BEAM; " <>
          "restart it from the same log path",
      invariant: "durable_ack",
      realms: ["server"],
      sim_realms: ["owner", "writer"],
      root: "owner",
      modules: %{"thread" => Thread},
      checks: [
        {"acked_survive_restart", :process},
        {"duplicates_silent", :process},
        {"frontier_after_equals_sim", :process},
        {"state_after_equals_sim", :process}
      ],
      rerun: false
    }
  }

  @carrier_scenarios ["stall_shutdown", "crash_relay"]

  @handoff_texts %{
    pre: "agent result before lapse",
    post: "agent result after lapse",
    misuse: "peer citing agent cap"
  }

  # The lease the agent receives and the beacon epoch that passes it.
  @handoff_expires_epoch 3
  @handoff_beacon_epoch 4

  @doc "Names of the scenarios this module can run, in report order."
  @spec scenarios() :: [String.t()]
  def scenarios, do: ["partition_converge", "revoke_offline", "handoff_lapse"]

  @doc """
  The `handoff_lapse` post texts. `evaluate/3` finds the agent's and the peer's posts
  by these texts, so they are part of the scenario's verifier-owned definition.
  """
  @spec handoff_texts() :: %{pre: String.t(), post: String.t(), misuse: String.t()}
  def handoff_texts, do: @handoff_texts

  @doc """
  Names of the plan 204 carrier scenarios. Their evidence is written by the
  `lattice_carrier_server` test suite; this module only verifies it.
  """
  @spec carrier_scenarios() :: [String.t()]
  def carrier_scenarios, do: @carrier_scenarios

  @doc "The verifier-owned table entry for `name`, or `nil` for an unknown scenario."
  @spec spec(String.t()) :: spec() | nil
  def spec(name) when name in @carrier_scenarios,
    do: Map.put(@specs[name], :replicas, &expected_replicas(name, &1))

  def spec(name), do: Map.get(@specs, name)

  @doc """
  The replica name of `name`'s log `prefix`, `fault:<name>:<prefix>`; its replica id
  binds it to the seed's root realm key (`expected_replicas/2`).
  """
  @spec replica_name(String.t(), String.t()) :: String.t()
  def replica_name(name, prefix), do: "fault:#{name}:#{prefix}"

  @doc """
  Run scenario `name` with `seed` and return its final logs.

  `opts[:variant]` selects a test-only negative control: `:no_revoke` skips the
  revocation step of `revoke_offline`; `:no_beacon` skips the lapsing beacon of
  `handoff_lapse`.
  """
  @spec run(String.t(), String.t(), keyword()) :: {:ok, logs()} | {:error, :unknown_scenario}
  def run(name, seed, opts \\ []) when is_binary(name) and is_binary(seed) do
    case name do
      "partition_converge" -> {:ok, partition_converge(seed)}
      "revoke_offline" -> {:ok, revoke_offline(seed, Keyword.get(opts, :variant))}
      "handoff_lapse" -> {:ok, handoff_lapse(seed, Keyword.get(opts, :variant))}
      _other -> {:error, :unknown_scenario}
    end
  end

  @doc "The replica id each log prefix of `name` must carry for `seed`."
  @spec expected_replicas(String.t(), String.t()) :: %{String.t() => String.t()}
  def expected_replicas(name, seed) do
    %{realms: realms, root: root, modules: modules} = entry = spec(name)
    realms = Map.get(entry, :sim_realms, realms)

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

  defp handoff_lapse(seed, variant) do
    realms = spec("handoff_lapse").realms
    %{pre: pre, post: post, misuse: misuse} = @handoff_texts

    {thread, _} =
      Thread
      |> Sim.new(replica_name("handoff_lapse", "thread"), realms, seed: seed)
      |> Sim.create_replica("root")

    {thread, cap} =
      Sim.grant(thread, "root", "agent",
        ops: [:post],
        live: true,
        expires_epoch: @handoff_expires_epoch
      )

    thread = Sim.sync_all(thread)
    {thread, _} = Sim.command(thread, "agent", :post, [pre], cap: cap.id)
    thread = Sim.sync_all(thread)

    # The lapse is causal: every realm sees the beacon before the agent's next post,
    # so this is the "recipient saw the lapse and still tried" case.
    thread =
      if variant == :no_beacon do
        thread
      else
        {thread, _} = Sim.beacon(thread, "root", @handoff_beacon_epoch)
        Sim.sync_all(thread)
      end

    {thread, _} = Sim.command(thread, "agent", :post, [post], cap: cap.id)
    # `peer` never held the agent's delegation; it cites the id anyway.
    {thread, _} = Sim.command(thread, "peer", :post, [misuse], cap: cap.id)

    thread |> Sim.sync_all() |> then(&named_logs("thread", &1))
  end

  defp isolate(sim, realm),
    do: sim |> Sim.partition(realm, "root") |> Sim.partition(realm, "peer")

  defp rejoin(sim, realm),
    do: sim |> Sim.heal(realm, "root") |> Sim.heal(realm, "peer") |> Sim.sync_all()

  defp named_logs(prefix, sim),
    do: Map.new(sim.logs, fn {realm, log} -> {"#{prefix}.#{realm}", log} end)

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

  # Each op is found by its post text alone, never by the beacon, so the
  # `:no_beacon` control still locates every op and violates only the lapse check.
  defp evaluate("handoff_lapse", seed, logs) do
    keys = realm_keys("handoff_lapse", seed)
    thread = for {"thread." <> _, log} <- logs, do: log
    %{pre: pre, post: post, misuse: misuse} = @handoff_texts

    %{
      "pre_lapse_honored" =>
        nonempty_all?(thread, fn log ->
          with_post(log, pre, &(honored?(log, &1) and posted?(log, pre)))
        end),
      "pre_lapse_authored_by_agent" =>
        nonempty_all?(thread, fn log -> with_post(log, pre, &(&1.author == keys["agent"])) end),
      "post_lapse_quarantined_lease_expired" =>
        nonempty_all?(thread, fn log ->
          with_post(log, post, fn op ->
            op.author == keys["agent"] and op.cap == agent_cap(log, pre) and
              reason(log, op) == :lease_expired and not posted?(log, post)
          end)
        end),
      # The judge checks the audience before the lease, so the peer's citation of
      # the agent's delegation fails as :capability_wrong_audience with or without
      # the beacon. Pinned as the judge reports it (plan 287 STOP conditions).
      "peer_cannot_cite_agent_delegation" =>
        nonempty_all?(thread, fn log ->
          with_post(log, misuse, fn op ->
            op.author == keys["peer"] and op.cap == agent_cap(log, pre) and
              reason(log, op) == :capability_wrong_audience and not posted?(log, misuse)
          end)
        end),
      # Vacuous without a beacon; it guards against a quarantined beacon, not its absence.
      "beacon_honored" =>
        nonempty_all?(thread, fn log -> Enum.all?(beacon_ops(log), &honored?(log, &1)) end),
      "states_equal" => same?(thread, &Lattice.state(Thread, &1)),
      "reasons_identical_across_realms" => same?(thread, &Authority.analyze(Thread, &1).reasons)
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

  # Exactly one post carrying `text`; zero or several is not this script.
  defp with_post(log, text, fun) do
    case for(%Op{kind: :command, body: {:post, [^text]}} = op <- Map.values(Log.ops(log)), do: op) do
      [op] -> fun.(op)
      _none_or_many -> false
    end
  end

  defp agent_cap(log, pre_text), do: with_post(log, pre_text, & &1.cap)

  defp honored?(log, op) do
    analysis = Authority.analyze(Thread, log)
    not MapSet.member?(analysis.quarantine, op.id) and not Map.has_key?(analysis.reasons, op.id)
  end

  defp reason(log, op), do: Map.get(Authority.analyze(Thread, log).reasons, op.id)

  defp posted?(log, text), do: text in Lattice.state(Thread, log).posts

  defp beacon_ops(log) do
    for %Op{kind: :authority, body: body} = op <- Map.values(Log.ops(log)),
        is_tuple(body) and elem(body, 0) == :beacon,
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
