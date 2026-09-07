defmodule Treehouse.CatalogCutoff do
  @moduledoc """
  Exact authenticated recovery-cutoff bytes, including retained rejected evidence.

  This read-only observation proves integrity of the supplied complete log. It
  neither establishes semantic authority nor proves absence of withheld history.
  Unsupported evidence refuses the observation instead of disappearing from it.
  """

  alias Lattice.{Canonical, Log, Op}
  alias Lattice.Carrier.Wire
  alias Lattice.Authority.Delegation

  # Closed cutoff-only vocabulary; never create atoms from an imported history.
  @cutoff_atoms MapSet.new(~w(
    __beacon__ __continuation__ accept active admin admin_actions admission admit_member
    archive_thread archived attest_member_key_v1 audience author author_edit author_tombstone
    authority bad_signature beacon binding bootstrap bounded_continuation
    bounded_space_admin_v1 bytes cap catalog catalog_bootstrap_v1 catalog_key claim command
    consent continuation_v1 create_space create_thread creation cutoffs delegation_id deps
    dormant_ticks entries epoch epoch_basis expires_epoch frontier generation genesis grant
    heartbeat holder holder_epoch id inbox inventory_digest invitations issue_invitation
    issuer kind live log_digest max_epoch_step max_lease_epochs member members
    membership_events mode moderation moderator moderator_actions moderator_tombstone name
    new_catalog_key new_origin new_pub new_service_id new_service_key new_signature nominee
    nonce old_admission old_membership old_pub old_signature ops origin parent parent_id
    parents policy_id post posts previous prior_catalog prior_catalogs product profile_genesis
    profile_id reason recovery reference reject remove_member removed replace_catalog_v1
    replacement_rule replica request revision revoke revoke_invitation revoked_invitations
    role roles root rotation route schema service service_id service_key sig signature
    signatures space space_root succeed successor thread threads threshold title tombstone
    transfer treehouse treehouse_space_v1 treehouse_thread_v1 version vouchers witness
    witnessed witnesses
  )a)
  @max_safe_integer 9_007_199_254_740_991

  @spec derive(term()) ::
          {:ok, map()} | {:error, :invalid_verified_history | :unsupported_cutoff}
  def derive(log) do
    case Log.verify_authenticity(log) do
      :ok -> derive_verified(log)
      {:error, _} -> {:error, :invalid_verified_history}
    end
  end

  defp derive_verified(log) do
    accepted = log |> Log.ops() |> Map.values() |> Enum.sort_by(& &1.id)
    rejected = log |> Log.quarantine() |> Enum.sort_by(& &1.op.id)

    if Enum.all?(accepted, &portable?/1) and
         Enum.all?(rejected, &portable?(&1.op)) do
      ops = Enum.map(accepted, &record/1)
      rejected = Enum.map(rejected, &Map.put(record(&1.op), :reason, :bad_signature))
      bytes = Canonical.term(["lattice-treehouse-recovery-cutoff-v1", log.replica, ops, rejected])

      {:ok,
       %{
         cutoff: %{
           replica: log.replica,
           frontier: Log.frontier(log),
           log_digest: :crypto.hash(:sha256, bytes) |> Base.url_encode64(padding: false)
         },
         canonical_bytes: bytes,
         ops: ops,
         rejected: rejected
       }}
    else
      {:error, :unsupported_cutoff}
    end
  rescue
    _ -> {:error, :unsupported_cutoff}
  end

  defp record(%Op{} = op),
    do: %{id: op.id, bytes: Canonical.op_payload(op), sig: op.sig}

  defp portable?(%Op{} = op) do
    # Round-trip the ordinary JSON/header/term representation without interpreting
    # a rejected op's supplied ID or signature as authenticated identity slots.
    with {:ok, encoded} <- Jason.encode(%{"type" => "push", "ops" => [Wire.encode_op(op)]}),
         true <- byte_size(encoded) <= 64_000,
         {:ok, %{"ops" => [frame]}} <- Jason.decode(encoded),
         {:ok, ^op} <- Wire.decode_op(frame) do
      bytes?(op.author, 32) and text?(op.id) and text?(op.replica) and
        Enum.all?(op.deps, &text?/1) and is_binary(op.sig) and
        portable_value?(op.body) and portable_value?(op.cap)
    else
      _ -> false
    end
  end

  defp portable_value?(value) when value in [nil, true, false], do: true
  defp portable_value?(value) when is_binary(value) or is_integer(value), do: true

  defp portable_value?(value) when is_atom(value),
    do: MapSet.member?(@cutoff_atoms, value)

  defp portable_value?(%Delegation{} = d) do
    bytes?(d.issuer, 32) and bytes?(d.audience, 32) and bytes?(d.sig, 64) and
      text?(d.id) and text?(d.replica) and (is_nil(d.parent_id) or text?(d.parent_id)) and
      (is_nil(d.expires_epoch) or
         (is_integer(d.expires_epoch) and d.expires_epoch >= 0 and
            d.expires_epoch <= @max_safe_integer)) and
      portable_value?(d.ops) and portable_value?(d.roles)
  end

  defp portable_value?(%MapSet{} = values), do: Enum.all?(values, &portable_value?/1)
  defp portable_value?(value) when is_list(value), do: Enum.all?(value, &portable_value?/1)

  defp portable_value?(value) when is_tuple(value),
    do: value |> Tuple.to_list() |> Enum.all?(&portable_value?/1)

  defp portable_value?(value) when is_map(value),
    do: Enum.all?(value, fn {key, item} -> portable_value?(key) and portable_value?(item) end)

  defp portable_value?(_), do: false

  defp text?(value), do: is_binary(value) and String.valid?(value)
  defp bytes?(value, length), do: is_binary(value) and byte_size(value) == length
end
