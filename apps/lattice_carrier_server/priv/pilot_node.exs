# Pilot carrier entrypoint: boots the manifest-driven runtime.
#
# The single argument is the manifest path. Identity material loads only from
# the secret files the manifest names; no seed, key, or other secret is ever
# accepted on the command line, read from a plain environment dump, or echoed
# to output. The Mix release (`lattice_carrier_pilot`) selects the manifest via
# LATTICE_CARRIER_MANIFEST instead of running this script.

manifest_path =
  case System.argv() do
    [path] ->
      path

    _other ->
      IO.puts(
        :stderr,
        "usage: pilot_node.exs <manifest.json> — identity material loads only from " <>
          "manifest-named secret files; command-line seeds are not supported"
      )

      System.halt(64)
  end

Application.put_env(:lattice_carrier_server, :manifest, Path.expand(manifest_path))
Application.put_env(:lattice_carrier_server, :allow_ephemeral_manifest_ports, true)

# This script is a dev/test-only entrypoint — never the production release
# boot path (that goes through the standard release `Application.start`
# callback with no such override). Explicitly opt this dev fixture into the
# macOS directory-sync approximation so it can rehearse and relay locally;
# the actual lattice_carrier_pilot release keeps the default refusal on a
# non-Linux host (see LatticeCarrierServer.Durability.Posix).
if :os.type() == {:unix, :darwin} do
  Application.put_env(:lattice_carrier_server, :allow_approximate_darwin_sync, true)
end

case Application.ensure_all_started(:lattice_carrier_server) do
  {:ok, _apps} ->
    deployment = LatticeCarrierServer.Runtime.deployment()

    Enum.each(deployment.instances, fn instance ->
      port = LatticeCarrierServer.port(instance.name)
      IO.puts("INSTANCE #{instance.name} #{port} #{Base.encode64(instance.pub)}")
    end)

    IO.puts("PILOT_READY #{LatticeCarrierServer.Health.port() || 0}")

    spawn(fn ->
      _ = IO.gets("")
      System.halt(0)
    end)

    Process.sleep(:infinity)

  {:error, reason} ->
    # Manifest/runtime refusal reasons carry paths and atoms only — never
    # secret bytes (see LatticeCarrierServer.Manifest).
    IO.puts(:stderr, "PILOT_REFUSED #{inspect(reason)}")
    System.halt(1)
end
