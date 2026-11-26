defmodule Lattice.Authority.Delegation do
  @moduledoc """
  A signed link in a Replica's delegation chain — the single authorization
  primitive of Lattice 2.0 (design invariant 2: one delegation chain, two uses).

  The *same* delegation authorizes both appending ops to the log (its id is cited
  in an op's `cap`) and sending a live ephemeral message through the v1 Gateway
  (it is carried inside `Lattice.Cap.chain`). Revoking it (an in-log `:revoke` op)
  kills both paths.

  A delegation grants, scoped to one replica, from `issuer` to `audience`:

    * `ops`   — command names the audience may author (e.g. `:post`, `:lock`)
    * `roles` — serialized-authority roles conferred (e.g. `:moderator`)
    * `live`  — whether the audience may send live ephemeral messages

  Validity rules (checked by `Lattice.Authority`):

    * the signature verifies against `issuer`;
    * a genesis delegation (`parent_id == nil`) is self-issued (`issuer == audience`);
    * a child's `issuer` equals its parent's `audience`, and its capability
      *attenuates* — `ops`/`roles`/`live` are subsets of the parent's.
  """

  alias Lattice.Identity

  @enforce_keys [:id, :replica, :issuer, :audience, :ops, :roles, :live, :sig]
  @fields [:parent_id, :expires_epoch | @enforce_keys]
  defstruct [
    :id,
    :replica,
    :issuer,
    :audience,
    :parent_id,
    :ops,
    :roles,
    :live,
    :sig,
    :expires_epoch
  ]

  @type t :: %__MODULE__{
          id: String.t(),
          replica: String.t(),
          issuer: Identity.pubkey(),
          audience: Identity.pubkey(),
          parent_id: String.t() | nil,
          ops: MapSet.t(atom()),
          roles: MapSet.t(atom()),
          live: boolean(),
          sig: binary(),
          expires_epoch: non_neg_integer() | nil
        }

  @doc """
  Issue and sign a delegation from `issuer_identity` to `audience_pub`.

  Options: `:ops`, `:roles` (lists), `:live` (bool), `:parent_id` (chain link),
  `:expires_epoch` (plan 149 lease — the last epoch this delegation authorizes
  ops in; `nil` = no lease, today's behavior and today's v2 bytes).
  """
  @spec new(Identity.t(), String.t(), Identity.pubkey(), keyword()) :: t()
  def new(%Identity{} = issuer_identity, replica, audience_pub, opts \\ []) do
    ops = opts |> Keyword.get(:ops, []) |> MapSet.new()
    roles = opts |> Keyword.get(:roles, []) |> MapSet.new()
    live = Keyword.get(opts, :live, false)
    parent_id = Keyword.get(opts, :parent_id)
    expires_epoch = Keyword.get(opts, :expires_epoch)

    encoding =
      encode(
        replica,
        issuer_identity.pub,
        audience_pub,
        parent_id,
        ops,
        roles,
        live,
        expires_epoch
      )

    %__MODULE__{
      id: hash(encoding),
      replica: replica,
      issuer: issuer_identity.pub,
      audience: audience_pub,
      parent_id: parent_id,
      ops: ops,
      roles: roles,
      live: live,
      sig: Identity.sign(issuer_identity, encoding),
      expires_epoch: expires_epoch
    }
  end

  @doc "Self-issued root delegation granting the creator full capability."
  @spec genesis(Identity.t(), String.t(), keyword()) :: t()
  def genesis(%Identity{} = creator, replica, opts \\ []) do
    new(creator, replica, creator.pub,
      ops: Keyword.get(opts, :ops, []),
      roles: Keyword.get(opts, :roles, []),
      live: Keyword.get(opts, :live, true),
      parent_id: nil
    )
  end

  @doc """
  True if the signature and id are internally consistent.

  `ops` and `roles` must be `MapSet`s whose backing is a map (`:sets` v2, the
  shape `Delegation.new/4` emits). Canonical encoding sorts a list, a MapSet, or
  a MapSet wrapping a version-1 set of the same names into identical bytes, so
  those shapes can still verify; the judge later calls `MapSet.member?/2` and
  must not raise. A list or an unusable `:sets` v1 backing is therefore
  `:bad_delegation_sig`, never a crash (row 289). The same holds for every other
  field outside `well_formed?/1`.
  """
  @spec valid_sig?(t()) :: boolean()
  def valid_sig?(%__MODULE__{} = d) do
    well_formed?(d) and consistent_sig?(d)
  rescue
    # Canonical rejects malformed terms with ArgumentError; keep this rescue
    # aligned with that invariant if its refusal exception types ever change.
    ArgumentError -> false
  end

  defp consistent_sig?(%__MODULE__{} = d) do
    encoding =
      encode(
        d.replica,
        d.issuer,
        d.audience,
        d.parent_id,
        d.ops,
        d.roles,
        d.live,
        d.expires_epoch
      )

    d.id == hash(encoding) and Identity.verify(d.issuer, encoding, d.sig)
  end

  @doc """
  True if `child` legally attenuates `parent` (subset capability, linked issuer,
  and — plan 149 — a lease that never outlives the parent's: `nil` is unbounded,
  so a child of a leased parent must carry `expires_epoch <= parent's`).
  """
  @spec attenuates?(t(), t()) :: boolean()
  def attenuates?(%__MODULE__{} = child, %__MODULE__{} = parent) do
    well_formed?(child) and well_formed?(parent) and
      child.parent_id == parent.id and
      child.issuer == parent.audience and
      child.replica == parent.replica and
      MapSet.subset?(child.ops, parent.ops) and
      MapSet.subset?(child.roles, parent.roles) and
      (not child.live or parent.live) and
      expiry_within?(child, parent)
  end

  @doc """
  True if every field has a shape `Lattice.Carrier.Wire` can decode (row 289).

  The judge assumes these shapes: binary ids and keys, a boolean `live`, a
  `nil` or uint64 lease, and map-backed `MapSet`s (`:sets` v2, the shape
  `Delegation.new/4` emits) of scalar names. A signed or tampered term outside them, such
  as `live: "yes"` or `expires_epoch: -1`, is never valid and never raises.
  """
  @spec well_formed?(term()) :: boolean()
  def well_formed?(%__MODULE__{} = d) do
    complete?(d) and is_binary(d.id) and is_binary(d.replica) and
      is_binary(d.issuer) and
      is_binary(d.audience) and (is_nil(d.parent_id) or is_binary(d.parent_id)) and
      names?(d.ops) and names?(d.roles) and is_boolean(d.live) and is_binary(d.sig) and
      (is_nil(d.expires_epoch) or
         (is_integer(d.expires_epoch) and d.expires_epoch >= 0 and
            d.expires_epoch <= Lattice.Canonical.max_integer()))
  end

  def well_formed?(_other), do: false

  @doc """
  True if the struct carries every key. A tampered struct can lack any key (a
  legacy one lacks the lease); refuse it before a field read raises KeyError.
  `Lattice.Log.restore/1` fills missing keys with `nil` before the judge.
  """
  @spec complete?(term()) :: boolean()
  def complete?(%__MODULE__{} = d), do: Enum.all?(@fields, &is_map_key(d, &1))
  def complete?(_other), do: false

  # Members must be scalars Canonical can encode. A binary or integer name is
  # harmless (it signs to different bytes from the atom, so it never authorizes a
  # command) and stays valid; a nested term such as a forged MapSet would raise.
  defp names?(%MapSet{map: set} = names) when is_map(set), do: Enum.all?(names, &name?/1)
  defp names?(_other), do: false

  defp name?(name) when is_atom(name) or is_binary(name) or is_integer(name), do: true
  defp name?(%Lattice.Canonical.Atom{name: name}) when is_binary(name), do: true
  defp name?(_other), do: false

  # nil = unbounded. An unbounded parent accepts anything; a leased parent
  # accepts only a child leased at or before its own expiry.
  defp expiry_within?(_child, %__MODULE__{expires_epoch: nil}), do: true
  defp expiry_within?(%__MODULE__{expires_epoch: nil}, _parent), do: false

  defp expiry_within?(%__MODULE__{expires_epoch: child_e}, %__MODULE__{expires_epoch: parent_e}),
    do: child_e <= parent_e

  defp encode(replica, issuer, audience, parent_id, ops, roles, live, expires_epoch) do
    Lattice.Canonical.delegation_bytes(
      replica,
      issuer,
      audience,
      parent_id,
      ops,
      roles,
      live,
      expires_epoch
    )
  end

  defp hash(bytes), do: :crypto.hash(:sha256, bytes) |> Base.url_encode64(padding: false)
end
