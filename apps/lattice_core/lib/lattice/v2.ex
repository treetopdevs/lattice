defmodule Lattice.V2 do
  @moduledoc """
  The coherent Lattice 2.0 facade: every v2 verb under one module, with its
  canonical name, delegating to the existing runtime (`Lattice.Registry`) and
  value-level (`Lattice`) functions. Pure delegation — no new logic lives here
  (see "Maintenance" below).

  ## Why this module exists

  The v1 capability plane owns the obvious names on `Lattice` (`call/3` is the
  Gateway call, `grant/4` is a tab capability, `cast/3` is an ephemeral cast), so
  the v2 API grew up split: non-clashing verbs on `Lattice` (`materialize/2`,
  `send_durable/3`, `await/2`, ...) and the clashing ones reached via
  `Lattice.Registry` (`call/4` for the durable promise). `Lattice.V2` resolves
  the split: one discoverable surface, no v1 breakage.

  ## Design decisions (plan 011)

  1. **Surface** — the facade exposes exactly the v2 verbs that already exist in
     the runtime, under canonical names:

     | `Lattice.V2` | Delegates to | Meaning |
     |---|---|---|
     | `materialize/2` | `Lattice.Registry.materialize/2` | bring `{realm, replica}` live |
     | `dormant/2` | `Lattice.Registry.go_dormant/2` | stop the live process; log persists |
     | `tombstone/2` | `Lattice.Registry.tombstone/2` | permanent, replica-wide end |
     | `monitor/2` | `Lattice.Registry.monitor/3` (pid = caller) | lifecycle + message notifications |
     | `send/3` | `Lattice.Registry.deliver/4` | durable send (inbox op) |
     | `call/4` | `Lattice.Registry.call/4` | durable call; returns a `Lattice.Promise` |
     | `await/2` | `Lattice.Registry.await/3` | resolve a promise from the log |
     | `state/2` (realm, replica) | `Lattice.Registry.state/2` | runtime read (quarantine applied) |
     | `state/2` (module, `%Lattice.Log{}`) | `Lattice.state/2` | value-level read over any log |
     | `state_at/3` | `Lattice.state_at/3` | historical state at a causal frontier |

     Runtime plumbing (`host/4`, `sync/3`, `dump/3`, `restore/4`, `lifecycle/2`,
     `log/2`) intentionally stays on `Lattice.Registry`: it is setup/operations
     surface, not the application verb set.

  2. **Capability/grant naming** — the facade exposes **no** `grant`/`delegate`.
     A v2 delegation is an in-log `:authority` op authored by a realm
     (`Lattice.Authority.Delegation` + `Lattice.Op`); today the only issuing
     conveniences are `Lattice.Sim.grant/4` (simulator) and hand-authored ops.
     `Lattice.Registry` has no delegation-authoring API, so a facade `grant`
     would require new runtime logic — out of scope per plan 011's STOP
     condition. Recorded as an open question below; when the runtime grows a
     delegation verb, the facade gains a one-line delegate to it.

  3. **v1 deprecation** — v1 names on `Lattice` are neither renamed nor
     deprecated by this plan; the facade is strictly additive. A future
     `Lattice.V1` alias or `@deprecated` pass is an open question, not an
     action.

  ## v1 ↔ v2 side by side

  | Concern | v1 (`Lattice`, capability plane) | v2 (`Lattice.V2`, op-log plane) |
  |---|---|---|
  | Invoke | `Lattice.call/3` — ephemeral Gateway call | `Lattice.V2.call/4` + `await/2` — durable promise, survives dormancy |
  | Fire-and-forget | `Lattice.cast/3` — ephemeral | `Lattice.V2.send/3` — durable inbox op, exactly-once on next materialization |
  | Issue authority | `Lattice.grant/4` — tab capability in `CapStore` | in-log delegation op (`Lattice.Sim.grant/4` / `Lattice.Authority.Delegation`); no facade verb yet |
  | Revoke | `Lattice.revoke/2` | in-log revoke op (`Lattice.Sim.revoke/3`) |
  | Lifecycle | `connect_tab/1`, `disconnect_tab/1`, `eject/2` | `materialize/2`, `dormant/2`, `tombstone/2` |
  | Observe | `Lattice.audit_events/0`, `diagnostics/0` | `monitor/2` |
  | Read state | (process-held; no log) | `state/2`, `state_at/3` — pure reductions of the log |

  ## Open questions (maintainer)

  - Should v2 become the primary API (a later plan deprecates v1 names via a
    `Lattice.V1` alias / `@deprecated`), or do both planes stay first-class?
  - Should a delegation-issuing verb (`grant`) be added to `Lattice.Registry`
    so the facade can expose it, or does issuing stay with `Sim`/raw ops until
    a real carrier (plan 010) forces the question?
  - Should the pure `Lattice.Sim` surface converge behind this facade, or
    remain deliberately "simulation vs runtime"?

  ## Maintenance

  Keep this module delegation-only. If logic wants to creep in, push it down
  into `Lattice.Registry`/`Lattice` so the facade stays trivially correct.
  """

  alias Lattice.{Log, Promise, Registry}

  @doc "Bring `{realm, replica}` live; returns `{:ok, state}`. See `Lattice.Registry.materialize/2`."
  defdelegate materialize(realm, replica), to: Registry

  @doc "Send `{realm, replica}` dormant (live process stops; log persists)."
  def dormant(realm, replica), do: Registry.go_dormant(realm, replica)

  @doc "Permanently tombstone `{realm, replica}` (an op; blocks rematerialization everywhere)."
  defdelegate tombstone(realm, replica), to: Registry

  @doc "Subscribe the calling process to lifecycle + message notifications for `{realm, replica}`."
  def monitor(realm, replica), do: Registry.monitor(realm, replica, self())

  @doc "Durably send `payload` from `from_realm` to `{to_realm, replica}` (delivered on materialize)."
  def send(from_realm, {to_realm, replica}, payload),
    do: Registry.deliver(from_realm, to_realm, replica, payload)

  @doc "Issue a durable call from `from_realm` to `{to_realm, replica}`; returns `{:ok, %Lattice.Promise{}}`."
  defdelegate call(from_realm, to_realm, replica, query), to: Registry

  @doc "Resolve a promise from `realm`'s log: `{:ok, result}` or `:pending`."
  def await(realm, %Promise{replica: replica} = promise),
    do: Registry.await(realm, replica, promise)

  @doc """
  Read materialized state (authority quarantine applied).

  Two heads, both pure delegation:

    * `state(module, %Lattice.Log{})` — value-level read over any log
      (`Lattice.state/2`), e.g. one restored from disk.
    * `state(realm, replica)` — runtime read of a hosted pair
      (`Lattice.Registry.state/2`).
  """
  def state(module, %Log{} = log), do: Lattice.state(module, log)
  def state(realm, replica), do: Registry.state(realm, replica)

  @doc "Historical state as of a causal `frontier` (list of op ids). See `Lattice.state_at/3`."
  def state_at(module, %Log{} = log, frontier), do: Lattice.state_at(module, log, frontier)
end
