defmodule Lattice.Carrier.Telemetry do
  @moduledoc false

  @type event :: [atom()]
  @type measurements :: map()
  @type metadata :: map()

  @compile {:no_warn_undefined,
            [
              {:telemetry, :attach, 4},
              {:telemetry, :attach_many, 4},
              {:telemetry, :detach, 1},
              {:telemetry, :execute, 3}
            ]}

  @spec execute(event(), measurements(), metadata()) :: :ok
  def execute(event, measurements, metadata) do
    if ensure_started?() do
      :telemetry.execute(event, measurements, metadata)
    end

    :ok
  end

  @spec attach(term(), event(), function(), term()) :: :ok | {:error, term()}
  def attach(handler_id, event, handler, config) do
    if ensure_started?() do
      :telemetry.attach(handler_id, event, handler, config)
    else
      {:error, :not_available}
    end
  end

  @spec attach_many(term(), [event()], function(), term()) :: :ok | {:error, term()}
  def attach_many(handler_id, events, handler, config) do
    if ensure_started?() do
      :telemetry.attach_many(handler_id, events, handler, config)
    else
      {:error, :not_available}
    end
  end

  @spec detach(term()) :: :ok | {:error, term()}
  def detach(handler_id) do
    if ensure_started?() do
      :telemetry.detach(handler_id)
    else
      {:error, :not_available}
    end
  end

  defp ensure_started? do
    Code.ensure_loaded?(:telemetry) and
      match?({:ok, _apps}, Application.ensure_all_started(:telemetry))
  end
end
