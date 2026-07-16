defmodule TownshipWeb.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children =
      [{Phoenix.PubSub, name: TownshipWeb.PubSub}] ++
        projection_children() ++
        [TownshipWeb.Endpoint]

    opts = [strategy: :one_for_one, name: TownshipWeb.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl true
  def config_change(changed, _new, removed) do
    TownshipWeb.Endpoint.config_change(changed, removed)
    :ok
  end

  defp projection_children do
    case Application.get_env(:township_web, :instrument_projection_options) do
      opts when is_list(opts) ->
        [
          {TownshipWeb.CarrierProjection,
           Keyword.put_new(opts, :name, TownshipWeb.CarrierProjection)}
        ]

      _not_configured ->
        []
    end
  end
end
