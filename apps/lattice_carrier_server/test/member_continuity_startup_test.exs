defmodule LatticeCarrierServer.MemberContinuityStartupTest do
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Wire
  alias Lattice.{Identity, Log, Op}
  alias Treehouse.MemberContinuityVectors, as: Vectors

  @moduletag :tmp_dir

  test "fresh path-backed startup, first relay and process reopen retain a continuity command outside the preview grant",
       %{tmp_dir: dir} do
    fixture = fixture(dir)
    assert run!(fixture, "relay") =~ "CONTINUITY_FIRST_RELAY_DURABLE_OK"
    after_relay = File.read!(fixture.log)
    assert run!(fixture, "reopen") =~ "CONTINUITY_FRESH_REOPEN_OK"
    assert File.read!(fixture.log) == after_relay
  end

  test "fresh manifest startup authenticates retained ops before reporting readiness", %{
    tmp_dir: dir
  } do
    fixture = fixture(dir)
    forged = %{fixture.source.op | sig: <<0::512>>}
    invalid = %{fixture.source.log | ops: Map.put(fixture.source.log.ops, forged.id, forged)}
    assert :ok = Log.dump(invalid, fixture.log)
    before = File.read!(fixture.log)
    assert run!(fixture, "corrupt") =~ "CONTINUITY_CORRUPT_STARTUP_REFUSED"
    assert File.read!(fixture.log) == before
  end

  defp fixture(dir) do
    f = Vectors.fixture()
    source = Vectors.unknown_command(f)

    relay =
      Op.new(f.root, source.op.replica, [source.op.id], :command, source.op.body,
        cap: source.op.cap
      )

    log = Path.join(dir, "space.dump")
    assert :ok = Log.dump(source.log, log)
    frame = Path.join(dir, "first-relay.json")
    File.write!(frame, Jason.encode!(Wire.encode_op(relay)))
    expected = Path.join(dir, "expected.json")
    File.write!(expected, Jason.encode!(Wire.encode_ops([source.genesis, source.op, relay])))
    transport = Identity.from_seed("continuity-member", "r19b-startup-transport-only")
    seed = :crypto.hash(:sha256, "r19b-startup-service-only")
    {pub, _private} = :crypto.generate_key(:eddsa, :ed25519, seed)
    secret = Path.join(dir, "service.identity")
    File.write!(secret, Base.encode16(seed, case: :lower))
    File.chmod!(secret, 0o600)
    manifest = Path.join(dir, "manifest.json")

    File.write!(
      manifest,
      Jason.encode!(%{
        "version" => 1,
        "health" => %{"ip" => "127.0.0.1", "port" => 0},
        "instances" => [
          %{
            "name" => "continuity",
            "realm" => "continuity-service",
            "identity_file" => secret,
            "log_file" => log,
            "listener" => %{"ip" => "127.0.0.1", "port" => 0},
            "trusted_peers" => [
              %{"realm" => transport.realm_id, "pubkey" => Base.encode64(transport.pub)}
            ],
            "relay_realms" => [transport.realm_id]
          }
        ]
      })
    )

    %{
      manifest: manifest,
      log: log,
      frame: frame,
      expected: expected,
      source: source,
      pub: Base.encode64(pub)
    }
  end

  defp run!(fixture, mode) do
    script = """
    [mode, manifest, log_path, frame_path, expected_path, service_pub] = System.argv()
    false = :code.is_loaded(Treehouse.Space)
    false = :code.is_loaded(Treehouse.MemberContinuityCertificate)
    false = :code.is_loaded(Treehouse.CatalogCutoff)
    false = :code.is_loaded(Treehouse.CatalogTrust)
    Application.put_env(:lattice_carrier_server, :manifest, manifest)
    Application.put_env(:lattice_carrier_server, :allow_ephemeral_manifest_ports, true)
    # Match the existing dev/test pilot profile, not Linux production durability proof.
    if :os.type() == {:unix, :darwin}, do: Application.put_env(:lattice_carrier_server, :allow_approximate_darwin_sync, true)
    false = LatticeCarrierServer.Health.ready?()
    case mode do
      "corrupt" ->
        {:error, _} = Application.ensure_all_started(:lattice_carrier_server)
        false = LatticeCarrierServer.Health.ready?()
        IO.puts("CONTINUITY_CORRUPT_STARTUP_REFUSED")
      _ ->
        {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
        true = LatticeCarrierServer.Health.ready?()
        {:ok, %{log: before}} = Lattice.Log.restore_verified(log_path)
        :ok = Lattice.Log.verify_authenticity(before)
        # First incoming op decode happens only after the actual path-backed runtime preload.
        frame = frame_path |> File.read!() |> Jason.decode!()
        {:ok, relay} = Lattice.Carrier.Wire.decode_op(frame)
        true = Lattice.Op.valid?(relay)
        transport = Lattice.Identity.from_seed("continuity-member", "r19b-startup-transport-only")
        {:ok, connection} = Lattice.Carrier.WebSocket.connect(hostname: "127.0.0.1", port: LatticeCarrierServer.port("continuity"),
          identity: transport, realm: transport.realm_id, peer_realm: "continuity-service", peer_pubkey: Base.decode64!(service_pub), replica: relay.replica)
        if mode == "relay" do
          false = Lattice.Log.has?(before, relay.id)
          {:ok, %{accepted: [id]}, connection} = Lattice.Carrier.WebSocket.relay(connection, relay)
          true = id == relay.id
          :ok = Lattice.Carrier.WebSocket.close(connection)
        else
          true = Lattice.Log.has?(before, relay.id)
          {:ok, pulled, connection} = Lattice.Carrier.WebSocket.pull(connection, MapSet.new())
          true = Enum.sort_by(pulled, & &1.id) == Enum.sort_by(Map.values(before.ops), & &1.id)
          :ok = Lattice.Carrier.WebSocket.close(connection)
        end
        {:ok, %{log: retained}} = Lattice.Log.restore_verified(log_path)
        {:ok, expected} = expected_path |> File.read!() |> Jason.decode!() |> Lattice.Carrier.Wire.decode_ops()
        true = Enum.sort_by(expected, & &1.id) == Enum.sort_by(Map.values(retained.ops), & &1.id)
        :operation_not_granted = Map.fetch!(Lattice.Authority.analyze(Treehouse.Space, retained).reasons, relay.id)
        genesis = Enum.find(expected, &(&1.kind == :authority))
        baseline = Lattice.Log.new(relay.replica) |> Lattice.Log.append!(genesis)
        true = Lattice.state(Treehouse.Space, retained) == Lattice.state(Treehouse.Space, baseline)
        true = LatticeCarrierServer.Health.ready?()
        :ok = Application.stop(:lattice_carrier_server)
        IO.puts(if mode == "relay", do: "CONTINUITY_FIRST_RELAY_DURABLE_OK", else: "CONTINUITY_FRESH_REOPEN_OK")
    end
    """

    paths =
      Application.app_dir(:lattice_core)
      |> Path.dirname()
      |> Path.join("*/ebin")
      |> Path.wildcard()

    args =
      Enum.flat_map(paths, &["-pa", &1]) ++
        [
          "-e",
          script,
          mode,
          fixture.manifest,
          fixture.log,
          fixture.frame,
          fixture.expected,
          fixture.pub
        ]

    {output, status} =
      System.cmd(System.find_executable("elixir"), args,
        env: [{"ERL_FLAGS", "+S 4:4"}],
        stderr_to_stdout: true
      )

    assert status == 0, output
    output
  end
end
