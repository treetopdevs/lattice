defmodule LatticeCarrierServer.Operator.Fixture do
  @moduledoc false
  import ExUnit.Assertions
  import ExUnit.Callbacks
  alias Lattice.Authority.Delegation
  alias Lattice.Carrier.Wire
  alias Lattice.{Identity, Log, Sim}
  alias LatticeCarrierServer.Operator.CeremonyFixture
  alias LatticeCarrierServer.Operator.{Journal, Staging}
  alias Treehouse.TransportCatalog

  def new(opts \\ []) do
    root = Path.expand(".operator-stage-#{System.unique_integer([:positive])}", File.cwd!())
    File.mkdir!(root)
    File.chmod!(root, 0o700)
    on_exit(fn -> File.rm_rf!(root) end)

    # By default the Space root admits itself as the only member. A test can add
    # a non-root member (`second_member: true`) and leave the root off the
    # roster (`root_member: false`) to tell the root apart from the roster.
    # Each member is {Space realm, child grant realm, bootstrap peer realm}.
    root_member = [{"creator", "space-member", "member"}]
    second_member = [{"member2", "space-member2", "member2"}]

    members =
      if(Keyword.get(opts, :root_member, true), do: root_member, else: []) ++
        if Keyword.get(opts, :second_member, false), do: second_member, else: []

    space_realms =
      Enum.uniq(["creator" | Enum.map(members, &elem(&1, 0))]) ++ ["nominee", "w1", "w2", "w3"]

    # A bounded Space: the continuation pin is authored before anything else, so
    # a catalog bootstrap can bind the carrier service key to it.
    space_name =
      "replica:treehouse:space:" <>
        Treehouse.ContinuationFixtures.digest("operator-space") <>
        "#authority:bounded-continuation-v1"

    {space, _} =
      Sim.new(Treehouse.Space, space_name, space_realms, seed: "operator-space")
      |> Sim.create_replica("creator")

    {space, _} = Sim.command(space, "creator", :create_space, ["Canopy"])

    space_profile = %{
      Treehouse.ContinuationFixtures.profile(space)
      | kind: :space,
        role: :admin
    }

    {space, _space_pin, _} =
      Treehouse.ContinuationFixtures.pin(space, author: "creator", profile: space_profile)

    # The ceremony works over the Space as of its pin; its root then signs the
    # reviewed bootstrap, which binds the one carrier service key.
    work =
      Path.join(System.tmp_dir!(), "operator-ceremony-#{System.unique_integer([:positive])}")

    File.mkdir_p!(work)
    File.chmod!(work, 0o700)
    on_exit(fn -> File.rm_rf!(work) end)
    pre_log = Path.join(work, "space-pre.log")
    :ok = Log.dump(Sim.log(space, "creator"), pre_log)
    ceremony_dir = CeremonyFixture.copy_ceremony(Path.join(work, "ceremony"))

    # One service identity file serves every Treehouse instance (OD-1). Its seed
    # derivation is shared with the `:reuse_carrier_service_key` override below.
    identity = Path.join(root, "service.identity")
    File.write!(identity, Base.encode16(:crypto.hash(:sha256, "child-service"), case: :lower))
    File.chmod!(identity, 0o600)
    service_pub = Identity.from_seed("creator", "child-service").pub

    bound =
      CeremonyFixture.bind(ceremony_dir, pre_log, service_pub, fn record ->
        {bootstrapped, op} = Sim.command(space, "creator", :catalog_bootstrap_v1, [record])
        refute Sim.quarantined(bootstrapped, "creator", op.id)
        signed = Path.join(work, "space-signed.log")
        :ok = Log.dump(Sim.log(bootstrapped, "creator"), signed)
        {signed, bootstrapped}
      end)

    space = bound.extra
    binding_realm = TransportCatalog.service_realm(bound.record.service_id)
    space = Enum.reduce(members, space, fn {realm, _, _}, acc -> admit_member(acc, realm) end)

    # Every Space member receives a reviewed child grant under its own realm.
    grantees =
      Enum.map(members, fn {realm, grant_realm, _} ->
        {grant_realm, Sim.identity(space, realm)}
      end)

    {child, genesis} =
      Sim.new(
        Treehouse.Thread,
        "replica:treehouse:thread:" <>
          Treehouse.ContinuationFixtures.digest("operator") <>
          "#authority:bounded-continuation-v1",
        ["creator", "nominee", "w1", "w2", "w3"] ++ Enum.map(grantees, &elem(&1, 0)),
        seed: "independent-child"
      )
      |> reuse_child_creator(Keyword.get(opts, :child_creator), space)
      |> Sim.create_replica("creator", policies: Keyword.get(opts, :root_policies, %{}))

    child = %{child | realms: Map.merge(child.realms, Map.new(grantees))}

    {child, creation} = Sim.command(child, "creator", :create_thread, ["Branch"])
    {child, pin, _} = pin_child(child, Keyword.get(opts, :pin_beacon))

    {child, grants} =
      Enum.reduce(grantees, {child, []}, fn {realm, identity}, {sim, acc} ->
        {sim, grant} =
          Sim.grant(sim, "creator", realm,
            ops: [:post, :author_edit, :author_tombstone],
            expires_epoch: 7
          )

        {sim, acc ++ [{grant, identity}]}
      end)

    child_log = Sim.log(child, "creator")
    {:ok, selected} = Lattice.Authority.continuation_profile(child_log)

    child_review = %{
      "creation" => creation.id,
      "profile_genesis" => pin.id,
      "profile_id" => selected.profile_id,
      "grants" =>
        Enum.map(grants, fn {grant, identity} ->
          intro =
            Enum.find(Log.ops(child_log), fn {_id, op} -> op.body == {:grant, grant} end)
            |> elem(0)

          %{
            "recipient" => Base.encode64(identity.pub),
            "delegation" => grant.id,
            "introduction" => intro
          }
        end)
    }

    # Honest staging never reuses another authority's key for the child root;
    # a `:child_creator` override intentionally breaks that for a test.
    if Keyword.get(opts, :child_creator) == nil do
      assert Sim.identity(space, "creator").pub != Sim.identity(child, "creator").pub
    end

    {space_with_ref, reference} =
      Sim.command(space, "creator", :create_thread, [child.replica, "Branch"])

    refute Sim.quarantined(space_with_ref, "creator", reference.id)
    active_log = Path.join(root, "existing.log")
    :ok = Log.dump(Sim.log(space, "creator"), active_log)
    child_source = Path.join(root, "child-source.log")
    :ok = Log.dump(Sim.log(child, "creator"), child_source)
    child_bytes = File.read!(child_source)
    space_route = "/r/" <> CeremonyFixture.id("operator-space-route")
    child_route = "/r/" <> CeremonyFixture.id("operator-child-route")

    # Trusted peers are the instance's own authority root plus the Space roster,
    # named by roster realm; a root that is also a member is listed once.
    roster_peers =
      Enum.map(members, fn {realm, _, peer_realm} ->
        {peer_realm, Sim.identity(space, realm).pub}
      end)

    peers = fn root_realm, root_pub ->
      if Enum.any?(roster_peers, fn {_, pub} -> pub == root_pub end),
        do: roster_peers,
        else: roster_peers ++ [{root_realm, root_pub}]
    end

    peer_json = fn peers ->
      Enum.map(peers, fn {realm, pub} -> %{"realm" => realm, "pubkey" => Base.encode64(pub)} end)
    end

    space_peers = peers.("space-root", Sim.identity(space, "creator").pub)
    child_peers = peers.("child-root", Sim.identity(child, "creator").pub)

    instance = %{
      "name" => "space",
      "realm" => binding_realm,
      "identity_file" => identity,
      "log_file" => active_log,
      "listener" => %{"ip" => "127.0.0.1", "port" => 0},
      "route" => space_route,
      "trusted_peers" => peer_json.(space_peers),
      "relay_realms" => Enum.map(space_peers, &elem(&1, 0))
    }

    active = Path.join(root, "active.json")
    File.write!(active, Jason.encode!(%{"version" => 1, "instances" => [instance]}))
    File.chmod!(active, 0o600)
    attempt = Base.url_encode64(:crypto.hash(:sha256, "reviewed-attempt"), padding: false)
    child_path = Staging.artifact_path(root, attempt, Journal.digest(child_bytes))

    # The admitted child shares the Space's service identity file and realm,
    # serves its own route, trusts the Space roster plus the independently
    # rooted child, and relays for exactly those peers.
    next_instance = %{
      instance
      | "name" => "thread",
        "log_file" => child_path,
        "route" => child_route,
        "trusted_peers" => peer_json.(child_peers),
        "relay_realms" => Enum.map(child_peers, &elem(&1, 0))
    }

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
     reference: reference,
     ceremony_dir: ceremony_dir,
     binding: bound,
     binding_realm: binding_realm,
     service_pub: service_pub,
     service_identity: identity,
     space_route: space_route,
     child_route: child_route}
  end

  # The Space root invites and admits `realm`, which signs its own acceptance.
  defp admit_member(space, realm) do
    member = Base.encode64(Sim.identity(space, realm).pub)
    {space, invitation} = Sim.command(space, "creator", :issue_invitation, [member, []])

    acceptance =
      Treehouse.Invitation.accept(Sim.identity(space, realm), space.replica, invitation)

    {space, admission} =
      Sim.command(space, "creator", :admit_member, [invitation.id, member, "member", acceptance])

    refute Sim.quarantined(space, "creator", admission.id)
    space
  end

  # Honest staging derives the child's root from its own independent seed.
  # `:reuse_space_root` and `:reuse_carrier_service_key` let a test author the
  # exact same genesis with the child bootstrap moderator authority collapsed
  # onto the active Space root or the admitted carrier instance's own
  # transport identity instead, to prove `Staging` refuses either reuse.
  defp reuse_child_creator(sim, nil, _space), do: sim

  defp reuse_child_creator(sim, :reuse_space_root, space) do
    %{sim | realms: Map.put(sim.realms, "creator", Sim.identity(space, "creator"))}
  end

  defp reuse_child_creator(sim, :reuse_carrier_service_key, _space) do
    # Matches the exact derivation `Manifest.load/1` applies to the
    # "child-service" identity file below: sha256(seed) as the raw Ed25519 seed.
    identity = Identity.from_seed("creator", "child-service")
    %{sim | realms: Map.put(sim.realms, "creator", identity)}
  end

  # The honest pin is the shared continuation fixture. `pin_beacon` authors the
  # same reviewed profile with a caller-chosen epoch-beacon policy instead, so a
  # test can stage a child whose reviewed profile digest is unchanged while its
  # genesis names different beacon witnesses.
  defp pin_child(sim, nil), do: Treehouse.ContinuationFixtures.pin(sim, author: "creator")

  defp pin_child(sim, :reordered_witnesses) do
    profile = Treehouse.ContinuationFixtures.profile(sim)

    pin_child(sim, %{
      mode: :witnessed,
      version: 1,
      witnesses: Enum.reverse(profile.witnesses),
      threshold: profile.threshold,
      max_epoch_step: 1
    })
  end

  defp pin_child(sim, {:max_epoch_step, step}) do
    profile = Treehouse.ContinuationFixtures.profile(sim)

    pin_child(sim, %{
      mode: :witnessed,
      version: 1,
      witnesses: profile.witnesses,
      threshold: profile.threshold,
      max_epoch_step: step
    })
  end

  defp pin_child(sim, beacon) do
    profile = Treehouse.ContinuationFixtures.profile(sim)
    root = Sim.identity(sim, "creator")
    deleg = Delegation.genesis(root, sim.replica, ops: [], roles: [], live: false)

    {sim, op} =
      Sim.append(
        sim,
        root.realm_id,
        :authority,
        {:genesis, deleg, %{__continuation__: profile, __beacon__: beacon}}
      )

    {Sim.sync_all(sim), op, profile}
  end
end
