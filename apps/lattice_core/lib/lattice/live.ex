defmodule Lattice.Live do
  @moduledoc """
  The live ephemeral path — and the keystone of the 2.0 thesis (behavior 16).

  One signed delegation chain has two uses (design invariant 2):

    * **log append** — a `:command`/`:authority` op cites the chain leaf in
      `Lattice.Op.cap`; `Lattice.Authority` validates it.
    * **live message** — the *same* chain, carried in a `Lattice.Cap`, authorizes a
      message sent through the v1 `Lattice.Gateway`.

  `authorize/2` is the single gate the live path uses. It checks the chain's
  signatures/attenuation **and** consults the Replica log for revocation — the *same*
  in-log `:revoke` op that the append path checks (via `Lattice.Authority` reduction
  quarantine). That shared in-log revocation is the true unification: **one in-log
  `:revoke` op kills both the append path and the live path.**

  `revoke/4` additionally revokes the linked v1 cap in `Lattice.CapStore`. That is
  *defense-in-depth*, not the mechanism that kills the live path here: a caller who
  goes through `Live.call/3` is already stopped by the in-log check before the Gateway
  is reached. The v1 cap revocation matters only for a *direct* `Lattice.Gateway.call`
  that bypasses `authorize/2` — that path is governed by the v1 cap's revoked state.

  This module assumes the v1 capability plane (`Lattice.CapStore`, `Lattice.Topology`,
  `Lattice.Gateway`) is running, exactly as in v1 — nothing here bypasses it.
  """

  alias Lattice.{Authority, Cap, CapStore, Gateway, Identity, Log, Op}

  @doc """
  Authorize a unified cap for a live send against the current Replica `log`:

    1. the cap carries a non-empty chain bound to `log`'s replica,
    2. the chain verifies (sigs + genesis + attenuation),
    3. the leaf confers `:live`,
    4. the leaf is not revoked in the log (same revocation as the append path).
  """
  @spec authorize(Cap.t(), Log.t()) :: :ok | {:error, atom()}
  def authorize(%Cap{} = cap, %Log{} = log) do
    leaf = Cap.leaf(cap)

    cond do
      cap.chain == [] -> {:error, :no_chain}
      cap.replica != log.replica -> {:error, :wrong_replica}
      Authority.verify_chain(cap.chain, log.replica) != :ok -> {:error, :invalid_chain}
      not leaf.live -> {:error, :live_not_granted}
      Authority.revoked?(log, leaf.id) -> {:error, :revoked}
      true -> :ok
    end
  end

  @doc """
  Send a live ephemeral message authorized by the unified cap, *through the v1
  Gateway*. Returns `{:ok, reply}` / `:ok` on success or `{:error, reason}` if the
  chain check or the Gateway rejects it.
  """
  @spec call(Cap.t(), Log.t(), term()) :: {:ok, term()} | {:error, atom()}
  def call(%Cap{} = cap, %Log{} = log, payload) do
    with :ok <- authorize(cap, log) do
      Gateway.call(cap.owner_tab_id, cap.id, payload)
    end
  end

  @spec cast(Cap.t(), Log.t(), term()) :: :ok | {:error, atom()}
  def cast(%Cap{} = cap, %Log{} = log, payload) do
    with :ok <- authorize(cap, log) do
      Gateway.cast(cap.owner_tab_id, cap.id, payload)
    end
  end

  @doc """
  Revoke a unified delegation. The in-log `:revoke` op is what kills both the append
  path (reduction quarantine) and the live `Live.call/3` path (`authorize/2`). The
  additional `Lattice.CapStore` revocation is defense-in-depth that also blocks a
  *direct* `Lattice.Gateway.call` bypassing `authorize/2`. Returns the updated log.
  """
  @spec revoke(Log.t(), Identity.t(), String.t(), String.t()) :: Log.t()
  def revoke(%Log{} = log, %Identity{} = issuer, delegation_id, v1_cap_id) do
    op = Op.new(issuer, log.replica, Log.frontier(log), :authority, {:revoke, delegation_id})
    log = Log.append!(log, op)
    _ = CapStore.revoke(v1_cap_id)
    log
  end
end
