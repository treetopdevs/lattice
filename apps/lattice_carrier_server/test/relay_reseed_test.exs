defmodule LatticeCarrierServer.RelayReseedTest do
  @moduledoc """
  Gate AF-1: a carrier relay is disposable and reseedable from a member's
  retained copy.

  The relay holds no authority of its own. Every member (the clerk, the
  resident and an admitted member realm) keeps its own local `Lattice.Log`
  between phases and pulls only what that copy lacks over the real WebSocket
  carrier. The reseeding member's copy starts empty and holds only bytes it
  pulled over that carrier. That member stands up a brand-new relay (fresh
  service identity, fresh disk) from its retained state alone: the pulled log
  plus the transport admission list (realm ids and public keys) it already
  holds as pairing state. Every member reconverges on `Lattice.Sim` as the
  oracle with the acknowledged relay ops intact.

  The negative control is deliberately narrow: a stale copy reseeds a relay
  that serves a strictly smaller op-id set than the oracle, the missing ops are
  enumerable against the oracle and against a member copy that retained the
  acknowledged op, and the reseeded relay's frontier is behind. Neither the
  relay nor the stale member detects that gap on its own; no divergence
  reporting path is built or claimed here.
  """

  use ExUnit.Case, async: false

  alias Lattice.Carrier.WebSocket
  alias Lattice.{Dag, Log, Sim, Sync}
  alias Township.Matter

  @moduletag timeout: 300_000

  @pilot_script Path.expand("../priv/pilot_node.exs", __DIR__)
  @instance_name "township-relay"
  @members ["clerk", "resident", "member"]

  @tag :tmp_dir
  test "a relay is disposable and reseedable from a member's retained copy", %{tmp_dir: tmp_dir} do
    %{sim: sim, base_log: base_log, peers: peers, copies: copies, pairing: pairing} =
      township_fixture()

    %{"resident" => resident} = peers

    # 1. Relay A boots from the base community log with its own service identity.
    dir_a = Path.join(tmp_dir, "relay-a")
    pilot_a = write_pilot(dir_a, "relay-a", base_log, pairing.admissions, pairing.relay_realms)
    server_a = spawn_pilot(pilot_a)
    assert %{@instance_name => %{port: port_a, pubkey: pubkey_a}} = server_a.instances
    assert pubkey_a == Base.encode64(pilot_a.server_pub)

    # 2. The member's copy starts empty and is filled only by pulling from A,
    #    so every byte it later reseeds from was obtained over the carrier.
    {copies, member_pulled} = pull_into(copies, "member", port_a, peers, pilot_a)
    assert member_pulled == sorted_ids(base_log)
    assert Log.frontier(copies["member"]) == Log.frontier(base_log)

    # 3. The resident authors op1 on its own copy (Sim is the oracle) and relays it to A.
    {sim, op1} = Sim.command(sim, "resident", :post, ["resident: before the relay died"])
    sim = Sim.sync_all(sim)
    copies = Map.update!(copies, "resident", &Log.append!(&1, op1))
    assert relay_op(port_a, resident, pilot_a, op1) == op1.id

    # 4. The member pulls only what its retained copy lacks, never A's disk.
    {copies, member_pulled} = pull_into(copies, "member", port_a, peers, pilot_a)
    assert member_pulled == [op1.id]
    assert sorted_ids(copies["member"]) == sorted_ids(Sim.log(sim, "member"))
    assert Log.frontier(copies["member"]) == Log.frontier(Sim.log(sim, "member"))

    # The clerk never talks to A: its copy stays at the base and must be
    # repaired by the reseeded relay alone.
    assert sorted_ids(copies["clerk"]) == sorted_ids(base_log)

    # 5. Relay A and its disk are gone.
    output_a = stop_pilot(server_a)
    File.rm_rf!(dir_a)
    refute File.exists?(pilot_a.log_path)
    refute File.exists?(pilot_a.identity_path)

    # 6. The member reseeds relay B from its own retained copy under a different identity.
    dir_b = Path.join(tmp_dir, "relay-b")
    # Relay B is built from the member's retained state only: the log it
    # pulled plus the transport admission list it holds as pairing state.
    # The Sim identity map is never consulted for B.
    retained = retained_member_state(copies["member"], pairing)

    pilot_b =
      write_pilot(dir_b, "relay-b", retained.log, retained.admissions, retained.relay_realms)

    refute pilot_b.server_pub == pilot_a.server_pub, "the reseeded relay must mint a new identity"
    server_b = spawn_pilot(pilot_b)
    assert %{@instance_name => %{port: port_b, pubkey: pubkey_b}} = server_b.instances
    assert pubkey_b == Base.encode64(pilot_b.server_pub)
    refute pubkey_b == pubkey_a, "the reseeded relay must run under a different identity"

    # 7. The resident relays op2 to B; every member pulls incrementally from B.
    {sim, op2} = Sim.command(sim, "resident", :post, ["resident: after the reseed"])
    sim = Sim.sync_all(sim)
    assert op1.id in op2.deps, "op2 must causally follow op1"
    copies = Map.update!(copies, "resident", &Log.append!(&1, op2))
    assert relay_op(port_b, resident, pilot_b, op2) == op2.id

    {copies, member_pulled} = pull_into(copies, "member", port_b, peers, pilot_b)
    assert member_pulled == [op2.id]

    {copies, clerk_pulled} = pull_into(copies, "clerk", port_b, peers, pilot_b)

    assert clerk_pulled == Enum.sort([op1.id, op2.id]),
           "the reseeded relay must repair a member that never pulled from the lost relay"

    {copies, resident_pulled} = pull_into(copies, "resident", port_b, peers, pilot_b)
    assert resident_pulled == [], "the author's copy already holds every acknowledged op"

    # 8. Every member reaches the oracle: same ids, frontier, order, state and bytes.
    for realm <- @members do
      oracle = Sim.log(sim, realm)
      copy = copies[realm]
      assert sorted_ids(copy) == sorted_ids(oracle), "#{realm} copy must hold the oracle op set"
      assert Log.frontier(copy) == Log.frontier(oracle), "#{realm} frontier must match the oracle"
      assert topo_ids(copy) == topo_ids(oracle), "#{realm} causal order must match the oracle"
      assert Lattice.state(Matter, copy) == Sim.state(sim, realm)
      assert state_bytes(copy) == state_bytes(oracle), "#{realm} state bytes must match"
      assert op1.id in Log.op_ids(copy) and op2.id in Log.op_ids(copy)
      assert Enum.all?(@members, &(&1 in Lattice.state(Matter, copy).members))
    end

    # B serves exactly the oracle op set and never authors anything itself.
    full_served = pull_missing(port_b, peers["member"], pilot_b, MapSet.new())
    assert sorted_ids(full_served) == sorted_ids(Sim.log(sim, "clerk"))
    refute pilot_b.server_pub in Enum.map(full_served, & &1.author)

    output_b = stop_pilot(server_b)
    refute_secret_echo(output_a <> "\n" <> output_b, [pilot_a, pilot_b])
  end

  @tag :tmp_dir
  test "a stale member copy reseeds a relay that is visibly behind the acknowledged op", %{
    tmp_dir: tmp_dir
  } do
    %{sim: sim, base_log: base_log, peers: peers, copies: copies, pairing: pairing} =
      township_fixture()

    %{"resident" => resident} = peers

    dir_a = Path.join(tmp_dir, "relay-a")
    pilot_a = write_pilot(dir_a, "relay-a", base_log, pairing.admissions, pairing.relay_realms)
    server_a = spawn_pilot(pilot_a)
    assert %{@instance_name => %{port: port_a}} = server_a.instances

    # The member's copy is built only by pulling from A, BEFORE op1 reaches
    # the relay: pull-only bytes that are stale at the base.
    {copies, stale_pulled} = pull_into(copies, "member", port_a, peers, pilot_a)
    assert stale_pulled == sorted_ids(base_log)
    stale_ids = sorted_ids(copies["member"])
    assert stale_ids == sorted_ids(base_log)

    {sim, op1} = Sim.command(sim, "resident", :post, ["resident: relayed after the stale pull"])
    sim = Sim.sync_all(sim)
    copies = Map.update!(copies, "resident", &Log.append!(&1, op1))
    assert relay_op(port_a, resident, pilot_a, op1) == op1.id

    # Relay A serves the acknowledged op: the clerk pulls it and retains it
    # outside A, so the evidence of op1 survives A's loss.
    {copies, clerk_pulled} = pull_into(copies, "clerk", port_a, peers, pilot_a)
    assert clerk_pulled == [op1.id]
    oracle = Sim.log(sim, "clerk")
    expected_ids = sorted_ids(oracle)
    assert sorted_ids(copies["clerk"]) == expected_ids
    assert Log.frontier(copies["clerk"]) == Log.frontier(oracle)
    assert op1.id in expected_ids

    output_a = stop_pilot(server_a)
    File.rm_rf!(dir_a)
    refute File.exists?(pilot_a.log_path)

    dir_b = Path.join(tmp_dir, "relay-b")
    # Relay B is built from the member's retained state only: the log it
    # pulled plus the transport admission list it holds as pairing state.
    # The Sim identity map is never consulted for B.
    retained = retained_member_state(copies["member"], pairing)

    pilot_b =
      write_pilot(dir_b, "relay-b", retained.log, retained.admissions, retained.relay_realms)

    refute pilot_b.server_pub == pilot_a.server_pub, "the reseeded relay must mint a new identity"
    server_b = spawn_pilot(pilot_b)
    assert %{@instance_name => %{port: port_b, pubkey: pubkey_b}} = server_b.instances
    refute pubkey_b == server_a.instances[@instance_name].pubkey

    # B cannot repair the stale member: an incremental pull yields nothing.
    {copies, member_pulled} = pull_into(copies, "member", port_b, peers, pilot_b)
    assert member_pulled == []

    served_ops = pull_missing(port_b, peers["member"], pilot_b, MapSet.new())
    served_ids = sorted_ids(served_ops)
    relay_b_log = log_from_ops(base_log.replica, served_ops)

    # The stale reseed is visibly incomplete against retained evidence: a
    # strictly smaller id set, the missing op enumerable, the frontier behind.
    refute op1.id in served_ids,
           "stale reseed must not serve the op it never had: op1 #{inspect(op1.id)} " <>
             "appeared in #{inspect(served_ids)}"

    assert served_ids == stale_ids,
           "stale reseed must serve exactly the stale copy: served #{inspect(served_ids)} " <>
             "vs stale #{inspect(stale_ids)}"

    assert MapSet.subset?(MapSet.new(served_ids), MapSet.new(expected_ids)) and
             served_ids != expected_ids,
           "stale reseed must serve a strictly smaller set than the oracle: " <>
             "served #{inspect(served_ids)} vs oracle #{inspect(expected_ids)}"

    assert expected_ids -- served_ids == [op1.id],
           "the only gap must be op1: oracle #{inspect(expected_ids)} minus served " <>
             "#{inspect(served_ids)} was #{inspect(expected_ids -- served_ids)}"

    assert sorted_ids(copies["clerk"]) -- served_ids == [op1.id],
           "the clerk's retained copy must enumerate the same gap"

    assert Log.frontier(relay_b_log) == Log.frontier(base_log)
    assert Log.frontier(relay_b_log) != Log.frontier(copies["clerk"])

    assert MapSet.subset?(MapSet.new(Log.frontier(relay_b_log)), MapSet.new(op1.deps)),
           "the stale relay's frontier must sit strictly behind the acknowledged op: " <>
             "#{inspect(Log.frontier(relay_b_log))} vs op1 deps #{inspect(op1.deps)}"

    output_b = stop_pilot(server_b)
    refute_secret_echo(output_a <> "\n" <> output_b, [pilot_a, pilot_b])
  end

  # --- Township fixture ----------------------------------------------------

  # Three member realms: the clerk (root), the resident (post capability) and
  # an admitted member. Every realm is admitted into `Matter.members`. The
  # clerk and the resident retain the base log they authored and synced in
  # Sim; the member's local copy starts empty and must obtain every byte by
  # pulling over the carrier.
  defp township_fixture do
    replica_name = "replica:matter:relay-reseed"
    sim = Sim.new(Matter, replica_name, @members, seed: "relay-reseed")
    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, _grant} = Sim.grant(sim, "clerk", "resident", ops: [:post])

    sim =
      Enum.reduce(@members, sim, fn realm, sim ->
        {sim, _admit} = Sim.command(sim, "clerk", :admit, [realm])
        sim
      end)

    sim = Sim.sync_all(sim)
    base_log = Sim.log(sim, "clerk")
    assert Enum.all?(@members, &(&1 in Lattice.state(Matter, base_log).members))

    peers = Map.new(@members, &{&1, Sim.identity(sim, &1)})

    copies =
      @members
      |> Map.new(&{&1, Sim.log(sim, &1)})
      |> Map.put("member", Log.new(base_log.replica))

    assert sorted_ids(copies["clerk"]) == sorted_ids(base_log)
    assert sorted_ids(copies["resident"]) == sorted_ids(base_log)
    assert Log.op_ids(copies["member"]) == MapSet.new()

    # The transport admission list is pairing state every member already holds
    # (realm ids and public keys only). It is distinct from any relay's disk
    # and is what a reseeding member needs besides its pulled log.
    pairing = %{admissions: peer_admissions(peers), relay_realms: [peers["resident"].realm_id]}

    %{sim: sim, base_log: base_log, peers: peers, copies: copies, pairing: pairing}
  end

  defp peer_admissions(peers) do
    Enum.map(@members, fn realm ->
      %{"realm" => peers[realm].realm_id, "pubkey" => Base.encode64(peers[realm].pub)}
    end)
  end

  # What a member retains across a relay loss: its own pulled log and its
  # saved pairing state. Nothing here comes from the lost relay's disk.
  defp retained_member_state(%Log{} = log, %{admissions: admissions, relay_realms: relay_realms}) do
    %{log: log, admissions: admissions, relay_realms: relay_realms}
  end

  # Writes one pilot deployment (log dump, 0600 hex seed file, manifest) into
  # `dir`. Each call mints a distinct service identity from `label`. The
  # returned map carries only public material plus two closures over the
  # secret encodings, so no assertion can print a seed.
  defp write_pilot(dir, label, %Log{} = log, admissions, relay_realms)
       when is_list(admissions) and is_list(relay_realms) do
    File.mkdir_p!(dir)
    File.chmod!(dir, 0o700)

    log_path = Path.join(dir, "matter.log")
    assert :ok = Log.dump(log, log_path)

    server_seed = :crypto.hash(:sha256, "relay-reseed-server-#{label}-#{Path.basename(dir)}")
    {server_pub, server_priv} = :crypto.generate_key(:eddsa, :ed25519, server_seed)
    secret_forms = Enum.uniq(secret_encodings(server_seed) ++ secret_encodings(server_priv))

    identity_path = Path.join(dir, "town-node.identity")
    File.write!(identity_path, Base.encode16(server_seed, case: :lower) <> "\n")
    File.chmod!(identity_path, 0o600)

    manifest = %{
      "version" => 1,
      "health" => %{"ip" => "127.0.0.1", "port" => 0},
      "instances" => [
        %{
          "name" => @instance_name,
          "realm" => "town-node",
          "identity_file" => identity_path,
          "log_file" => log_path,
          "listener" => %{"ip" => "127.0.0.1", "port" => 0},
          "trusted_peers" => admissions,
          "relay_realms" => relay_realms
        }
      ]
    }

    manifest_path = Path.join(dir, "pilot-manifest.json")
    File.write!(manifest_path, Jason.encode!(manifest))

    %{
      manifest_path: manifest_path,
      identity_path: identity_path,
      log_path: log_path,
      server_realm: "town-node",
      server_pub: server_pub,
      replica: log.replica,
      leaks_secret: fn output -> Enum.any?(secret_forms, &String.contains?(output, &1)) end,
      redact: fn output ->
        Enum.reduce(secret_forms, output, &String.replace(&2, &1, "[REDACTED_SERVER_SEED]"))
      end
    }
  end

  defp secret_encodings(secret) do
    [
      Base.encode16(secret, case: :lower),
      Base.encode16(secret),
      Base.encode64(secret),
      Base.encode64(secret, padding: false),
      Base.url_encode64(secret, padding: false),
      inspect(secret, limit: :infinity)
    ]
  end

  # A log grown only from served ops, appended in canonical causal order.
  defp log_from_ops(replica, ops) do
    ops
    |> Dag.topo_sort()
    |> Enum.reduce(Log.new(replica), &Log.append!(&2, &1))
  end

  defp sorted_ids(%Log{} = log), do: log |> Log.op_ids() |> Enum.sort()
  defp sorted_ids(ops) when is_list(ops), do: ops |> Enum.map(& &1.id) |> Enum.sort()
  defp topo_ids(%Log{} = log), do: log |> Log.topo_ops() |> Enum.map(& &1.id)

  defp state_bytes(log) do
    :erlang.term_to_binary(Lattice.state(Matter, log), [:deterministic])
  end

  defp refute_secret_echo(output, pilots) do
    leaked? = Enum.any?(pilots, fn pilot -> pilot.leaks_secret.(output) end)
    refute leaked?, "pilot output exposed a server seed encoding"
  end

  # --- carrier helpers ------------------------------------------------------

  defp relay_op(port, identity, pilot, op) do
    assert {:ok, connection} = WebSocket.connect(connect_opts(port, identity, pilot, op.replica))
    assert {:ok, %{accepted: [accepted_id]}, connection} = WebSocket.relay(connection, op)
    assert :ok = WebSocket.close(connection)
    accepted_id
  end

  # One member pulls only what its own retained copy lacks and folds it in.
  # Returns the updated copies and the sorted ids that were newly accepted.
  defp pull_into(copies, realm, port, peers, pilot) do
    copy = copies[realm]
    ops = pull_missing(port, peers[realm], pilot, Log.op_ids(copy))
    {copy, report} = Sync.deliver(copy, ops)
    assert report.quarantined == [], "#{realm} pull must not quarantine"
    assert report.rejected == [], "#{realm} pull must not reject"
    assert report.pending == [], "#{realm} pull must leave no dangling deps"
    {Map.put(copies, realm, copy), Enum.sort(report.accepted)}
  end

  defp pull_missing(port, identity, pilot, %MapSet{} = have) do
    assert {:ok, connection} =
             WebSocket.connect(connect_opts(port, identity, pilot, pilot.replica))

    assert {:ok, ops, connection} = WebSocket.pull(connection, have)
    assert :ok = WebSocket.close(connection)
    ops
  end

  defp connect_opts(port, identity, pilot, replica) do
    [
      hostname: "127.0.0.1",
      port: port,
      identity: identity,
      realm: identity.realm_id,
      peer_realm: pilot.server_realm,
      peer_pubkey: pilot.server_pub,
      replica: replica
    ]
  end

  # --- pilot process helpers ------------------------------------------------

  defp spawn_pilot(pilot) do
    args = code_path_args() ++ [@pilot_script, pilot.manifest_path]

    port =
      Port.open({:spawn_executable, elixir_bin()}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        {:line, 4_096},
        {:args, args},
        {:cd, repo_root()}
      ])

    os_pid =
      case Port.info(port, :os_pid) do
        {:os_pid, pid} when is_integer(pid) -> pid
        nil -> flunk("pilot exited before its OS pid could be observed")
        other -> flunk("pilot returned an invalid OS pid: #{inspect(other)}")
      end

    process_token = process_token!(port, os_pid, pilot)
    on_exit(fn -> terminate_pilot(os_pid, process_token) end)

    {instances, lines} = await_pilot_ready(port, pilot, %{}, [])

    %{
      port: port,
      os_pid: os_pid,
      process_token: process_token,
      instances: instances,
      lines: lines
    }
  end

  defp await_pilot_ready(port, pilot, instances, seen) do
    receive do
      {^port, {:data, {:eol, "INSTANCE " <> rest}}} ->
        [name, ws_port, pubkey] = String.split(String.trim(rest), " ")

        await_pilot_ready(
          port,
          pilot,
          Map.put(instances, name, %{port: String.to_integer(ws_port), pubkey: pubkey}),
          ["INSTANCE #{rest}" | seen]
        )

      {^port, {:data, {:eol, "PILOT_READY " <> _health}}} = message ->
        {instances, [format_message(message) | seen]}

      {^port, {:data, {:eol, line}}} ->
        await_pilot_ready(port, pilot, instances, [line | seen])

      {^port, {:data, {:noeol, chunk}}} ->
        await_pilot_ready(port, pilot, instances, [chunk | seen])

      {^port, {:exit_status, status}} ->
        flunk("pilot exited (#{status}) before READY:\n#{safe_output(pilot, seen)}")
    after
      60_000 -> flunk("pilot never became ready:\n#{safe_output(pilot, seen)}")
    end
  end

  # Stops the pilot cooperatively, awaits its exit status, and returns the raw
  # output (raw on purpose: the secret scan must see what was really printed).
  defp stop_pilot(%{port: port, lines: lines}) do
    true = Port.command(port, "stop\n")
    port |> drain_until_exit(lines) |> Enum.reverse() |> Enum.join("\n")
  end

  defp drain_until_exit(port, lines) do
    receive do
      {^port, {:data, {:eol, line}}} -> drain_until_exit(port, [line | lines])
      {^port, {:data, {:noeol, chunk}}} -> drain_until_exit(port, [chunk | lines])
      {^port, {:exit_status, 0}} -> lines
      {^port, {:exit_status, status}} -> flunk("pilot exited with status #{status} on stop")
    after
      10_000 -> flunk("pilot did not exit within 10s of stop")
    end
  end

  # Idempotent, guarded kill: only signals the pid while it is still the same
  # process we spawned (matching start token), so a reused pid is never hit.
  defp terminate_pilot(os_pid, expected_token) do
    if portable_process_token(os_pid) == {:ok, expected_token} do
      _ = System.cmd("kill", ["-9", Integer.to_string(os_pid)], stderr_to_stdout: true)
    end

    :ok
  end

  defp process_token!(port, os_pid, pilot) do
    case portable_process_token(os_pid) do
      {:ok, token} ->
        token

      :error ->
        seen = drain_briefly(port, [])
        # No token means no guarded kill. Closing the port gives the pilot
        # stdin EOF, on which it halts itself once it reaches its reader, so
        # the child never outlives the failed test.
        if Port.info(port), do: Port.close(port)
        flunk("pilot process token unavailable for pid #{os_pid}:\n#{safe_output(pilot, seen)}")
    end
  end

  defp drain_briefly(port, lines) do
    receive do
      {^port, {:data, {:eol, line}}} -> drain_briefly(port, [line | lines])
      {^port, {:data, {:noeol, chunk}}} -> drain_briefly(port, [chunk | lines])
      {^port, {:exit_status, _status}} -> lines
    after
      100 -> lines
    end
  end

  defp portable_process_token(os_pid) do
    case proc_start_token(os_pid) do
      {:ok, token} -> {:ok, {:proc_start, token}}
      :error -> ps_start_token(os_pid)
    end
  end

  defp proc_start_token(os_pid) do
    with {:ok, stat} <- File.read("/proc/#{os_pid}/stat"),
         [fields] <- Regex.run(~r/^\d+ \(.*\) (.*)$/s, stat, capture: :all_but_first),
         token when is_binary(token) <- fields |> String.split() |> Enum.at(19) do
      {:ok, token}
    else
      _unavailable -> :error
    end
  end

  defp ps_start_token(os_pid) do
    case System.cmd("ps", ["-o", "lstart=", "-p", Integer.to_string(os_pid)],
           stderr_to_stdout: true
         ) do
      {output, 0} ->
        case String.trim(output) do
          "" -> :error
          token -> {:ok, {:ps_start, token}}
        end

      {_output, _status} ->
        :error
    end
  end

  defp format_message({_port, {:data, {:eol, line}}}), do: line

  defp safe_output(pilot, lines) do
    lines |> Enum.reverse() |> Enum.join("\n") |> then(pilot.redact) |> bounded_tail()
  end

  defp bounded_tail(binary) do
    valid = String.replace_invalid(binary)
    start = max(String.length(valid) - 4_096, 0)
    String.slice(valid, start, 4_096)
  end

  defp code_path_args do
    :code.get_path()
    |> Enum.map(&List.to_string/1)
    |> Enum.filter(&String.contains?(&1, "_build"))
    |> Enum.flat_map(&["-pa", &1])
  end

  defp elixir_bin do
    shim = Path.expand("~/.asdf/shims/elixir")

    cond do
      File.exists?(shim) -> shim
      path = System.find_executable("elixir") -> path
      true -> flunk("no elixir executable available to spawn the pilot")
    end
  end

  defp repo_root, do: Path.expand("../../..", __DIR__)
end
