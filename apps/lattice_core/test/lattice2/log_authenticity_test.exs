defmodule Lattice2.LogAuthenticityTest do
  use ExUnit.Case, async: true

  alias Lattice.{Identity, Log, Op}

  @moduletag :tmp_dir
  @replica "replica:thread:authenticity"

  setup %{tmp_dir: tmp_dir} do
    identity = Identity.from_seed("author", <<94::256>>)
    first = Op.new(identity, @replica, [], :command, {:post, ["first"]})
    second = Op.new(identity, @replica, [first.id], :command, {:post, ["second"]})
    log = Log.new(@replica) |> Log.append!(first) |> Log.append!(second)
    %{identity: identity, log: log, first: first, second: second, path: Path.join(tmp_dir, "log")}
  end

  test "authenticity preserves accepted ops alongside verified rejected-signature evidence",
       context do
    %{log: log, first: first} = context
    rejected = %{first | sig: <<0::512>>}
    {:quarantined, quarantined, :bad_signature} = Log.accept(Log.new(@replica), rejected)
    with_evidence = %{log | quarantine: quarantined.quarantine}

    assert :ok = Log.verify_authenticity(log)
    assert :ok = Log.verify_authenticity(with_evidence)
    assert {:ok, [%{op_id: id, reason: :bad_signature}]} = Log.verified_quarantine(with_evidence)
    assert id == first.id
    # The genuine accepted op sharing the forgery's ID remains accepted.
    assert Log.fetch(with_evidence, first.id) == {:ok, first}
  end

  test "refuses accepted-op signature, map-key, replica and dependency tampering by op id",
       context do
    %{log: log, first: first, second: second, identity: identity} = context
    missing = Op.new(identity, @replica, ["missing"], :command, {:post, ["orphan"]})
    other = Op.new(identity, "replica:other", [], :command, {:post, ["wrong replica"]})

    for {tampered, id} <- [
          {%{log | ops: Map.put(log.ops, second.id, %{second | sig: <<0::512>>})}, second.id},
          {%{log | ops: Map.put(log.ops, "wrong-key", first)}, "wrong-key"},
          {Log.from_ops(@replica, %{other.id => other}), other.id},
          {Log.from_ops(@replica, %{missing.id => missing}), missing.id},
          {%{log | ops: %{first.id => %{body: :invalid}}}, first.id}
        ] do
      assert {:error, errors} = Log.verify_authenticity(tampered)
      assert Enum.any?(errors, &String.contains?(&1, id))
      assert errors == Enum.sort(errors)
    end
  end

  test "refuses forged frontier bookkeeping and structural-quarantine claims", context do
    %{log: log, first: first} = context
    rejected = %{first | sig: <<0::512>>}
    entry = %{op: rejected, reason: :bad_signature}

    for tampered <- [
          %{log | referenced: MapSet.new()},
          %{log | quarantine: [%{op: first, reason: :bad_signature}]},
          %{log | quarantine: [%{entry | reason: :missing_deps}]},
          %{log | quarantine: [entry, entry]},
          %{log | quarantine: [%{entry | op: %{rejected | replica: "replica:other"}}]},
          %{log | ops: :invalid},
          %{log | referenced: :invalid},
          %{log | quarantine: :invalid}
        ] do
      assert {:error, [_ | _]} = Log.verify_authenticity(tampered)
    end
  end

  test "verified restore fingerprints captured legacy bytes without rewriting them", context do
    %{log: log, path: path} = context
    bytes = :erlang.term_to_binary({:lattice_log_dump_v1, log})
    File.write!(path, bytes)
    assert {:ok, %{log: restored, sha256: sha256}} = Log.restore_verified(path)
    assert restored == log
    assert sha256 == :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)
    assert File.read!(path) == bytes
  end

  test "verified restore rejects a forgery while the original restore contract stays unverified",
       context do
    %{log: log, first: first, path: path} = context
    forged = %{log | ops: Map.put(log.ops, first.id, %{first | sig: <<0::512>>})}
    assert :ok = Log.dump(forged, path)

    assert {:ok, ^forged} = Log.restore(path)
    assert {:error, errors} = Log.restore_verified(path)
    assert Enum.any?(errors, &String.contains?(&1, first.id))
  end

  test "malformed dump collections cannot normalize into an empty restored log", context do
    %{log: log, path: path} = context

    for ops <- [[], :invalid, %{"invalid" => %{body: :invalid}}] do
      File.write!(path, :erlang.term_to_binary({:lattice_log_dump_v1, %{log | ops: ops}}))
      assert {:error, :invalid_log} = Log.restore_verified(path)
    end
  end
end
