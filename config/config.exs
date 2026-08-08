# This file is responsible for configuring your umbrella
# and **all applications** and their dependencies with the
# help of the Config module.
#
# Note that all applications in your umbrella share the
# same configuration and dependencies, which is why they
# all use the same configuration file. If you want different
# configurations or dependencies per app, it is best to
# move said applications out of the umbrella.
import Config

config :township_web,
  bundle_dir: Path.expand("../artifacts/township", __DIR__),
  instrument_source: TownshipWeb.InstrumentSource.Bundle

config :township_web, TownshipWeb.Endpoint,
  url: [host: "localhost"],
  http: [ip: {127, 0, 0, 1}, port: 4100],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [formats: [html: TownshipWeb.ErrorHTML], layout: false],
  pubsub_server: TownshipWeb.PubSub,
  server: false

if config_env() == :dev do
  config :township_web, TownshipWeb.Endpoint,
    watchers: [
      esbuild: {Esbuild, :install_and_run, [:township_web, ~w(--sourcemap=inline --watch)]}
    ]
end

# LatticeCarrierServer.Durability.Posix refuses macOS's directory sync by
# default (no F_FULLFSYNC, and global `sync` is not a directory fsync), so a
# production pilot release on macOS cannot silently report readiness. This
# is the one explicit, source-visible opt-in that lets the real Posix
# durability path (and the tests that exercise it) run on a macOS
# development machine; it never applies to config_env() == :prod, so the
# lattice_carrier_pilot release keeps the default refusal.
if config_env() == :test do
  config :lattice_carrier_server, allow_approximate_darwin_sync: true

  # LatticeCarrierServer.Health caches its storage-writable rehearsal for a
  # short TTL (default 5s in prod) so /readyz does not repeat the full
  # fsync/subprocess rehearsal on every poll. Tests that flip a directory's
  # writability mid-test need to observe the change immediately, so the test
  # environment disables the cache rather than sleeping past the TTL.
  config :lattice_carrier_server, storage_check_ttl_ms: 0
end

config :esbuild,
  version: "0.25.5",
  township_web: [
    args:
      ~w(js/app.js --bundle --target=es2022 --outdir=../priv/static/assets --external:/fonts/* --external:/images/* --define:process.env.NODE_ENV="production" --define:__VUE_OPTIONS_API__=false --define:__VUE_PROD_DEVTOOLS__=false --define:__VUE_PROD_HYDRATION_MISMATCH_DETAILS__=false),
    cd: Path.expand("../apps/township_web/assets", __DIR__),
    env: %{"NODE_PATH" => Path.expand("../deps", __DIR__)}
  ]

config :phoenix, :json_library, Jason

# Sample configuration:
#
#     config :logger, :default_handler,
#       level: :info
#
#     config :logger, :default_formatter,
#       format: "$date $time [$level] $metadata$message\n",
#       metadata: [:user_id]
#

if config_env() in [:dev, :test] do
  import_config "#{config_env()}.exs"
end
