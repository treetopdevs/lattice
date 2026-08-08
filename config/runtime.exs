import Config

# Pilot carrier runtime (plan 158): the release selects its deployment
# manifest through this environment variable. The manifest names secret
# identity files; no identity material passes through the environment itself.
# Inside the pilot release the manifest is mandatory — a missing manifest
# refuses startup rather than booting an instanceless carrier. The umbrella
# defines only this release, so RELEASE_ROOT is the stable release marker;
# RELEASE_NAME is operator-overridable and cannot identify the pilot safely.
carrier_release? = is_binary(System.get_env("RELEASE_ROOT"))

case System.get_env("LATTICE_CARRIER_MANIFEST") do
  nil when carrier_release? ->
    raise "LATTICE_CARRIER_MANIFEST is required for the pilot carrier release"

  nil ->
    :ok

  carrier_manifest ->
    config :lattice_carrier_server, manifest: carrier_manifest
end

if System.get_env("PHX_SERVER") do
  port = String.to_integer(System.get_env("PORT", "4100"))

  endpoint_config = Application.get_env(:township_web, TownshipWeb.Endpoint, [])
  live_view_config = Keyword.get(endpoint_config, :live_view, [])

  secret_key_base =
    case System.get_env("SECRET_KEY_BASE") do
      secret when is_binary(secret) and byte_size(secret) >= 64 ->
        secret

      _ ->
        raise """
        SECRET_KEY_BASE must be at least 64 bytes whenever PHX_SERVER is set — the
        endpoint is live and signs session cookies and LiveView tokens. Generate one
        with `mix phx.gen.secret`.
        """
    end

  live_view_signing_salt =
    case System.get_env("LIVE_VIEW_SIGNING_SALT") ||
           Keyword.get(live_view_config, :signing_salt) do
      salt when is_binary(salt) and byte_size(salt) >= 8 ->
        salt

      _ ->
        raise """
        LIVE_VIEW_SIGNING_SALT must be at least 8 bytes whenever PHX_SERVER is set
        without an environment-specific LiveView salt. Generate one with
        `mix phx.gen.secret`.
        """
    end

  config :township_web, TownshipWeb.Endpoint,
    http: [ip: {127, 0, 0, 1}, port: port],
    live_view: [signing_salt: live_view_signing_salt],
    server: true,
    secret_key_base: secret_key_base
end

# The Township web requirement does not apply inside the carrier-only
# release, which does not include :township_web.
if config_env() == :prod and not carrier_release? do
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise "SECRET_KEY_BASE is required for the Township web endpoint"

  config :township_web, TownshipWeb.Endpoint, secret_key_base: secret_key_base
end
