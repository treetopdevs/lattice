defmodule Lattice.Attestation do
  @moduledoc """
  Legacy W4 attestation seam for the Township POC.

  Township's minimal cut proves three workloads (W0–W3) on the real substrate
  and stubs the fourth behind this behaviour. The M4 research verdict falsified
  the original drop-in-swap wager: coercion resistance requires the separate,
  multi-role `Township.Election` protocol and cannot soundly implement these four
  callbacks.

  This behaviour now exists only to keep the legacy W4 demo honest while the new
  election path clears its blocking gates. `Lattice.Attestation.Stub` must keep
  returning `false` from `receipt_free?/0`; no future election implementation may
  be placed behind this interface.

  ## The three operations

    * `cast_vouch/3` — a member records a legacy demo vouch. Returns an **opaque
      token** plus a caller-held demo body. The token is opaque so that callers
      never depend on its internal shape. Neither value is a declared Matter
      command.

    * `tally/2` — reduce caller-held legacy demo bodies into a deterministic
      result. It does not read, authenticate, or reduce Matter-log operations.

    * `produce_alt/2` — a legacy plumbing hook. The Stub can fabricate another
      body, but the M4 verdict proves that this is not receipt-freeness and that
      a counting alternative is the wrong abstraction for fake credentials.

  ## The legacy contract

  `Lattice.Attestation.Contract` (see test support) freezes the Stub's existing
  demo behavior and fails if it ever claims receipt-freeness. The new election
  path has separate board, projection, close, offline-replay, and eventually
  cryptographic conformance contracts.

  ## Replacement boundary

  `Township.Election` links immutable election configuration from a Matter to a
  dedicated `Township.ElectionBoard`, then performs pure public replay over exact
  artifacts. Its research profile currently makes no coercion-resistance claim.
  W4 and the read/audit surface migrate only after every gate clears; this legacy
  behavior and its contract are retired last.
  """

  alias Lattice.Identity

  @typedoc "An opaque attestation token. Callers must treat this as a black box."
  @opaque token :: {module(), term()}

  @typedoc "A legacy caller-held vouch body; it is not a declared Matter command."
  @type vouch_body :: {:vouch, term()}

  @typedoc "A tally result: the reduced outcome plus per-choice counts."
  @type tally_result :: %{outcome: term(), counts: %{term() => non_neg_integer()}}

  @doc "Legacy flag. The frozen Stub must return false; M4 does not implement this behavior."
  @callback receipt_free?() :: boolean()

  @doc """
  Create a legacy caller-held vouch on `choice`, attributed to `identity`.
  Returns `{token, vouch_body}` for the old demo and read-model plumbing.
  """
  @callback cast_vouch(Identity.t(), choice :: term(), opts :: keyword()) ::
              {token(), vouch_body()}

  @doc "Deterministically reduce a list of `{:vouch, _}` op bodies into a result."
  @callback tally([vouch_body()], opts :: keyword()) :: tally_result()

  @doc """
  Legacy plumbing hook. Given a `token` and demanded value, fabricate another
  tallyable demo body. This callback supplies no indistinguishability property.
  """
  @callback produce_alt(token(), demanded :: term()) :: vouch_body()

  # --- convenience dispatch so call sites read `Attestation.cast_vouch(impl, …)` ---

  @doc false
  def receipt_free?(impl), do: impl.receipt_free?()

  @doc false
  def cast_vouch(impl, %Identity{} = id, choice, opts \\ []),
    do: impl.cast_vouch(id, choice, opts)

  @doc false
  def tally(impl, bodies, opts \\ []) when is_list(bodies),
    do: impl.tally(bodies, opts)

  @doc false
  def produce_alt(impl, token, demanded),
    do: impl.produce_alt(token, demanded)
end

defmodule Lattice.Attestation.Stub do
  @moduledoc """
  Pre-M4 attestation: correct plumbing, **no** receipt-freeness.

  A vouch is just the choice tagged with an identity fingerprint; it is not
  signed or appended to Matter. The tally is a deterministic legacy reduction
  over supplied caller-held bodies. `produce_alt/2`
  trivially returns a fresh vouch for the demanded value: a coercer is not
  defeated, so `receipt_free?/0` is permanently `false`. This module exists only
  to keep the legacy POC's W4 loop honest until that surface migrates to verified
  election projection.
  """

  @behaviour Lattice.Attestation

  alias Lattice.Identity

  @impl true
  def receipt_free?, do: false

  @impl true
  def cast_vouch(%Identity{} = id, choice, _opts) do
    # Legacy demo attribution only: bind the choice to an identity fingerprint.
    tag = %{choice: choice, by: Identity.fingerprint(id)}
    token = {__MODULE__, tag}
    {token, {:vouch, tag}}
  end

  @impl true
  def tally(bodies, _opts) do
    counts =
      bodies
      |> Enum.map(fn {:vouch, %{choice: c}} -> c end)
      |> Enum.frequencies()

    outcome =
      counts
      |> Enum.sort_by(fn {choice, n} -> {-n, inspect(choice)} end)
      |> List.first()
      |> case do
        {choice, _} -> choice
        nil -> :no_vouches
      end

    %{outcome: outcome, counts: counts}
  end

  @impl true
  def produce_alt({__MODULE__, %{by: by}}, demanded) do
    # Trivial equivocation: fabricate a valid-looking alternative. In the Stub
    # this is genuinely "free" (no trapdoor), which is exactly why the property
    # is not real yet.
    {:vouch, %{choice: demanded, by: by}}
  end
end

defmodule Lattice.Attestation.M4Placeholder do
  @moduledoc """
  Legacy reserved name retained as an explicit tombstone during M4 migration.

  Do not implement `Lattice.Attestation` callbacks here. The research verdict
  retired that interface for M4; the replacement lives under
  `Township.Election` and has distinct protocol contracts. This empty module is
  removed only after the read/audit surface and W4 switch to verified election
  projection.
  """
end
