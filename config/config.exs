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
  live_view: [signing_salt: "township-live-view"],
  secret_key_base: "township-dev-test-secret-key-base-change-for-production-000000000000000000",
  server: false

if config_env() == :dev do
  config :township_web, TownshipWeb.Endpoint,
    watchers: [
      esbuild: {Esbuild, :install_and_run, [:township_web, ~w(--sourcemap=inline --watch)]}
    ]
end

config :esbuild,
  version: "0.25.5",
  township_web: [
    args:
      ~w(js/app.js --bundle --target=es2022 --outdir=../priv/static/assets --external:/fonts/* --external:/images/*),
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
