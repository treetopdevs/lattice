# Prepares a unified local demo relay directory for the Lattice multi-app demo ecosystem:
#   - Treehouse (Space + Thread)
#   - Township (Matter)
#   - Toolshed (Shed + Tool)
#
# All five replicas are served by a single `LatticeCarrierServer` manifest (`manifest.json`),
# booted via `apps/lattice_carrier_server/priv/pilot_node.exs`.
#
# Usage:
#   mix run scripts/demo_ecosystem_prepare.exs [--dir <path>] [--reset] [--base-port <port>]
#
# Security / honesty note:
#   Demo-only local fixture. Plaintext loopback relay, static route config, deterministic
#   demo seeds stored in 0600 files under the output directory. Not a production deployment.

alias Lattice.{Authority, Identity, Log, Op}
alias Lattice.Authority.Delegation
alias Toolshed.{Shed, Tool}
alias Township.Matter
alias Treehouse.{Invitation, Space}

defmodule DemoEcosystemPrepare do
  @default_dir "output/demo_ecosystem"
  @default_base_port 4200

  def run(argv) do
    opts = parse_args(argv)
    dir = Path.expand(opts.dir)
    manifest_path = Path.join(dir, "manifest.json")
    endpoints_path = Path.join(dir, "demo-endpoints.json")

    if opts.reset and File.exists?(dir) do
      File.rm_rf!(dir)
    end

    if File.exists?(manifest_path) and File.exists?(endpoints_path) do
      IO.puts("Demo ecosystem already prepared at #{dir} (pass --reset to regenerate).")
      :ok
    else
      prepare_fresh(dir, opts.base_port)
    end
  end

  defp parse_args(argv) do
    {parsed, _rest, invalid} =
      OptionParser.parse(argv,
        strict: [dir: :string, reset: :boolean, base_port: :integer]
      )

    if invalid != [] do
      Mix.raise("invalid arguments: #{inspect(invalid)}")
    end

    %{
      dir: Keyword.get(parsed, :dir, System.get_env("DEMO_ECOSYSTEM_DIR") || @default_dir),
      reset: Keyword.get(parsed, :reset, false),
      base_port: Keyword.get(parsed, :base_port, @default_base_port)
    }
  end

  defp prepare_fresh(dir, base_port) do
    identities_dir = Path.join(dir, "identities")
    logs_dir = Path.join(dir, "logs")

    File.mkdir_p!(identities_dir)
    File.mkdir_p!(logs_dir)
    File.chmod!(dir, 0o700)
    File.chmod!(identities_dir, 0o700)
    File.chmod!(logs_dir, 0o700)

    # 1. Deterministic demo participant identities (stored in 0600 seed files).
    founder = write_identity(identities_dir, "participant_founder", "demo-founder")
    neighbor = write_identity(identities_dir, "participant_neighbor", "demo-neighbor")
    observer = write_identity(identities_dir, "participant_observer", "demo-observer")

    trusted_peers = [
      %{"realm" => founder.realm_id, "pubkey" => Base.encode64(founder.pub)},
      %{"realm" => neighbor.realm_id, "pubkey" => Base.encode64(neighbor.pub)},
      %{"realm" => observer.realm_id, "pubkey" => Base.encode64(observer.pub)}
    ]

    relay_realms = [founder.realm_id, neighbor.realm_id]

    # 2. Build initial signed logs for all three products.
    {space_log, thread_log} = build_treehouse_logs(founder, neighbor)
    matter_log = build_township_log(founder, neighbor)
    {shed_log, tool_log} = build_toolshed_logs(founder, neighbor)

    specs = [
      %{
        name: "treehouse_space",
        product: "Treehouse.Space",
        realm: "relay-treehouse-space",
        port: base_port + 1,
        log: space_log,
        state_reporter: nil
      },
      %{
        name: "treehouse_thread",
        product: "Treehouse.Thread",
        realm: "relay-treehouse-thread",
        port: base_port + 2,
        log: thread_log,
        state_reporter: nil
      },
      %{
        name: "township_matter",
        product: "Township.Matter",
        realm: "relay-township-matter",
        port: base_port + 3,
        log: matter_log,
        state_reporter: "township"
      },
      %{
        name: "toolshed_shed",
        product: "Toolshed.Shed",
        realm: "relay-toolshed-shed",
        port: base_port + 4,
        log: shed_log,
        state_reporter: nil
      },
      %{
        name: "toolshed_tool",
        product: "Toolshed.Tool",
        realm: "relay-toolshed-tool",
        port: base_port + 5,
        log: tool_log,
        state_reporter: nil
      }
    ]

    instances_with_meta =
      Enum.map(specs, fn spec ->
        carrier_id = write_identity(identities_dir, "carrier_#{spec.name}", spec.realm)
        log_path = Path.join(logs_dir, "#{spec.name}.log")
        :ok = Log.dump(spec.log, log_path)
        File.chmod!(log_path, 0o600)

        manifest_entry =
          %{
            "name" => spec.name,
            "realm" => spec.realm,
            "identity_file" => "identities/carrier_#{spec.name}.seed",
            "log_file" => "logs/#{spec.name}.log",
            "listener" => %{"ip" => "127.0.0.1", "port" => spec.port},
            "trusted_peers" => trusted_peers,
            "relay_realms" => relay_realms
          }
          |> maybe_put_reporter(spec.state_reporter)

        endpoint_entry = %{
          "name" => spec.name,
          "product" => spec.product,
          "replica" => spec.log.replica,
          "ws_url" => "ws://127.0.0.1:#{spec.port}/carrier",
          "peer_realm" => spec.realm,
          "peer_pubkey" => Base.encode64(carrier_id.pub),
          "relay_realms" => relay_realms,
          "initial_ops" => MapSet.size(Log.op_ids(spec.log))
        }

        {manifest_entry, endpoint_entry}
      end)

    manifest = %{
      "version" => 1,
      "health" => %{"ip" => "127.0.0.1", "port" => base_port},
      "instances" => Enum.map(instances_with_meta, &elem(&1, 0))
    }

    manifest_path = Path.join(dir, "manifest.json")
    File.write!(manifest_path, Jason.encode!(manifest, pretty: true) <> "\n")
    File.chmod!(manifest_path, 0o600)

    endpoints = Enum.map(instances_with_meta, &elem(&1, 1))

    treehouse_routes =
      endpoints
      |> Enum.filter(&(&1["product"] in ["Treehouse.Space", "Treehouse.Thread"]))
      |> Enum.map(fn ep ->
        %{
          "replica" => ep["replica"],
          "url" => ep["ws_url"],
          "expectedPeerRealm" => ep["peer_realm"],
          "expectedPeerPubkey" => ep["peer_pubkey"]
        }
      end)

    summary = %{
      "mode" => "assisted_local_demo",
      "notice" =>
        "Local plaintext loopback demo relay with static routes. No catalog replacement trust, no E2EE.",
      "manifest_path" => manifest_path,
      "health" => %{
        "livez" => "http://127.0.0.1:#{base_port}/livez",
        "readyz" => "http://127.0.0.1:#{base_port}/readyz"
      },
      "participants" => %{
        "founder" => %{
          "realm" => founder.realm_id,
          "pubkey" => Base.encode64(founder.pub),
          "seed_file" => Path.join(identities_dir, "participant_founder.seed")
        },
        "neighbor" => %{
          "realm" => neighbor.realm_id,
          "pubkey" => Base.encode64(neighbor.pub),
          "seed_file" => Path.join(identities_dir, "participant_neighbor.seed")
        },
        "observer" => %{
          "realm" => observer.realm_id,
          "pubkey" => Base.encode64(observer.pub),
          "seed_file" => Path.join(identities_dir, "participant_observer.seed")
        }
      },
      "endpoints" => endpoints,
      "treehouse_routes" => treehouse_routes
    }

    endpoints_path = Path.join(dir, "demo-endpoints.json")
    File.write!(endpoints_path, Jason.encode!(summary, pretty: true) <> "\n")
    File.chmod!(endpoints_path, 0o644)

    # Ready-to-paste static route configs for Treehouse EnrollmentPanel (parseRouteList shape)
    for role <- [founder, neighbor] do
      route_config = %{
        "localRealm" => role.realm_id,
        "routes" => treehouse_routes
      }

      path =
        Path.join(dir, "treehouse-routes-#{String.trim_leading(role.realm_id, "demo-")}.json")

      File.write!(path, Jason.encode!(route_config, pretty: true) <> "\n")
      File.chmod!(path, 0o644)
    end

    # Ready-to-import Township Tauri pairing configs (relay submission mode)
    township_ep = Enum.find(endpoints, &(&1["name"] == "township_matter"))

    for role <- [founder, neighbor] do
      pairing = %{
        "url" => township_ep["ws_url"],
        "localRealm" => role.realm_id,
        "expectedPeerRealm" => township_ep["peer_realm"],
        "expectedPeerPubkey" => township_ep["peer_pubkey"],
        "replica" => township_ep["replica"],
        "submission" => "relay"
      }

      handoff = "township-pairing:v1:" <> Base.encode64(Jason.encode!(pairing))
      suffix = String.trim_leading(role.realm_id, "demo-")
      path = Path.join(dir, "township-pairing-#{suffix}.json")

      File.write!(
        path,
        Jason.encode!(Map.put(pairing, "handoff", handoff), pretty: true) <> "\n"
      )

      File.chmod!(path, 0o644)
    end

    IO.puts("Prepared unified demo ecosystem in #{dir}")
    IO.puts("  manifest:  #{manifest_path}")
    IO.puts("  endpoints: #{endpoints_path}")
    :ok
  end

  defp maybe_put_reporter(map, nil), do: map
  defp maybe_put_reporter(map, reporter), do: Map.put(map, "state_reporter", reporter)

  defp write_identity(dir, filename, realm) do
    seed = :crypto.hash(:sha256, "lattice-demo-ecosystem:v1:#{filename}:#{realm}")
    path = Path.join(dir, "#{filename}.seed")
    File.write!(path, Base.encode16(seed, case: :lower) <> "\n")
    File.chmod!(path, 0o600)
    {pub, priv} = :crypto.generate_key(:eddsa, :ed25519, seed)
    %Identity{realm_id: realm, pub: pub, priv: priv}
  end

  defp canonical_nonce(label) do
    :crypto.hash(:sha256, "lattice-demo-ecosystem:nonce:v1:#{label}")
    |> Base.url_encode64(padding: false)
  end

  defp build_treehouse_logs(founder, neighbor) do
    space_nonce = canonical_nonce("treehouse-space")

    {:ok, creation} =
      Space.prepare_bounded_creation(
        founder,
        "replica:treehouse:space:#{space_nonce}",
        "Canopy Demo Space"
      )

    space =
      Enum.reduce(creation.pending, Log.new(creation.replica), fn op, acc ->
        Log.append!(acc, op)
      end)

    [space_genesis | _] = creation.pending
    {:genesis, space_cap, _} = space_genesis.body

    thread_nonce = canonical_nonce("treehouse-thread")

    thread_replica =
      Authority.bind_replica("replica:treehouse:thread:#{thread_nonce}", founder.pub)

    thread_cap =
      Lattice.Authority.Delegation.genesis(founder, thread_replica,
        ops: [:create_thread, :post, :author_edit, :author_tombstone, :archive_thread],
        roles: [:moderator]
      )

    thread_genesis = Op.new(founder, thread_replica, [], :authority, {:genesis, thread_cap, %{}})
    thread = Log.append!(Log.new(thread_replica), thread_genesis)

    create_thread =
      Op.new(
        founder,
        thread_replica,
        Log.frontier(thread),
        :command,
        {:create_thread, ["General"]},
        cap: thread_cap.id
      )

    thread = Log.append!(thread, create_thread)

    member_grant =
      attenuate(founder, thread_cap, neighbor.pub, ops: [:post, :author_edit, :author_tombstone])

    grant_op =
      Op.new(founder, thread_replica, Log.frontier(thread), :authority, {:grant, member_grant})

    thread = Log.append!(thread, grant_op)

    welcome =
      Op.new(
        founder,
        thread_replica,
        Log.frontier(thread),
        :command,
        {:post, ["Welcome to the unified Lattice demo relay!"]},
        cap: thread_cap.id
      )

    thread = Log.append!(thread, welcome)

    ref_op =
      Op.new(
        founder,
        space.replica,
        Log.frontier(space),
        :command,
        {:create_thread, [thread_replica, "General"]},
        cap: space_cap.id
      )

    space = Log.append!(space, ref_op)

    invite_op =
      Op.new(
        founder,
        space.replica,
        Log.frontier(space),
        :command,
        {:issue_invitation, [Base.encode64(neighbor.pub), [thread_replica]]},
        cap: space_cap.id
      )

    space = Log.append!(space, invite_op)
    acceptance = Invitation.accept(neighbor, space.replica, invite_op)

    admit_op =
      Op.new(
        founder,
        space.replica,
        Log.frontier(space),
        :command,
        {:admit_member, [invite_op.id, Base.encode64(neighbor.pub), "neighbor", acceptance]},
        cap: space_cap.id
      )

    space = Log.append!(space, admit_op)

    {space, thread}
  end

  defp build_township_log(founder, neighbor) do
    replica = "replica:township:demo:bridge-repair"

    root_cap =
      Delegation.genesis(founder, replica,
        ops: [
          :set_title,
          :set_summary,
          :post,
          :admit,
          :remove_member,
          :close_matter,
          :reopen_matter
        ],
        roles: [:clerk]
      )

    genesis = Op.new(founder, replica, [], :authority, {:genesis, root_cap, %{}})
    log = Log.append!(Log.new(replica), genesis)

    resident_grant =
      attenuate(founder, root_cap, neighbor.pub, ops: [:post])

    log =
      log
      |> append_op(
        founder,
        :command,
        {:set_title, ["Maple Creek Footbridge Repair"]},
        root_cap.id
      )
      |> append_op(
        founder,
        :command,
        {:set_summary, ["Community deliberation on timber vs. steel deck options."]},
        root_cap.id
      )
      |> append_op(founder, :command, {:admit, [founder.realm_id]}, root_cap.id)
      |> append_op(founder, :command, {:admit, [neighbor.realm_id]}, root_cap.id)
      |> then(fn l ->
        Log.append!(
          l,
          Op.new(founder, replica, Log.frontier(l), :authority, {:grant, resident_grant})
        )
      end)
      |> append_op(
        founder,
        :command,
        {:post, ["Opening the matter for neighborhood review."]},
        root_cap.id
      )
      |> append_op(
        neighbor,
        :command,
        {:post, ["Timber deck keeps maintenance local and within budget."]},
        resident_grant.id
      )

    _ = Lattice.state(Matter, log)
    log
  end

  defp build_toolshed_logs(founder, neighbor) do
    shed_replica = "replica:shed:maple-block-demo"
    tool_replica = "replica:tool:tile-saw-demo"

    shed_cap =
      Delegation.genesis(founder, shed_replica,
        ops: [:set_name, :vouch_in, :drop_neighbor, :list_tool, :delist_tool, :post_bulletin],
        roles: [:steward]
      )

    shed_invite =
      attenuate(founder, shed_cap, neighbor.pub,
        ops: [:vouch_in, :list_tool],
        expires_epoch: 10
      )

    shed =
      Log.new(shed_replica)
      |> Log.append!(Op.new(founder, shed_replica, [], :authority, {:genesis, shed_cap, %{}}))
      |> append_op(founder, :command, {:set_name, ["Maple Block Demo Toolshed"]}, shed_cap.id)
      |> append_op(founder, :command, {:vouch_in, [founder.realm_id]}, shed_cap.id)
      |> then(fn l ->
        Log.append!(
          l,
          Op.new(founder, shed_replica, Log.frontier(l), :authority, {:grant, shed_invite})
        )
      end)
      |> append_op(neighbor, :command, {:vouch_in, [neighbor.realm_id]}, shed_invite.id)
      |> append_op(founder, :command, {:list_tool, [tool_replica]}, shed_cap.id)

    tool_cap =
      Lattice.Authority.Delegation.genesis(founder, tool_replica,
        ops: [:describe, :note_condition, :custody_transfer],
        roles: [:custody]
      )

    tool_grant =
      attenuate(founder, tool_cap, neighbor.pub, ops: [:describe, :note_condition])

    tool =
      Log.new(tool_replica)
      |> Log.append!(Op.new(founder, tool_replica, [], :authority, {:genesis, tool_cap, %{}}))
      |> then(fn l ->
        Log.append!(
          l,
          Op.new(founder, tool_replica, Log.frontier(l), :authority, {:grant, tool_grant})
        )
      end)
      |> append_op(founder, :command, {:describe, ["Tile saw, 7in wet blade"]}, tool_cap.id)
      |> append_op(
        founder,
        :command,
        {:note_condition, ["New blade fitted; ready to lend."]},
        tool_cap.id
      )

    _ = Lattice.state(Shed, shed)
    _ = Lattice.state(Tool, tool)
    {shed, tool}
  end

  defp attenuate(issuer, %Delegation{} = parent, audience_pub, opts) do
    Delegation.new(issuer, parent.replica, audience_pub, Keyword.put(opts, :parent_id, parent.id))
  end

  defp append_op(log, identity, kind, body, cap_id) do
    op = Op.new(identity, log.replica, Log.frontier(log), kind, body, cap: cap_id)
    Log.append!(log, op)
  end
end

DemoEcosystemPrepare.run(System.argv())
