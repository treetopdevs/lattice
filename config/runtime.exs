import Config

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
