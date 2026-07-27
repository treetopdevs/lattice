defmodule LatticeCarrierServer.ManifestTest do
  @moduledoc """
  Fail-closed manifest loading matrix (plan 158): invalid or missing
  secrets, corrupt or missing manifest and log, inline-secret refusal, and
  secret-free error details.
  """

  use ExUnit.Case, async: true

  alias Lattice.Identity
  alias LatticeCarrierServer.{Manifest, Secret}

  @replica "replica:carrier-manifest:test"

  setup %{tmp_dir: tmp_dir} do
    seed = :crypto.hash(:sha256, "carrier-manifest-#{Path.basename(tmp_dir)}")
    seed_hex = Base.encode16(seed, case: :lower)
    identity_path = Path.join(tmp_dir, "town-node.identity")
    File.write!(identity_path, seed_hex)
    File.chmod!(identity_path, 0o600)

    log_path = Path.join(tmp_dir, "matter.log")
    assert :ok = @replica |> Lattice.Log.new() |> Lattice.Log.dump(log_path)

    observer = Identity.from_seed("instrument", "carrier-manifest-observer")

    instance = %{
      "name" => "township-pilot",
      "realm" => "town-node",
      "identity_file" => identity_path,
      "log_file" => log_path,
      "listener" => %{"ip" => "127.0.0.1", "port" => 0},
      "trusted_peers" => [
        %{"realm" => observer.realm_id, "pubkey" => Base.encode64(observer.pub)}
      ]
    }

    {:ok,
     tmp_dir: tmp_dir,
     seed: seed,
     seed_hex: seed_hex,
     identity_path: identity_path,
     log_path: log_path,
     observer: observer,
     instance: instance}
  end

  defp write_manifest(tmp_dir, manifest) do
    path = Path.join(tmp_dir, "manifest-#{System.unique_integer([:positive])}.json")
    File.write!(path, Jason.encode!(manifest))
    path
  end

  defp manifest_with(tmp_dir, instance) do
    write_manifest(tmp_dir, %{"version" => 1, "instances" => [instance]})
  end

  @tag :tmp_dir
  test "a valid manifest loads a redacted secret identity from the file", %{
    tmp_dir: tmp_dir,
    seed: seed,
    instance: instance,
    observer: observer,
    log_path: log_path
  } do
    path =
      write_manifest(tmp_dir, %{
        "version" => 1,
        "health" => %{"ip" => "127.0.0.1", "port" => 4090},
        "instances" => [Map.put(instance, "state_reporter", "township")]
      })

    assert {:ok, %Manifest{} = manifest} = Manifest.load(path)
    assert manifest.health == [ip: {127, 0, 0, 1}, port: 4090]
    assert [parsed] = manifest.instances
    assert parsed.name == "township-pilot"
    assert parsed.realm == "town-node"
    assert parsed.log_file == log_path
    assert parsed.listener == [ip: {127, 0, 0, 1}, port: 0]
    assert parsed.trusted_peers == %{observer.realm_id => observer.pub}
    assert parsed.relay_realms == []
    assert parsed.state_reporter == Township.CarrierStateReport

    {expected_pub, expected_priv} = :crypto.generate_key(:eddsa, :ed25519, seed)
    assert parsed.pub == expected_pub

    assert %Identity{realm_id: "town-node", pub: ^expected_pub, priv: ^expected_priv} =
             Secret.unwrap(parsed.identity)

    # The loaded instance never renders secret bytes.
    rendered = inspect(parsed, limit: :infinity)
    refute rendered =~ Base.encode64(expected_priv)
    assert rendered =~ "Secret<redacted>"
  end

  @tag :tmp_dir
  test "missing or corrupt manifests refuse", %{tmp_dir: tmp_dir, instance: instance} do
    assert {:error, {:invalid_manifest, {:manifest_unreadable, _path, :enoent}}} =
             Manifest.load(Path.join(tmp_dir, "absent.json"))

    corrupt = Path.join(tmp_dir, "corrupt.json")
    File.write!(corrupt, "{not json")
    assert {:error, {:invalid_manifest, :manifest_corrupt}} = Manifest.load(corrupt)

    versioned = write_manifest(tmp_dir, %{"version" => 2, "instances" => [instance]})
    assert {:error, {:invalid_manifest, :unsupported_version}} = Manifest.load(versioned)

    smuggled_version = "copied-secret-version"

    secret_versioned =
      write_manifest(tmp_dir, %{"version" => smuggled_version, "instances" => [instance]})

    assert {:error, {:invalid_manifest, :unsupported_version} = refusal} =
             Manifest.load(secret_versioned)

    refute inspect(refusal) =~ smuggled_version

    empty = write_manifest(tmp_dir, %{"version" => 1, "instances" => []})
    assert {:error, {:invalid_manifest, :manifest_corrupt}} = Manifest.load(empty)
  end

  @tag :tmp_dir
  test "inline secret material is rejected without echoing it", %{
    tmp_dir: tmp_dir,
    instance: instance
  } do
    for key <- ["seed", "identity_seed", "identity", "priv", "private_key", "secret"] do
      smuggled = Map.put(instance, key, "super-secret-value")
      path = manifest_with(tmp_dir, smuggled)

      assert {:error, {:invalid_manifest, detail}} = Manifest.load(path)
      assert detail == {:inline_secret_rejected, {:instance, 1}, key}
      refute inspect(detail) =~ "super-secret-value"
    end
  end

  @tag :tmp_dir
  test "an invalid instance name is rejected without echoing its contents", %{
    tmp_dir: tmp_dir,
    instance: instance
  } do
    smuggled = %{"copied_private_key" => "super-secret-value"}
    path = manifest_with(tmp_dir, Map.put(instance, "name", smuggled))

    assert {:error, {:invalid_manifest, :invalid_instance_name} = refusal} =
             Manifest.load(path)

    refute inspect(refusal) =~ "super-secret-value"
  end

  @tag :tmp_dir
  test "later refusal details identify an instance symbolically, not by its supplied name", %{
    tmp_dir: tmp_dir,
    instance: instance
  } do
    smuggled_name = String.duplicate("a", 64)
    missing_log = Path.join(tmp_dir, "missing.log")

    supplied =
      instance
      |> Map.put("name", smuggled_name)
      |> Map.put("log_file", missing_log)

    path = manifest_with(tmp_dir, supplied)

    assert {:error, {:invalid_manifest, {:log_missing, {:instance, 1}, ^missing_log}} = refusal} =
             Manifest.load(path)

    refute inspect(refusal) =~ smuggled_name
  end

  @tag :tmp_dir
  test "identity files that are missing, open, or corrupt refuse", %{
    tmp_dir: tmp_dir,
    instance: instance,
    identity_path: identity_path,
    seed_hex: seed_hex
  } do
    path = manifest_with(tmp_dir, instance)

    # Group/other-readable secret file refuses.
    File.chmod!(identity_path, 0o644)

    assert {:error, {:invalid_manifest, {:identity_file_permissions, ^identity_path}}} =
             Manifest.load(path)

    # Corrupt contents refuse without echoing them.
    File.chmod!(identity_path, 0o600)
    File.write!(identity_path, "zz" <> seed_hex)

    assert {:error, {:invalid_manifest, {:identity_file_corrupt, ^identity_path} = detail}} =
             Manifest.load(path)

    refute inspect(detail) =~ seed_hex

    # Missing file refuses; nothing is minted in its place.
    File.rm!(identity_path)

    assert {:error, {:invalid_manifest, {:identity_file_missing, ^identity_path}}} =
             Manifest.load(path)

    refute File.exists?(identity_path)
  end

  @tag :tmp_dir
  test "a missing log refuses rather than implying a fresh community", %{
    tmp_dir: tmp_dir,
    instance: instance,
    log_path: log_path
  } do
    File.rm!(log_path)
    path = manifest_with(tmp_dir, instance)

    assert {:error, {:invalid_manifest, {:log_missing, {:instance, 1}, ^log_path}}} =
             Manifest.load(path)

    refute File.exists?(log_path)
  end

  @tag :tmp_dir
  test "listeners must be loopback and structurally valid", %{
    tmp_dir: tmp_dir,
    instance: instance
  } do
    public = %{instance | "listener" => %{"ip" => "0.0.0.0", "port" => 0}}

    assert {:error, {:invalid_manifest, {:listener_not_loopback, {:instance, 1}}}} =
             tmp_dir |> manifest_with(public) |> Manifest.load()

    malformed = %{instance | "listener" => %{"ip" => "127.0.0.1"}}

    assert {:error, {:invalid_manifest, {:invalid_listener, {:instance, 1}}}} =
             tmp_dir |> manifest_with(malformed) |> Manifest.load()

    ipv6 = %{instance | "listener" => %{"ip" => "::1", "port" => 0}}

    assert {:ok, %Manifest{instances: [%{listener: listener}]}} =
             tmp_dir |> manifest_with(ipv6) |> Manifest.load()

    assert listener == [ip: {0, 0, 0, 0, 0, 0, 0, 1}, port: 0]
  end

  @tag :tmp_dir
  test "trusted peers, relay realms, and state reporters validate", %{
    tmp_dir: tmp_dir,
    instance: instance
  } do
    copied_secret_realm = "copied-secret-trusted-peer-realm"

    bad_peer = %{
      instance
      | "trusted_peers" => [
          %{"realm" => copied_secret_realm, "pubkey" => "definitely-not-a-key"}
        ]
    }

    assert {:error, {:invalid_manifest, {:invalid_trusted_peer, {:instance, 1}}} = refusal} =
             tmp_dir |> manifest_with(bad_peer) |> Manifest.load()

    refute inspect(refusal) =~ copied_secret_realm

    untrusted_relay = Map.put(instance, "relay_realms", ["stranger"])

    assert {:error, {:invalid_manifest, {:invalid_relay_realms, {:instance, 1}}}} =
             tmp_dir |> manifest_with(untrusted_relay) |> Manifest.load()

    smuggled_name = "copied-secret-instance-name"

    unknown_reporter =
      instance
      |> Map.put("name", smuggled_name)
      |> Map.put("state_reporter", "Elixir.System")

    # The refusal reason is symbolic only: it must never embed the raw
    # supplied value, because pilot_node.exs inspects the whole refusal
    # reason to stderr and an operator could accidentally paste a copied
    # seed/secret into this field.
    assert {:error, {:invalid_manifest, :unknown_state_reporter} = detail} =
             tmp_dir |> manifest_with(unknown_reporter) |> Manifest.load()

    refute inspect(detail) =~ "Elixir.System"
    refute inspect(detail) =~ smuggled_name

    non_string_reporter = Map.put(instance, "state_reporter", %{"nested" => "value"})

    assert {:error, {:invalid_manifest, :unknown_state_reporter}} =
             tmp_dir |> manifest_with(non_string_reporter) |> Manifest.load()
  end

  @tag :tmp_dir
  test "duplicate instance names and fixed ports refuse", %{
    tmp_dir: tmp_dir,
    instance: instance
  } do
    duplicate_names =
      write_manifest(tmp_dir, %{"version" => 1, "instances" => [instance, instance]})

    assert {:error, {:invalid_manifest, :duplicate_instance_names}} =
             Manifest.load(duplicate_names)

    fixed = %{instance | "listener" => %{"ip" => "127.0.0.1", "port" => 4141}}
    second = %{fixed | "name" => "township-pilot-2"}

    duplicate_ports = write_manifest(tmp_dir, %{"version" => 1, "instances" => [fixed, second]})

    assert {:error, {:invalid_manifest, :duplicate_listener_ports}} =
             Manifest.load(duplicate_ports)
  end

  @tag :tmp_dir
  test "two instances sharing one log_file refuse even with distinct names and ports", %{
    tmp_dir: tmp_dir,
    instance: instance,
    observer: observer
  } do
    # Different name, different port, same durable log path: each Holder
    # would independently restore from and atomic_dump to that shared file,
    # so an acknowledged relay accepted by one instance can be silently
    # overwritten and lost by the other instance's next dump — the plan 158
    # stop condition "an acknowledged operation is lost across ordinary
    # carrier/host restart."
    second_identity_path = Path.join(tmp_dir, "second.identity")

    File.write!(
      second_identity_path,
      Base.encode16(:crypto.hash(:sha256, "second"), case: :lower)
    )

    File.chmod!(second_identity_path, 0o600)

    second = %{
      "name" => "township-pilot-2",
      "realm" => "town-node-2",
      "identity_file" => second_identity_path,
      "log_file" => instance["log_file"],
      "listener" => %{"ip" => "127.0.0.1", "port" => 0},
      "trusted_peers" => [
        %{"realm" => observer.realm_id, "pubkey" => Base.encode64(observer.pub)}
      ]
    }

    duplicate_log_file =
      write_manifest(tmp_dir, %{"version" => 1, "instances" => [instance, second]})

    assert {:error, {:invalid_manifest, :duplicate_log_file}} =
             Manifest.load(duplicate_log_file)
  end

  @tag :tmp_dir
  test "symlink and hard-link aliases of one durable log refuse", %{
    tmp_dir: tmp_dir,
    instance: instance
  } do
    for {kind, create_alias} <- [
          {:symlink, &File.ln_s!/2},
          {:hard_link, &File.ln!/2}
        ] do
      alias_path = Path.join(tmp_dir, "#{kind}.log")
      create_alias.(instance["log_file"], alias_path)

      second =
        instance
        |> Map.put("name", "township-pilot-#{kind}")
        |> Map.put("log_file", alias_path)

      path = write_manifest(tmp_dir, %{"version" => 1, "instances" => [instance, second]})

      assert {:error, {:invalid_manifest, :duplicate_log_file}} = Manifest.load(path)
    end
  end

  @tag :tmp_dir
  test "a log path inside another log's temporary-file namespace refuses", %{
    tmp_dir: tmp_dir,
    instance: instance
  } do
    colliding_path = instance["log_file"] <> ".tmp.1"
    File.cp!(instance["log_file"], colliding_path)

    second =
      instance
      |> Map.put("name", "township-pilot-temp-collision")
      |> Map.put("log_file", colliding_path)

    path = write_manifest(tmp_dir, %{"version" => 1, "instances" => [instance, second]})

    assert {:error, {:invalid_manifest, :log_temp_namespace_collision}} =
             Manifest.load(path)
  end

  @tag :tmp_dir
  test "an identity path inside a log temporary-file namespace refuses", %{
    tmp_dir: tmp_dir,
    instance: instance
  } do
    identity_path = instance["log_file"] <> ".tmp.identity"
    File.cp!(instance["identity_file"], identity_path)

    colliding = Map.put(instance, "identity_file", identity_path)
    path = manifest_with(tmp_dir, colliding)

    assert {:error, {:invalid_manifest, :identity_log_temp_namespace_collision}} =
             Manifest.load(path)
  end

  @tag :tmp_dir
  test "a symlinked directory alias cannot hide an identity in a log temp namespace", %{
    tmp_dir: tmp_dir,
    instance: instance
  } do
    alias_dir = Path.join(tmp_dir, "alias")
    File.ln_s!(tmp_dir, alias_dir)

    identity_path = instance["log_file"] <> ".tmp.identity"
    File.cp!(instance["identity_file"], identity_path)
    File.chmod!(identity_path, 0o600)

    aliased_identity = Path.join(alias_dir, Path.basename(identity_path))
    colliding = Map.put(instance, "identity_file", aliased_identity)

    assert {:error, {:invalid_manifest, :identity_log_temp_namespace_collision}} =
             tmp_dir |> manifest_with(colliding) |> Manifest.load()
  end

  @tag :tmp_dir
  test "a pilot manifest refuses a 65th replica route", %{
    tmp_dir: tmp_dir,
    instance: instance
  } do
    instances =
      for index <- 1..65 do
        Map.put(instance, "name", "pilot-#{index}")
      end

    path = write_manifest(tmp_dir, %{"version" => 1, "instances" => instances})

    assert {:error, {:invalid_manifest, :too_many_instances}} = Manifest.load(path)
  end
end
