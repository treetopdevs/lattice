defmodule Lattice.Promise do
  @moduledoc """
  A durable request/response handle.

  `Lattice.call/3` authors a `{:request, ref, query}` inbox op and returns a
  `Promise`. The target's next materialization answers by appending a
  `{:response, ref, result}` inbox op. `Lattice.await/2` resolves the promise by
  reading that response from the local log (once synced) — so resolution survives
  dormancy of *either* side (behavior 12): the answer lives in the log, not in a
  process mailbox.
  """

  @enforce_keys [:ref, :replica, :target, :from]
  defstruct [:ref, :replica, :target, :from]

  @type t :: %__MODULE__{
          ref: String.t(),
          replica: String.t(),
          target: String.t(),
          from: String.t()
        }
end
