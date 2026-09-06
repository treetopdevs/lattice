defmodule Lattice.Authority.Continuation do
  @moduledoc """
  Causal profile selection and finite scope checks for the reserved Treehouse
  continuation family. The authority fold supplies only honored acquisitions,
  statically verified delegations and valid beacons; this module never accepts
  certificate assertions as evidence of those facts.
  """

  alias Lattice.{Authority, Op}
  alias Lattice.Authority.{ContinuationCertificate, Delegation}

  @family "#authority:bounded-continuation-v1#root:"
  @horizon 9_007_199_254_740_991

  @spec family(String.t()) :: :legacy | :unsupported | {:bounded, :space | :thread}
  def family(replica) do
    case String.split(replica, ":", parts: 4) do
      ["replica", "treehouse", kind, tail] when kind in ["space", "thread"] ->
        if String.contains?(tail, "#authority:") do
          exact_family(replica, tail, if(kind == "space", do: :space, else: :thread))
        else
          :legacy
        end

      _ ->
        :legacy
    end
  end

  defp exact_family(replica, tail, kind) do
    case String.split(tail, @family) do
      [nonce, tag] ->
        if ContinuationCertificate.id?(nonce) and ContinuationCertificate.id?(tag) and
             Authority.replica_commitment(replica) == tag,
           do: {:bounded, kind},
           else: :unsupported

      _ ->
        :unsupported
    end
  end

  @spec context(String.t(), [Op.t()], map(), map(), term(), [map()]) :: map()
  def context(replica, ordered, delegations, valid, root, beacons) do
    family = family(replica)

    pins =
      for %Op{kind: :authority, body: {:genesis, %Delegation{} = d, policies}} = op <- ordered,
          is_map(policies),
          valid[d.id] == :ok,
          op.author == root and d.issuer == root and d.audience == root,
          is_nil(d.parent_id) and is_nil(d.expires_epoch) and d.live == false,
          MapSet.size(d.roles) == 0 and MapSet.size(d.ops) == 0,
          op.id in delegations[d.id].op_ids,
          {:ok, profile} <- [
            ContinuationCertificate.normalize_policy(policies[:__continuation__])
          ],
          family == {:bounded, profile.kind},
          do: %{op_id: op.id, profile: profile}

    %{family: family, pins: pins, beacons: beacons, delegations: delegations, valid: valid}
  end

  @spec select_pin(map(), MapSet.t()) :: map() | nil
  def select_pin(ctx, ancestors),
    do: ctx.pins |> Enum.filter(&MapSet.member?(ancestors, &1.op_id)) |> List.last()

  @spec judge(map(), Op.t(), atom(), Delegation.t(), term(), [map()], MapSet.t()) ::
          {:ok, non_neg_integer()} | {:error, atom()}
  def judge(%{family: :unsupported}, _op, _role, _d, _proof, _acquires, _anc),
    do: {:error, :unsupported_authority_profile}

  def judge(%{family: :legacy}, _op, _role, _d, _proof, _acquires, _anc),
    do: {:error, :unauthorized_continuation}

  def judge(ctx, op, role, d, {:continuation_v1, certificate}, acquires, anc) do
    with true <- ContinuationCertificate.valid_shape?(certificate),
         true <- is_nil(d.expires_epoch) or ContinuationCertificate.epoch?(d.expires_epoch),
         {:ok, expected} <- review(ctx, op, role, d, acquires, anc),
         :ok <- epoch_matches(certificate.claim, expected),
         :ok <- check_lease(d, expected.epoch, select_pin(ctx, anc).profile.max_lease_epochs),
         :ok <-
           ContinuationCertificate.verify(certificate, expected, select_pin(ctx, anc).profile),
         :ok <- current_predecessor(acquires, expected) do
      {:ok, expected.epoch}
    else
      false -> {:error, :malformed_term}
      {:error, _} = error -> error
    end
  end

  def judge(_ctx, _op, _role, _d, proof, _acquires, _anc)
      when is_tuple(proof) and tuple_size(proof) > 0 and elem(proof, 0) == :continuation_v1,
      do: {:error, :malformed_term}

  def judge(_ctx, _op, _role, _d, _proof, _acquires, _anc),
    do: {:error, :continuation_required}

  defp current_predecessor(acquires, expected),
    do:
      if(List.last(acquires).op_id == expected.holder_epoch,
        do: :ok,
        else: {:error, :stale_continuation}
      )

  @spec review(map(), Op.t(), atom(), Delegation.t(), [map()], MapSet.t()) ::
          {:ok, map()} | {:error, atom()}
  def review(ctx, op, role, d, acquires, anc) do
    pin = select_pin(ctx, anc)
    predecessor = acquires |> Enum.filter(&MapSet.member?(anc, &1.op_id)) |> List.last()

    cond do
      is_nil(pin) ->
        {:error, :continuation_not_configured}

      not authorized?(ctx, op, role, d, predecessor, pin.profile) ->
        {:error, :unauthorized_continuation}

      not scope?(ctx, d, predecessor, role) ->
        {:error, :continuation_scope_exceeded}

      true ->
        expected_claim(ctx, op, role, d, predecessor, pin, anc)
    end
  end

  defp authorized?(_ctx, _op, _role, _d, nil, _profile), do: false

  defp authorized?(ctx, op, role, d, p, profile) do
    role == profile.role and op.author in [p.holder, profile.nominee] and
      d.issuer == op.author and d.audience == op.author and MapSet.member?(d.roles, role) and
      d.replica == op.replica and Delegation.valid_sig?(d) and
      match?(%{deleg: %Delegation{}}, ctx.delegations[p.delegation_id])
  end

  defp scope?(ctx, d, p, role) do
    previous = ctx.delegations[p.delegation_id].deleg

    d.roles == MapSet.new([role]) and MapSet.subset?(d.ops, previous.ops) and
      d.live == false and is_nil(d.parent_id) and not is_nil(d.expires_epoch)
  end

  defp expected_claim(ctx, op, role, d, p, pin, anc) do
    causal = Enum.filter(ctx.beacons, &MapSet.member?(anc, &1.op_id))
    epoch = causal |> Enum.map(& &1.epoch) |> Enum.max(fn -> -1 end)

    if ContinuationCertificate.epoch?(epoch) do
      {:ok, profile_id} = ContinuationCertificate.profile_id(pin.profile)
      basis = causal |> Enum.filter(&(&1.epoch == epoch)) |> Enum.map(& &1.op_id) |> Enum.sort()

      {:ok,
       %{
         version: 1,
         product: :treehouse,
         kind: pin.profile.kind,
         replica: op.replica,
         role: role,
         profile_id: profile_id,
         profile_genesis: pin.op_id,
         holder: p.holder,
         holder_epoch: p.op_id,
         successor: d.audience,
         delegation_id: d.id,
         author: op.author,
         deps: Enum.sort(op.deps),
         epoch: epoch,
         epoch_basis: basis
       }}
    else
      {:error, :invalid_continuation_epoch}
    end
  end

  @doc false
  @spec proof?(term()) :: boolean()
  def proof?(proof),
    do: is_tuple(proof) and tuple_size(proof) > 0 and elem(proof, 0) == :continuation_v1

  @doc "Classify recognized continuation input that cannot enter a declared role timeline."
  @spec unhandled_reasons([Op.t()], MapSet.t(), map(), map()) :: map()
  def unhandled_reasons(ordered, roles, context, ancestors) do
    Enum.reduce(ordered, %{}, fn op, reasons ->
      case unhandled_reason(op, roles, context, Map.get(ancestors, op.id, MapSet.new())) do
        nil -> reasons
        reason -> Map.put(reasons, op.id, reason)
      end
    end)
  end

  defp unhandled_reason(
         %Op{kind: :authority, body: {:succeed, role, %Delegation{} = d, proof}} = op,
         roles,
         context,
         anc
       ) do
    if not MapSet.member?(roles, role) and (context.family != :legacy or proof?(proof)) do
      {:error, reason} = judge(context, op, role, d, proof, [], anc)
      reason
    end
  end

  defp unhandled_reason(%Op{kind: :authority, body: body}, _roles, context, _anc)
       when is_tuple(body) and tuple_size(body) >= 4 and elem(body, 0) == :succeed do
    if proof?(elem(body, 3)) do
      case context.family do
        :legacy -> :unauthorized_continuation
        :unsupported -> :unsupported_authority_profile
        _ -> :malformed_term
      end
    end
  end

  defp unhandled_reason(_, _, _, _), do: nil

  defp epoch_matches(claim, expected) do
    if {claim.epoch, claim.epoch_basis} == {expected.epoch, expected.epoch_basis},
      do: :ok,
      else: {:error, :invalid_continuation_epoch}
  end

  @spec check_lease(Delegation.t(), non_neg_integer(), pos_integer()) :: :ok | {:error, atom()}
  def check_lease(d, epoch, width) do
    if ContinuationCertificate.epoch?(d.expires_epoch) and d.expires_epoch >= epoch and
         d.expires_epoch <= min(epoch + width - 1, @horizon),
       do: :ok,
       else: {:error, :continuation_scope_exceeded}
  end
end
