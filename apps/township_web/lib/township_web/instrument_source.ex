defmodule TownshipWeb.InstrumentSource do
  @moduledoc """
  Boundary for loading integrity-checked data into the Township instrument.
  """

  @type payload :: TownshipWeb.VerifiedInstrumentSnapshot.t()
  @type load_error :: {:bundle_unverified, [String.t()]}

  @callback load(keyword()) :: {:ok, payload()} | {:error, load_error()}

  @doc "Load the configured instrument source with optional source-specific overrides."
  @spec load(keyword()) :: {:ok, payload()} | {:error, load_error()}
  def load(opts \\ []) do
    {source, opts} =
      Keyword.pop_lazy(opts, :source, fn ->
        Application.fetch_env!(:township_web, :instrument_source)
      end)

    opts =
      Keyword.put_new_lazy(opts, :bundle_dir, fn ->
        Application.fetch_env!(:township_web, :bundle_dir)
      end)

    source.load(opts)
  end
end
