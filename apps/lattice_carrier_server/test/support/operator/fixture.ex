defmodule LatticeCarrierServer.Operator.Fixture do
  @moduledoc false
  import ExUnit.Assertions
  import ExUnit.Callbacks
  alias Lattice.Carrier.Wire
  alias Lattice.{Log, Sim}
  alias LatticeCarrierServer.Operator.{Journal, Staging}

  def new do
    root = Path.expand(".operator-stage-#{System.unique_integer([:positive])}", File.cwd!())
    File.mkdir!(root)
    File.chmod!(root, 0o700)
    on_exit(fn -> File.rm_rf!(root) end)

    {space, _} =
      Sim.new(Treehouse.Space, "space:operator", ["creator"], seed: "operator-space")
      |> Sim.create_replica("creator")

    {space, _} = Sim.command(space, "creator", :create_space, ["Canopy"])
    member = Base.encode64(Sim.identity(space, "creator").pub)
    {space, invitation} = Sim.command(space, "creator", :issue_invitation, [member, []])

    acceptance =
      Treehouse.Invitation.accept(Sim.identity(space, "creator"), space.replica, invitation)

    {space, admission} =
      Sim.command(space, "creator", :admit_member, [invitation.id, member, "member", acceptance])

    refute Sim.quarantined(space, "creator", admission.id)

    {child, genesis} =
      Sim.new(
        Treehouse.Thread,
        "replica:treehouse:thread:" <>
          Treehouse.ContinuationFixtures.digest("operator") <>
          "#authority:bounded-continuation-v1",
        ["creator", "nominee", "w1", "w2", "w3", "space-member"],
        seed: "independent-child"
      )
      |> Sim.create_replica("creator")

    child = %{
      child
      | realms: Map.put(child.realms, "space-member", Sim.identity(space, "creator"))
    }

    {child, creation} = Sim.command(child, "creator", :create_thread, ["Branch"])
    {child, pin, _} = Treehouse.ContinuationFixtures.pin(child, author: "creator")

    {child, grant} =
      Sim.grant(child, "creator", "space-member",
        ops: [:post, :author_edit, :author_tombstone],
        expires_epoch: 7
      )

    child_log = Sim.log(child, "creator")

    grant_intro =
      Enum.find(Log.ops(child_log), fn {_id, op} -> op.body == {:grant, grant} end) |> elem(0)

    {:ok, selected} = Lattice.Authority.continuation_profile(child_log)

    child_review = %{
      "creation" => creation.id,
      "profile_genesis" => pin.id,
      "profile_id" => selected.profile_id,
      "grants" => [
        %{
          "recipient" => Base.encode64(Sim.identity(space, "creator").pub),
          "delegation" => grant.id,
          "introduction" => grant_intro
        }
      ]
    }

    assert Sim.identity(space, "creator").pub != Sim.identity(child, "creator").pub

    {space_with_ref, reference} =
      Sim.command(space, "creator", :create_thread, [child.replica, "Branch"])

    refute Sim.quarantined(space_with_ref, "creator", reference.id)
    active_log = Path.join(root, "existing.log")
    :ok = Log.dump(Sim.log(space, "creator"), active_log)
    child_source = Path.join(root, "child-source.log")
    :ok = Log.dump(Sim.log(child, "creator"), child_source)
    child_bytes = File.read!(child_source)
    identity = Path.join(root, "service.identity")
    File.write!(identity, Base.encode16(:crypto.hash(:sha256, "operator-service"), case: :lower))
    File.chmod!(identity, 0o600)

    instance = %{
      "name" => "space",
      "realm" => "service",
      "identity_file" => identity,
      "log_file" => active_log,
      "listener" => %{"ip" => "127.0.0.1", "port" => 0},
      "trusted_peers" => [
        %{"realm" => "member", "pubkey" => Base.encode64(Sim.identity(space, "creator").pub)}
      ]
    }

    active = Path.join(root, "active.json")
    File.write!(active, Jason.encode!(%{"version" => 1, "instances" => [instance]}))
    File.chmod!(active, 0o600)
    attempt = Base.url_encode64(:crypto.hash(:sha256, "reviewed-attempt"), padding: false)
    child_path = Staging.artifact_path(root, attempt, Journal.digest(child_bytes))

    next_instance = %{
      instance
      | "name" => "thread",
        "log_file" => child_path,
        "realm" => "child-service"
    }

    # Existing Manifest contract requires unique identity files across instances.
    child_identity = Path.join(root, "child-service.identity")

    File.write!(
      child_identity,
      Base.encode16(:crypto.hash(:sha256, "child-service"), case: :lower)
    )

    File.chmod!(child_identity, 0o600)
    next_instance = %{next_instance | "identity_file" => child_identity}

    next_instance =
      Map.update!(next_instance, "trusted_peers", fn peers ->
        peers ++
          [
            %{
              "realm" => "child-root",
              "pubkey" => Base.encode64(Sim.identity(child, "creator").pub)
            }
          ]
      end)

    artifacts = [
      %{
        kind: :log,
        bytes: child_bytes,
        replica: child.replica,
        op_id: genesis.id,
        review: child_review
      },
      %{
        kind: :reference,
        bytes: Jason.encode!(Wire.encode_op(reference)),
        replica: space.replica,
        op_id: reference.id,
        review: nil
      },
      %{
        kind: :manifest,
        bytes: Jason.encode!(%{"version" => 1, "instances" => [instance, next_instance]}),
        replica: nil,
        op_id: nil,
        review: nil
      }
    ]

    request = %{
      active_manifest: active,
      attempt: attempt,
      generation: 1,
      catalog_head: nil,
      manifest_digest: Journal.digest(File.read!(active))
    }

    {:ok,
     root: root,
     request: request,
     artifacts: artifacts,
     active_log: active_log,
     active_bytes: File.read!(active_log),
     child: child,
     space: space,
     updated_log: Sim.log(space_with_ref, "creator"),
     reference: reference}
  end
end
