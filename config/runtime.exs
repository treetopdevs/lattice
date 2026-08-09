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

# Signing material for the Township endpoint. Nothing is committed: production
# supplies SECRET_KEY_BASE and LIVE_VIEW_SIGNING_SALT from the environment,
# each required independently — one being absent must never silently suppress
# the other, so each is validated and raised on by name before either is
# configured. dev/test mint both values ephemerally at boot. Ephemeral is
# correct for dev/test — the instrument is a loopback-bound read-only surface
# with no login, so the only consequence of a fresh key per boot is that a
# stale browser session is re-established. The carrier-only pilot release
# does not include :township_web.
if not carrier_release? do
  case config_env() do
    env when env in [:dev, :test] ->
      secret_key_base =
        System.get_env("SECRET_KEY_BASE") || Base.encode64(:crypto.strong_rand_bytes(48))

      signing_salt =
        System.get_env("LIVE_VIEW_SIGNING_SALT") || Base.encode64(:crypto.strong_rand_bytes(16))

      config :township_web, TownshipWeb.Endpoint,
        secret_key_base: secret_key_base,
        live_view: [signing_salt: signing_salt]

    other_env ->
      # Fail closed for :prod and for any unrecognized MIX_ENV alike: both
      # values are required from the environment, raised on by name, rather
      # than defaulting an unknown environment to dev/test's ephemeral path
      # or falling through to an unhelpful CaseClauseError.
      _ = other_env

      secret_key_base =
        System.get_env("SECRET_KEY_BASE") ||
          raise "SECRET_KEY_BASE is required for the Township web endpoint"

      signing_salt =
        System.get_env("LIVE_VIEW_SIGNING_SALT") ||
          raise "LIVE_VIEW_SIGNING_SALT is required for the Township web endpoint"

      config :township_web, TownshipWeb.Endpoint,
        secret_key_base: secret_key_base,
        live_view: [signing_salt: signing_salt]
  end
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
