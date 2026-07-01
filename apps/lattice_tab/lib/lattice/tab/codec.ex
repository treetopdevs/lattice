defmodule Lattice.Tab.Codec do
  @moduledoc """
  JSON codec for the tab realm. Uses the `:json` module (host OTP 28 + AtomVM
  estdlib — PHASE0 §OQ3). Decoding yields binary-keyed maps (what `Protocol`
  matches); encoding stringifies atom keys/values so Protocol render intents and
  string-keyed envelopes both serialize.
  """

  @spec decode(binary()) :: {:ok, map()} | {:error, term()}
  def decode(json) when is_binary(json) do
    {:ok, :json.decode(json)}
  rescue
    e -> {:error, e}
  catch
    kind, reason -> {:error, {kind, reason}}
  end

  @spec encode(term()) :: binary()
  def encode(term), do: IO.iodata_to_binary(:json.encode(term))
end
