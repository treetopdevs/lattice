defmodule Township.CarrierStateReport do
  @moduledoc """
  Builds the read-only Township state report exposed by a configured carrier.

  The report derives semantic authority from the carrier's accepted log without
  changing relay acceptance, authoring operations, or replacing Sim as the test
  oracle. Structural quarantine remains separate because those attempts are not
  members of the accepted operation log.
  """

  alias Lattice.{Authority, Log}
  alias Township.Matter

  @spec report(Log.t()) :: map()
  def report(%Log{} = log) do
    state = Lattice.state(Matter, log)

    %{
      state_b64:
        state
        |> :erlang.term_to_binary([:deterministic, {:minor_version, 2}])
        |> Base.encode64(),
      state: state,
      op_ids: log |> Log.op_ids() |> Enum.sort(),
      frontier: Log.frontier(log),
      structural_quarantine: structural_quarantine(log),
      authority_quarantine: authority_quarantine(log),
      log_size: Log.size(log)
    }
  end

  defp structural_quarantine(log) do
    log
    |> Log.quarantine()
    |> Enum.map(fn %{op: op, reason: reason} -> [op.id, Atom.to_string(reason)] end)
    |> Enum.sort()
  end

  defp authority_quarantine(log) do
    Matter
    |> Authority.analyze(log)
    |> Map.fetch!(:reasons)
    |> Enum.map(fn {id, reason} -> [id, Atom.to_string(reason)] end)
    |> Enum.sort()
  end
end
