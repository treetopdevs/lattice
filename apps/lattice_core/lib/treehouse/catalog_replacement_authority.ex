defmodule Treehouse.CatalogReplacementAuthority do
  @moduledoc """
  Plan 316 section 3 step 4 (PR 4a): the strict-prefix authority predicates of one
  `replace_catalog_v1` claim. Pure over the given log; it reads only public `Lattice.Authority`
  judgments (`analyze_with_records/2`, `continuation_profile/1`) and the op bodies already in
  that log. It adds no Core primitive and judges nothing about the union.

  `prefix` must be the strict causal prefix of the claiming op (its deps' closure, never the op
  itself). The acquisition delegation is resolved by the honored record's `delegation_id`, read
  from that record's own introducing op (`record.op_id`): a `:transfer`/`:grant` op for an
  ordinary acquisition, the `:succeed` op (whose delegation is the continuation certificate's,
  `parent_id: nil`) for an R04 continuation. It must be the single delegation in that op whose
  id is `record.delegation_id`; an id scan would also see copied or forged structs retained
  under the same id (PR 0, T1).

  Predicates, in evaluation order. A profile mismatch is `wrong_catalog_scope` and outranks
  every other failure; the rest are `catalog_authority_refused` with the failing predicate:
  `:not_holder` (the analysis' current `:admin` holder epoch is not `{author, holder_epoch}`, or
  the last honored record is another op), `:wrong_acquisition_cap`, `:delegation_unreadable`,
  `:missing_permission`, `:live_capability`, `:unleased`, `:no_beacon`, `:epoch_mismatch`,
  `:lease_lapsed`, `:inherited_provenance` (rows 335, 356: `replace_catalog_v1` in every
  honored `:admin` ceiling from the latest acquisition issued by the Space root to the current
  one).

  `refute_without_closure/3` is the monotone subset used while a candidate's closure is
  incomplete: it reads only the candidate's own claim and the held `holder_epoch` op's own
  delegation, facts no later-arriving ancestor can change.

  Not a route switch and not catalog trust: a passing check only says the claim's authority
  facts hold at its prefix.
  """

  alias Lattice.{Authority, Log, Op}
  alias Lattice.Authority.Delegation
  alias Treehouse.Space

  @max_safe 9_007_199_254_740_991

  @type detail :: %{predicate: atom(), core_reason: nil}

  @spec check(Log.t(), %{author: binary(), cap: String.t()}, map(), binary()) ::
          :ok | {:error, :catalog_authority_refused | :wrong_catalog_scope, detail()}
  def check(%Log{} = prefix, %{author: author, cap: cap}, claim, space_root) do
    case profile(prefix, claim) do
      :ok ->
        {analysis, beacons, records} = Authority.analyze_with_records(Space, prefix)
        holder = Map.get(analysis.holder_epochs, :admin)
        predicates(prefix, {author, cap, holder}, claim, space_root, beacons, records)

      :error ->
        {:error, :wrong_catalog_scope, %{predicate: :profile, core_reason: nil}}
    end
  end

  defp profile(prefix, claim) do
    case Authority.continuation_profile(prefix) do
      {:ok, %{profile_genesis: g, profile_id: id}}
      when g == claim.profile_genesis and id == claim.profile_id ->
        :ok

      _ ->
        :error
    end
  end

  defp predicates(prefix, {author, cap, holder}, claim, space_root, beacons, records) do
    admin = Map.get(records, :admin, [])
    last = List.last(admin)

    with {:holder, true} <-
           {:holder,
            holder == %{holder: author, op_id: claim.holder_epoch} and
              match?(%{op_id: _}, last) and last.op_id == claim.holder_epoch and
              last.holder == author},
         {:cap, true} <- {:cap, last.delegation_id == cap},
         {:delegation, %Delegation{} = d} <- {:delegation, acquired(prefix, last)},
         :ok <- ceiling(d),
         {:beacon, {epoch, basis}} when not is_nil(epoch) <- {:beacon, epoch_rule(beacons)},
         {:epoch, true} <- {:epoch, claim.epoch == epoch and claim.epoch_basis == basis},
         {:lease, true} <- {:lease, d.expires_epoch >= epoch},
         {:provenance, true} <- {:provenance, provenance?(prefix, admin, space_root)} do
      :ok
    else
      {step, _} -> refused(predicate(step))
    end
  end

  # The facts of the acquisition delegation itself, shared with `refute_without_closure/3`.
  defp ceiling(d) do
    cond do
      :replace_catalog_v1 not in d.ops -> {:permission, false}
      d.live != false -> {:live, false}
      not (is_integer(d.expires_epoch) and d.expires_epoch in 0..@max_safe) -> {:leased, false}
      true -> :ok
    end
  end

  defp refused(predicate),
    do: {:error, :catalog_authority_refused, %{predicate: predicate, core_reason: nil}}

  defp predicate(:holder), do: :not_holder
  defp predicate(:cap), do: :wrong_acquisition_cap
  defp predicate(:delegation), do: :delegation_unreadable
  defp predicate(:permission), do: :missing_permission
  defp predicate(:live), do: :live_capability
  defp predicate(:leased), do: :unleased
  defp predicate(:beacon), do: :no_beacon
  defp predicate(:epoch), do: :epoch_mismatch
  defp predicate(:lease), do: :lease_lapsed
  defp predicate(:provenance), do: :inherited_provenance

  @doc """
  Monotone refutation for a candidate whose causal closure is incomplete. Returns nil when no
  refutation holds yet (the candidate stays pending), else the predicate. Only reads the
  `holder_epoch` op if it is held, and only that op's own delegation under `claim.cap`: its
  audience, ceiling, liveness and finite lease. No missing ancestor can change these.
  """
  @spec refute_without_closure(%{String.t() => Op.t()}, binary(), map()) :: atom() | nil
  def refute_without_closure(ops, author, claim) do
    case Map.get(ops, claim.holder_epoch) do
      nil ->
        nil

      %Op{} = op ->
        case delegation_in(op, claim.cap) do
          %Delegation{audience: ^author} = d ->
            case ceiling(d) do
              :ok -> nil
              {step, _} -> predicate(step)
            end

          %Delegation{} ->
            :not_holder

          nil ->
            :delegation_unreadable
        end
    end
  end

  # Maximum honored ancestor beacon epoch and the sorted ids at it, or `{nil, []}`.
  defp epoch_rule([]), do: {nil, []}

  defp epoch_rule(beacons) do
    epoch = beacons |> Enum.map(& &1.epoch) |> Enum.max()
    {epoch, Enum.sort(for %{epoch: ^epoch, op_id: id} <- beacons, do: id)}
  end

  # Rows 335/356: every honored admin ceiling since the latest Space-root-issued acquisition
  # must carry the permission; any unreadable delegation, or no root-issued record, refuses.
  defp provenance?(prefix, admin, root) do
    delegations = Enum.map(admin, &acquired(prefix, &1))

    case delegations |> Enum.reverse() |> Enum.split_while(&(&1 != nil and &1.issuer != root)) do
      {later, [%Delegation{} = rooted | _]} ->
        Enum.all?([rooted | later], &(:replace_catalog_v1 in &1.ops))

      _ ->
        false
    end
  end

  @doc "The delegation introduced by one honored acquisition record, or nil."
  @spec acquired(Log.t(), %{op_id: String.t(), delegation_id: String.t()}) ::
          Delegation.t() | nil
  def acquired(%Log{} = log, %{op_id: op_id, delegation_id: id}) do
    case Map.get(Log.ops(log), op_id) do
      %Op{} = op -> delegation_in(op, id)
      nil -> nil
    end
  end

  defp delegation_in(%Op{kind: :authority, body: body}, id) when is_tuple(body) do
    case for(%Delegation{id: ^id} = x <- Tuple.to_list(body), do: x) do
      [%Delegation{} = d] -> d
      _ -> nil
    end
  end

  defp delegation_in(_op, _id), do: nil
end
