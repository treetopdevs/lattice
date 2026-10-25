defmodule LatticeCarrierServer.Operator.CurrentInitialHistoryTest do
  use ExUnit.Case, async: false
  alias Lattice.{Authority, Identity, Log, Op, Sim}
  alias LatticeCarrierServer.Operator.{Fixture, InitialProvisioning, Journal, Staging}

  setup do
    {:ok, data} = Fixture.new(second_member: true)
    f = Map.new(data)
    [child, reference, _] = f.artifacts
    child_path = Path.join(f.root, "current-child.log")
    ref_path = Path.join(f.root, "current-reference.json")
    File.write!(ref_path, reference.bytes)

    record = %{
      "artifacts" => [
        %{
          "kind" => "log",
          "path" => child_path,
          "op_id" => child.op_id,
          "replica" => child.replica,
          "review" => child.review
        },
        %{
          "kind" => "reference",
          "path" => ref_path,
          "op_id" => reference.op_id,
          "replica" => reference.replica,
          "sha256" => Journal.digest(reference.bytes),
          "review" => %{"mode" => "initial_existing"}
        }
      ]
    }

    log = Sim.log(f.child, "creator")
    peers = [Base.encode64(Authority.root(log)) | Staging.roster(f.updated_log)]

    admitted = %{
      trusted_peers:
        Map.new(peers, fn key ->
          pub = Base.decode64!(key)
          {InitialProvisioning.client_realm(pub), pub}
        end)
    }

    {:ok, f: f, log: log, record: record, admitted: admitted, path: child_path}
  end

  test "a quarantined authentic post stays retained without wedging the live recheck", f do
    stranger = Identity.from_seed("noise", "initial-live-noise")
    noise = Op.new(stranger, f.log.replica, Log.frontier(f.log), :command, {:post, ["noise"]})
    assert {:ok, changed} = Log.accept(f.log, noise)
    assert Map.has_key?(Authority.analyze(Treehouse.Thread, changed).reasons, noise.id)
    :ok = Log.dump(changed, f.path)

    assert {:ok, current} =
             Staging.roster_current(f.record, f.admitted, [f.f.updated_log], :roster_drift)

    assert current.child_log.ops[noise.id] == noise
  end

  test "a quarantined authentic revocation cannot affect the reviewed live inventory", f do
    stranger = Identity.from_seed("noise", "initial-live-noise")
    delegation = hd(hd(f.f.artifacts).review["grants"])["delegation"]

    noise =
      Op.new(stranger, f.log.replica, Log.frontier(f.log), :authority, {:revoke, delegation})

    assert {:ok, changed} = Log.accept(f.log, noise)
    assert Map.has_key?(Authority.analyze(Treehouse.Thread, changed).reasons, noise.id)
    refute Authority.revoked?(changed, delegation)
    :ok = Log.dump(changed, f.path)

    assert {:ok, _} =
             Staging.roster_current(f.record, f.admitted, [f.f.updated_log], :roster_drift)
  end
end
