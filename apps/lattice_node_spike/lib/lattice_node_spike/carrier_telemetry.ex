defmodule LatticeNodeSpike.CarrierTelemetry do
  @moduledoc """
  Default Logger bridge for the carrier telemetry emitted by the node spike.
  """

  alias Lattice.Carrier.Telemetry

  require Logger

  @handler_id {__MODULE__, :logger}
  @events [
    [:lattice, :carrier, :sync, :stop],
    [:lattice, :carrier, :connect],
    [:lattice, :carrier, :auth_failure],
    [:lattice, :carrier, :disconnect],
    [:lattice, :carrier, :pre_auth_reject]
  ]

  @spec attach_default_logger() :: :ok
  def attach_default_logger do
    case Telemetry.attach_many(
           @handler_id,
           @events,
           &__MODULE__.handle_event/4,
           nil
         ) do
      :ok -> :ok
      {:error, :already_exists} -> :ok
      {:error, :not_available} -> :ok
    end
  end

  @doc false
  def handle_event([:lattice, :carrier, :sync, :stop], measurements, metadata, _config) do
    Logger.debug(
      "carrier sync stop carrier=#{inspect(metadata[:carrier])} sent=#{measurements[:sent]} received=#{measurements[:received]}"
    )
  end

  def handle_event([:lattice, :carrier, :connect], _measurements, metadata, _config) do
    Logger.info("carrier connected realm=#{metadata[:realm]} peer_realm=#{metadata[:peer_realm]}")
  end

  def handle_event([:lattice, :carrier, :auth_failure], _measurements, metadata, _config) do
    Logger.warning(
      "carrier auth failed reason=#{inspect(metadata[:reason])} realm=#{metadata[:realm]} peer_realm=#{metadata[:peer_realm]} expected_realm=#{metadata[:expected_realm]} side=#{metadata[:side]}"
    )
  end

  def handle_event([:lattice, :carrier, :disconnect], _measurements, metadata, _config) do
    Logger.debug("carrier disconnected realm=#{metadata[:realm]}")
  end

  def handle_event([:lattice, :carrier, :pre_auth_reject], _measurements, metadata, _config) do
    Logger.debug("carrier pre-auth reject type=#{inspect(metadata[:type])}")
  end
end
