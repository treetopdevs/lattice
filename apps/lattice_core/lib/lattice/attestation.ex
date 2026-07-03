defmodule Lattice.Attestation do
  @moduledoc """
  The attestation seam — the load-bearing interface of the Township POC.

  Township's minimal cut proves three workloads (W0–W3) on the real substrate
  and *stubs the fourth* (W4, receipt-free attestation) behind this behaviour.
  The bet is: if this interface captures exactly what a receipt-free primitive
  needs, then landing M4 is a **swap** (drop in a new implementing module) rather
  than a **rewrite** of the workflows. This is the same "does the boundary match
  what M2 replaces?" discipline PD-001 §6/V-03 applies to the carrier.

  ## The three operations

    * `cast_vouch/3` — a member attests support for a matter. Returns an **opaque
      token** plus the op body to append to the matter's log. The token is opaque
      so that callers never depend on its internal shape; the Stub makes it a
      signed tag, M4 makes it a chameleon-hash commitment.

    * `tally/2` — reduce the set of vouch ops on the DAG into a result. This is
      the coordinator-free *reconciliation* role the DAG absorbs (per the MACI
      research note): it is real today. Determinism here is required in both the
      Stub and M4 regimes.

    * `produce_alt/2` — the **equivocation hook**. Given a token and a coercer's
      demanded value, produce a *valid alternative* that the coercer cannot
      distinguish from a genuine vouch. This is where receipt-freeness lives:
        - Stub: returns a valid alternative trivially (the property is faked and
          honestly labelled `receipt_free?: false`).
        - M4:   returns it via a real trapdoor re-opening (chameleon hash), and
          only then is `receipt_free?/0` allowed to be `true`.

  ## The contract that guards the swap

  `Lattice.Attestation.Contract` (see test support) runs the SAME suite against
  any implementing module. The Stub must pass every part except the
  receipt-freeness property; M4 must pass ALL of it. A module that changes the
  *shape* of any callback breaks the contract test loudly — which is the whole
  point of writing the interface before the workflows.

  ## Deliberately NOT decided here

  Which receipt-free primitive M4 uses (chameleon hash + DVP, deniable
  encryption, or an LRS composition) is a §6 R-02/R-03 research verdict, not a
  choice this behaviour makes. This module only fixes the *interface* so that
  verdict can arrive without disturbing W0–W3.
  """

  alias Lattice.Identity

  @typedoc "An opaque attestation token. Callers must treat this as a black box."
  @opaque token :: {module(), term()}

  @typedoc "The body to append as an Op of kind :command on the matter's log."
  @type vouch_body :: {:vouch, term()}

  @typedoc "A tally result: the reduced outcome plus per-choice counts."
  @type tally_result :: %{outcome: term(), counts: %{term() => non_neg_integer()}}

  @doc "True only if this implementation delivers real receipt-freeness."
  @callback receipt_free?() :: boolean()

  @doc """
  Cast a vouch on `choice` for `matter`, authored by `identity`.
  Returns `{token, vouch_body}` — append `vouch_body` to the matter log as a
  `:command` op; keep `token` client-side for a later `produce_alt/2`.
  """
  @callback cast_vouch(Identity.t(), choice :: term(), opts :: keyword()) ::
              {token(), vouch_body()}

  @doc "Deterministically reduce a list of `{:vouch, _}` op bodies into a result."
  @callback tally([vouch_body()], opts :: keyword()) :: tally_result()

  @doc """
  The equivocation hook. Given a `token` and a coercer's `demanded` value,
  produce a `vouch_body` that is a valid alternative indistinguishable from a
  genuine vouch for `demanded`.
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

  A vouch is just the choice tagged and signed by the author. The tally is a real
  deterministic reduction over the DAG's vouch ops — that part is genuine and
  survives into M4 unchanged. `produce_alt/2` trivially returns a fresh vouch for
  the demanded value: a coercer isn't actually defeated, so `receipt_free?/0` is
  `false`. This module exists to make the POC's W4 loop pass end-to-end while
  telling the truth about what is and isn't proven.
  """

  @behaviour Lattice.Attestation

  alias Lattice.Identity

  @impl true
  def receipt_free?, do: false

  @impl true
  def cast_vouch(%Identity{} = id, choice, _opts) do
    # A real (non-receipt-free) vouch: bind the choice to the author.
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
  Reserved slot for the real receipt-free primitive (roadmap R2 / milestone M4).

  This module intentionally does not implement the behaviour yet. When the §6
  R-02/R-03 research verdict lands, implement the four callbacks here with a real
  trapdoor (chameleon hash + designated-verifier proof, or the primitive that
  clears JCJ), set `receipt_free?/0` to `true`, and run the SAME
  `Lattice.Attestation.Contract`. If it passes, Township's W0–W3 are untouched
  and W4 becomes real. If the contract fails, the interface was wrong — fix it
  here, in one place, before shipping.

      @behaviour Lattice.Attestation
      @impl true
      def receipt_free?, do: true
      # cast_vouch/3  -> commit to `choice` under an ephemeral trapdoor
      # tally/2       -> identical reduction to the Stub (DAG-native, unchanged)
      # produce_alt/2 -> re-open the commitment to `demanded` via the trapdoor
  """
end
