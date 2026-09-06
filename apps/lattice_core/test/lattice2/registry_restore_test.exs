defmodule Lattice2.RegistryRestoreTest do
  use ExUnit.Case, async: false

  alias Lattice.Demo.Thread
  alias Lattice.{Identity, Log, Registry, Sim}

  @moduletag :tmp_dir

  setup %{tmp_dir: tmp_dir} do
    Lattice.reset!()
    on_exit(fn -> Lattice.reset!() end)
    sim = Sim.new(Thread, "replica:thread:verified-restore", ["owner"], seed: "verified-restore")
    {sim, _} = Sim.create_replica(sim, "owner")
    {sim, post} = Sim.command(sim, "owner", :post, ["retained history"])
    log = Sim.log(sim, "owner")
    identity = Sim.identity(sim, "owner")
    :ok = Registry.host(identity, Thread, log.replica, log)
    {:ok, state} = Registry.materialize(identity.realm_id, log.replica)

    %{
      log: log,
      post: post,
      identity: identity,
      state: state,
      path: Path.join(tmp_dir, "thread.log")
    }
  end

  test "forged restore neither replaces a live copy nor installs a new realm", context do
    %{log: log, post: post, identity: identity, path: path} = context
    forged = %{post | sig: <<0::512>>}
    :ok = Log.dump(%{log | ops: Map.put(log.ops, forged.id, forged)}, path)

    assert {:error, :invalid_log} = Registry.restore(identity, Thread, log.replica, path)
    assert Registry.log(identity.realm_id, log.replica) == log
    assert Registry.state(identity.realm_id, log.replica) == context.state
    assert Registry.lifecycle(identity.realm_id, log.replica) == :live

    newcomer = Identity.from_seed("newcomer", <<92::256>>)
    assert {:error, :invalid_log} = Registry.restore(newcomer, Thread, log.replica, path)
    assert Registry.log(newcomer.realm_id, log.replica) == :error
  end

  test "an authentic dump cannot be installed under another replica", context do
    %{log: log, identity: identity, path: path} = context
    sim = Sim.new(Thread, "replica:thread:other", ["owner"], seed: "other-restore")
    {sim, _} = Sim.create_replica(sim, "owner")
    other = Sim.log(sim, "owner")
    assert :ok = Log.verify_authenticity(other)
    :ok = Log.dump(other, path)

    assert {:error, :wrong_replica} = Registry.restore(identity, Thread, log.replica, path)
    assert Registry.log(identity.realm_id, log.replica) == log
    assert Registry.state(identity.realm_id, log.replica) == context.state
    assert Registry.lifecycle(identity.realm_id, log.replica) == :live

    assert {:error, :wrong_replica} = Registry.restore(identity, Thread, "absent", path)
    assert Registry.log(identity.realm_id, "absent") == :error
  end

  @tag capture_log: true
  test "a malformed serialized op refuses without crashing or resetting the registry", context do
    %{log: log, identity: identity, path: path} = context
    malformed = %{log | ops: %{"broken" => %{body: :invalid}}}
    File.write!(path, :erlang.term_to_binary({:lattice_log_dump_v1, malformed}))

    assert {:error, :invalid_log} = Registry.restore(identity, Thread, log.replica, path)
    assert Registry.log(identity.realm_id, log.replica) == log
    assert Registry.state(identity.realm_id, log.replica) == context.state
    assert Registry.lifecycle(identity.realm_id, log.replica) == :live
  end
end
