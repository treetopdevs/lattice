defmodule Lattice2.LogSyncTest do
  @moduledoc """
  Phase A gate: Op / canonical encoding / signing / Log / Sync.

  Covers behavior 1 at the raw-op level (op-set convergence after partition+heal),
  behavior 3 (idempotent sync), behavior 4 (tamper rejection at sync). Reduced-state
  convergence (the full behavior 1/2/18) is exercised in the Replica/CRDT tests.
  """
  use ExUnit.Case, async: true

  alias Lattice.{Identity, Log, Op, Sync}

  @replica "replica:thread:1"

  defp realm(seed), do: Identity.from_seed(seed, "seed:" <> seed)

  # Author an op on a realm's local log, depping on the realm's current frontier.
  defp author(log, identity, kind, body) do
    op = Op.new(identity, @replica, Log.frontier(log), kind, body)
    {Log.append!(log, op), op}
  end

  test "op id is a deterministic content hash; same content => same id" do
    a = realm("a")
    op1 = Op.new(a, @replica, [], :command, {:post, "hello"})
    op2 = Op.new(a, @replica, [], :command, {:post, "hello"})
    assert op1.id == op2.id
    assert Op.valid?(op1)

    different = Op.new(a, @replica, [], :command, {:post, "world"})
    refute different.id == op1.id
  end

  test "deps order does not affect the op id (frontier order independence)" do
    a = realm("a")
    base = Op.new(a, @replica, [], :command, {:post, "g"})
    b1 = Op.new(a, @replica, ["x", "y", "z"], :command, {:post, "m"})
    b2 = Op.new(a, @replica, ["z", "x", "y"], :command, {:post, "m"})
    assert b1.id == b2.id
    assert base.id != b1.id
  end

  test "behavior 1 (raw): partitioned realms converge to identical op sets after heal+sync" do
    a = realm("a")
    b = realm("b")

    # Shared genesis both realms start from.
    genesis = Op.new(a, @replica, [], :command, {:post, "genesis"})
    log_a = Log.append!(Log.new(@replica), genesis)
    log_b = Log.append!(Log.new(@replica), genesis)

    # Partitioned: each realm appends its own convergent commands.
    {log_a, _} = author(log_a, a, :command, {:post, "a1"})
    {log_a, _} = author(log_a, a, :command, {:post, "a2"})
    {log_b, _} = author(log_b, b, :command, {:post, "b1"})

    refute Log.op_ids(log_a) == Log.op_ids(log_b)

    {log_a, log_b, report} = Sync.reconcile(log_a, log_b)

    assert Log.op_ids(log_a) == Log.op_ids(log_b)
    assert Log.frontier(log_a) == Log.frontier(log_b)
    assert Log.size(log_a) == 4
    # a was missing b1; b was missing a1, a2.
    assert report.into_a.accepted |> length() == 1
    assert report.into_b.accepted |> length() == 2
    assert report.into_a.quarantined == []
  end

  test "behavior 3: sync is idempotent — re-syncing inserts nothing" do
    a = realm("a")
    b = realm("b")
    genesis = Op.new(a, @replica, [], :command, {:post, "g"})
    log_a = Log.append!(Log.new(@replica), genesis)
    log_b = Log.append!(Log.new(@replica), genesis)
    {log_a, _} = author(log_a, a, :command, {:post, "a1"})
    {log_b, _} = author(log_b, b, :command, {:post, "b1"})

    {log_a, log_b, _} = Sync.reconcile(log_a, log_b)
    size_a = Log.size(log_a)

    {log_a2, log_b2, report} = Sync.reconcile(log_a, log_b)
    assert Log.size(log_a2) == size_a
    assert report.into_a.accepted == []
    assert report.into_b.accepted == []
    assert Log.op_ids(log_a2) == Log.op_ids(log_b2)
  end

  test "behavior 4: a tampered op fails verification and is quarantined at sync" do
    a = realm("a")
    genesis = Op.new(a, @replica, [], :command, {:post, "g"})
    op = Op.new(a, @replica, [genesis.id], :command, {:post, "authentic"})

    # Bit-flip the body but keep the original id/sig — exactly what a malicious
    # or corrupting peer would offer over the wire.
    tampered = %{op | body: {:post, "forged"}}
    refute Op.valid?(tampered)

    log = Log.append!(Log.new(@replica), genesis)
    {log, report} = Sync.deliver(log, [tampered])

    refute Log.has?(log, tampered.id)
    assert [{_id, :bad_signature}] = report.quarantined
    # Nothing dropped on the floor: it is retained for audit.
    assert [%{reason: :bad_signature}] = Log.quarantine(log)
  end

  test "any dep-respecting delivery order converges (buffering missing deps)" do
    a = realm("a")
    g = Op.new(a, @replica, [], :command, {:post, "g"})
    o1 = Op.new(a, @replica, [g.id], :command, {:post, "1"})
    o2 = Op.new(a, @replica, [o1.id], :command, {:post, "2"})
    o3 = Op.new(a, @replica, [o2.id], :command, {:post, "3"})

    # Deliver children before parents; Sync must buffer and still converge.
    {log, report} = Sync.deliver(Log.new(@replica), [o3, o2, o1, g])
    assert Log.size(log) == 4
    assert report.pending == []
    assert MapSet.new(report.accepted) == MapSet.new([g.id, o1.id, o2.id, o3.id])
  end
end
