import Config

# Pilot carrier runtime (plan 158): the release selects its deployment
# manifest through this environment variable. The manifest names secret
# identity files; no identity material passes through the environment itself.
if carrier_manifest = System.get_env("LATTICE_CARRIER_MANIFEST") do
  config :lattice_carrier_server, manifest: carrier_manifest
end

if System.get_env("PHX_SERVER") do
  port = String.to_integer(System.get_env("PORT", "4100"))

  config :township_web, TownshipWeb.Endpoint,
    http: [ip: {127, 0, 0, 1}, port: port],
    server: true
end

if config_env() == :prod do
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise "SECRET_KEY_BASE is required for the Township web endpoint"

  config :township_web, TownshipWeb.Endpoint, secret_key_base: secret_key_base
end
