defmodule Treehouse.MemberContinuity do
  @moduledoc """
  Pure member-continuity application judgment and deny-only graph projection.

  Callback inputs are internal judge-produced evidence, not authenticated public
  inputs. The Space command delegates here without conferring membership or rights.
  """
  alias Lattice.{Authority, Dag, Log, Op}
  alias Treehouse.MemberContinuityCertificate, as: Certificate

  @doc "Derive a closed consent claim from authenticated current Space evidence."
  @spec review(Log.t(), map()) :: {:ok, map()} | {:error, atom()}
  defdelegate review(log, request), to: Treehouse.MemberContinuityAuthoring

  @doc "Recheck consent and ordinary authority before signing and authenticating one final frame."
  @spec assemble(Log.t(), map(), map(), Lattice.Identity.t() | map()) ::
          {:ok, map()} | {:error, atom()}
  defdelegate assemble(log, review, certificate, signer), to: Treehouse.MemberContinuityAuthoring

  @doc "Authenticate complete retained Space history before projecting the real Space judge."
  @spec observe(Log.t()) :: {:ok, map()} | {:error, atom()}
  def observe(log) do
    with :ok <- Log.verify_authenticity(log),
         {:ok, %{profile: %{kind: :space}}} <- Authority.continuation_profile(log) do
      analysis = Authority.analyze(Treehouse.Space, log)
      verdicts = Map.new(log.ops, fn {id, _} -> {id, Map.get(analysis.reasons, id, :honored)} end)
      honored = records(%{visible_ops: log.ops, verdicts: verdicts})
      records = observed_records(honored, log.ops)

      quarantine =
        analysis.reasons
        |> Enum.sort()
        |> Enum.map(fn {id, reason} -> %{op_id: id, reason: reason} end)

      {:ok,
       %{
         replica: log.replica,
         verified_frontier: Log.frontier(log),
         records: records,
         links: observed_links(log.ops, honored, analysis.reasons),
         quarantine: quarantine
       }}
    else
      {:error, errors} when is_list(errors) -> {:error, :invalid_verified_history}
      _ -> {:error, :unsupported_continuity_history}
    end
  end

  defp observed_records(honored, ops) do
    honored
    |> Enum.group_by(fn {_, cert} -> Certificate.claim_id(cert.claim) end)
    |> Enum.sort()
    |> Enum.map(fn {claim_id, wrappers} ->
      {_, cert} = hd(wrappers)

      %{
        claim_id: claim_id,
        claim: cert.claim,
        wrappers:
          wrappers
          |> Enum.sort_by(&elem(&1, 0))
          |> Enum.map(fn {id, certificate} ->
            op = Map.fetch!(ops, id)
            %{op_id: id, author: op.author, cap_id: op.cap, certificate: certificate}
          end)
      }
    end)
  end

  defp observed_links(ops, honored, reasons) do
    ops
    |> Enum.flat_map(fn {_id, op} ->
      case claim_of(op) do
        {:ok, claim} -> [claim.old_pub]
        _ -> []
      end
    end)
    |> Enum.uniq()
    |> Enum.sort()
    |> Enum.map(fn old ->
      current_heads = heads(honored, old)

      affected =
        for {id, op} <- Enum.sort(ops),
            {:ok, claim} <- [claim_of(op)],
            claim.old_pub == old,
            reason = reasons[id],
            reason != nil,
            do: %{op_id: id, reason: reason}

      status =
        cond do
          length(current_heads) > 16 ->
            :capacity_stop

          Enum.any?(affected, &(&1.reason == :application_continuity_invalid_parent)) ->
            :review_required

          length(current_heads) > 1 ->
            :contested

          current_heads == [] ->
            :unlinked

          true ->
            :attested
        end

      %{old_pub: old, heads: current_heads, status: status, affected_wrappers: affected}
    end)
  end

  @spec command_op_status(Op.t(), MapSet.t(), map()) :: :ok | {:error, atom()}
  def command_op_status(op, visible, context) do
    with {:ok, cert} <- certificate(op),
         true <- cert.claim.space == op.replica and cert.claim.deps == op.deps,
         context = causal_final_context(context),
         :ok <- targets(cert.claim, op.replica, visible, context),
         :ok <- eligibility(cert.claim, context),
         :ok <- epoch(cert.claim, context),
         :ok <- parent_context(cert.claim, context),
         :ok <- verify(cert) do
      :ok
    else
      false -> {:error, :application_invalid_continuity}
      {:error, :invalid_member_continuity} -> {:error, :application_invalid_continuity}
      {:error, reason} -> {:error, reason}
    end
  end

  # Resolve only already visible application conflicts using the same deny-only
  # graph. Core authority verdicts and exact beacon evidence are never rejudged.
  defp causal_final_context(context) do
    denied =
      resolve_command_conflicts(
        context.visible_ops,
        context.verdicts,
        &Dag.ancestors(context.visible_ops, &1)
      )

    %{context | verdicts: Map.merge(context.verdicts, denied)}
  end

  defp parent_context(claim, context) do
    if claim.parents == heads(records(context), claim.old_pub),
      do: :ok,
      else: {:error, :application_continuity_stale_context}
  end

  defp verify(cert) do
    case Certificate.verify_certificate(cert, cert.claim) do
      :ok -> :ok
      _ -> {:error, :application_continuity_invalid_certificate}
    end
  end

  @spec certificate(Op.t()) :: {:ok, map()} | {:error, :invalid_member_continuity}
  def certificate(%Op{
        kind: :command,
        body: {:attest_member_key_v1, [claim, possession, vouches]}
      }),
      do:
        Certificate.normalize_certificate(%{
          claim: claim,
          possession: possession,
          vouches: vouches
        })

  def certificate(_), do: {:error, :invalid_member_continuity}

  defp claim_of(%Op{kind: :command, body: {:attest_member_key_v1, [claim, _, _]}}),
    do: Certificate.normalize_claim(claim)

  defp claim_of(_), do: {:error, :invalid_member_continuity}

  defp targets(claim, replica, visible, context) do
    admissions = [
      {claim.old_admission, claim.old_pub} | Enum.map(claim.vouchers, &{&1.admission, &1.member})
    ]

    parent_groups =
      Enum.map(claim.parents, fn parent ->
        {parent,
         Enum.filter(context.visible_ops, fn {_id, op} ->
           case claim_of(op) do
             {:ok, claim} -> Certificate.claim_id(claim) == parent
             _ -> false
           end
         end)}
      end)

    ids = Enum.map(admissions, &elem(&1, 0)) ++ claim.epoch_basis

    cond do
      Enum.any?(ids, &(not MapSet.member?(visible, &1))) or
          Enum.any?(parent_groups, fn {_, wrappers} -> wrappers == [] end) ->
        {:error, :application_target_not_visible}

      Enum.any?(ids, &(context.verdicts[&1] != :honored)) or
          Enum.any?(parent_groups, fn {_, wrappers} ->
            not Enum.any?(wrappers, fn {id, _} -> context.verdicts[id] == :honored end)
          end) ->
        {:error, :application_target_quarantined}

      Enum.any?(admissions, fn {id, key} ->
        not admission?(context.visible_ops[id], replica, key)
      end) or
        Enum.any?(claim.epoch_basis, &(not beacon?(context.visible_ops[&1], replica))) or
          Enum.any?(parent_groups, fn {_, wrappers} ->
            not Enum.any?(wrappers, fn {id, op} ->
              case {context.verdicts[id], claim_of(op)} do
                {:honored, {:ok, parent_claim}} ->
                  op.replica == replica and parent_claim.old_pub == claim.old_pub

                _ ->
                  false
              end
            end)
          end) ->
        {:error, :application_wrong_target}

      true ->
        :ok
    end
  end

  defp admission?(
         %Op{replica: replica, kind: :command, body: {:admit_member, [_, recipient, _, _]}},
         replica,
         key
       ),
       do: recipient == Base.encode64(key)

  defp admission?(_, _, _), do: false
  defp beacon?(%Op{replica: replica, kind: :authority, body: {:beacon, _}}, replica), do: true
  defp beacon?(%Op{replica: replica, kind: :authority, body: {:beacon, _, _}}, replica), do: true
  defp beacon?(_, _), do: false

  defp eligibility(claim, context) do
    admitted =
      for {id, op} <- context.visible_ops,
          context.verdicts[id] == :honored,
          admission?(op, claim.space, claim.old_pub),
          do: id

    active = Enum.any?(admitted, &(not removed?(&1, claim.old_pub, context)))
    prior = records(context)

    parent_target =
      Enum.any?(prior, fn {_id, cert} ->
        Certificate.claim_id(cert.claim) in claim.parents and cert.claim.old_pub == claim.old_pub and
          cert.claim.new_pub == claim.new_pub
      end)

    used =
      Enum.any?(context.visible_ops, fn {id, op} ->
        context.verdicts[id] == :honored and admission?(op, claim.space, claim.new_pub)
      end)

    other_old =
      Enum.any?(prior, fn {_id, cert} ->
        cert.claim.old_pub != claim.old_pub and cert.claim.new_pub == claim.new_pub
      end)

    if if(active, do: :active, else: :removed) == claim.old_membership and
         Enum.all?(claim.vouchers, &(not removed?(&1.admission, &1.member, context))) and
         (not used or parent_target) and not other_old,
       do: :ok,
       else: {:error, :application_continuity_ineligible_member}
  end

  defp removed?(tag, key, context) do
    Enum.any?(context.visible_ops, fn {id, op} ->
      context.verdicts[id] == :honored and removal?(op, key) and
        MapSet.member?(Dag.ancestors(context.visible_ops, id), tag)
    end)
  end

  defp removal?(%Op{kind: :command, body: {:remove_member, [recipient]}}, key),
    do: recipient == Base.encode64(key)

  defp removal?(_, _), do: false

  defp epoch(claim, context) do
    beacons = context.valid_beacons
    maximum = Enum.max(Enum.map(beacons, & &1.epoch), fn -> -1 end)
    basis = for %{epoch: value, op_id: id} <- beacons, value == maximum, do: id

    if maximum >= 0 and maximum <= 9_007_199_254_740_991 and
         claim.epoch == maximum and claim.epoch_basis == Enum.sort(basis),
       do: :ok,
       else: {:error, :application_continuity_invalid_epoch}
  end

  defp records(context) do
    for {id, op} <- context.visible_ops,
        context.verdicts[id] == :honored,
        {:ok, cert} <- [certificate(op)],
        do: {id, cert}
  end

  @doc "Heads of already judged certificates; callers must not treat this as authentication."
  @spec heads([{String.t(), map()}], binary()) :: [String.t()]
  def heads(records, old) do
    claims = for {_, cert} <- records, cert.claim.old_pub == old, do: cert.claim
    superseded = MapSet.new(Enum.flat_map(claims, & &1.parents))

    claims
    |> Enum.map(&Certificate.claim_id/1)
    |> Enum.uniq()
    |> Enum.reject(&MapSet.member?(superseded, &1))
    |> Enum.sort()
  end

  @spec command_conflicts(map(), map(), map()) :: map()
  def command_conflicts(ops, verdicts, ancestors) do
    resolve_command_conflicts(ops, verdicts, &Map.fetch!(ancestors, &1))
  end

  defp resolve_command_conflicts(ops, verdicts, ancestors) do
    candidates =
      for op <- Dag.topo_sort(ops),
          verdicts[op.id] == :honored,
          {:ok, cert} <- [certificate(op)],
          do: {op, cert}

    removals_by_member =
      for {id, op} <- ops,
          verdicts[id] == :honored,
          {:ok, member} <- [removal_member(op)],
          reduce: %{} do
        grouped -> Map.update(grouped, member, [op], &[op | &1])
      end

    candidates_by_target = Enum.group_by(candidates, fn {_op, cert} -> cert.claim.new_pub end)

    parent_wrappers =
      Enum.group_by(candidates, fn {_op, cert} ->
        {Certificate.claim_id(cert.claim), cert.claim.old_pub}
      end)

    seeds =
      Enum.reduce(candidates, %{}, fn {op, cert}, denied ->
        stale =
          Enum.any?(cert.claim.vouchers, fn voucher ->
            Enum.any?(removals_by_member[Base.encode64(voucher.member)] || [], fn removal ->
              concurrent?(op.id, removal.id, ancestors) and
                MapSet.member?(ancestors.(removal.id), voucher.admission)
            end)
          end)

        collision =
          Enum.any?(candidates_by_target[cert.claim.new_pub], fn {other, other_cert} ->
            cert.claim.old_pub != other_cert.claim.old_pub and
              cert.claim.new_pub == other_cert.claim.new_pub and
              concurrent?(op.id, other.id, ancestors)
          end)

        cond do
          stale -> Map.put(denied, op.id, :application_continuity_stale_voucher)
          collision -> Map.put(denied, op.id, :application_continuity_conflicting_target)
          true -> denied
        end
      end)

    Enum.reduce(candidates, seeds, fn {op, cert}, denied ->
      invalid =
        Enum.any?(cert.claim.parents, fn parent ->
          not Enum.any?(parent_wrappers[{parent, cert.claim.old_pub}] || [], fn {wrapper, _cert} ->
            MapSet.member?(ancestors.(op.id), wrapper.id) and
              not Map.has_key?(denied, wrapper.id)
          end)
        end)

      if invalid,
        do: Map.put_new(denied, op.id, :application_continuity_invalid_parent),
        else: denied
    end)
  end

  defp concurrent?(a, b, ancestors),
    do: a != b and not MapSet.member?(ancestors.(a), b) and not MapSet.member?(ancestors.(b), a)

  defp removal_member(%Op{kind: :command, body: {:remove_member, [recipient]}})
       when is_binary(recipient),
       do: {:ok, recipient}

  defp removal_member(_), do: :error
end
