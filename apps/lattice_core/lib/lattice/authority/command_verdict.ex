defmodule Lattice.Authority.CommandVerdict do
  @moduledoc false

  alias Lattice.Authority.{Delegation, DelegationIndex, RoleTimeline}
  alias Lattice.Op

  @doc false
  @spec validate(module(), [Op.t()], map(), DelegationIndex.t(), map()) ::
          {%{Op.id() => atom()}, [map()], [map()]}
  def validate(module, ordered, ancestors, %DelegationIndex{} = index, timelines) do
    Enum.reduce(ordered, {%{}, [], []}, fn op, {quarantine, audit, requests} ->
      cond do
        op.kind == :inbox and match?({:request, _ref, _payload}, op.body) ->
          {:request, ref, payload} = op.body

          {quarantine, audit,
           requests ++ [%{op: op.id, author: op.author, ref: ref, payload: payload}]}

        op.kind == :command ->
          case validate_command(module, op, ancestors, index, timelines) do
            :ok ->
              {quarantine, audit, requests}

            {:error, reason} ->
              {Map.put(quarantine, op.id, reason),
               audit ++ [%{event: :command_quarantine, op: op.id, reason: reason}], requests}
          end

        true ->
          {quarantine, audit, requests}
      end
    end)
  end

  defp validate_command(module, op, ancestors, index, timelines) do
    {command, args} =
      case op.body do
        {command, args} when is_list(args) -> {command, args}
        _ -> {nil, nil}
      end

    cond do
      is_nil(command) ->
        {:error, :malformed_command}

      true ->
        case command_status(module, command, args) do
          :ok ->
            mutations = command_mutations(module, command, args)
            roles_needed = mutation_roles(module, mutations)

            with :ok <- cap_ok(op, command, ancestors, index, roles_needed),
                 :ok <- authority_ok(op, roles_needed, ancestors, timelines),
                 do: :ok

          {:error, reason} ->
            {:error, reason}
        end
    end
  end

  defp command_status(module, command, args) do
    case module.command_body(command, args) do
      {:ok, {^command, _args}} -> :ok
      {:error, {:bad_arity, ^command, _details}} -> {:error, :bad_command_arity}
      {:error, {:unknown_command, ^command}} -> {:error, :unknown_command}
    end
  end

  defp command_mutations(_module, nil, _args), do: []

  defp command_mutations(module, command, args) do
    module.__apply_command__(command, args)
  rescue
    ArgumentError -> []
  end

  defp mutation_roles(module, mutations) do
    mutations
    |> Enum.map(fn {field, _mutation} -> module.authority_role(field) end)
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
  end

  defp cap_ok(op, command, ancestors, index, roles_needed) do
    op_ancestors = Map.get(ancestors, op.id, MapSet.new())

    case Map.fetch(index.entries, op.cap) do
      :error ->
        {:error, :no_capability}

      {:ok, %{deleg: %Delegation{} = delegation, op_ids: delegation_ops}} ->
        cap_checks(
          op,
          command,
          delegation,
          delegation_ops,
          op_ancestors,
          ancestors,
          index,
          roles_needed
        )

      {:ok, %{deleg: nil}} ->
        {:error, :invalid_capability}
    end
  end

  defp cap_checks(
         op,
         command,
         delegation,
         delegation_ops,
         op_ancestors,
         ancestors,
         index,
         roles_needed
       ) do
    cond do
      index.validity[delegation.id] != :ok ->
        {:error, :invalid_capability}

      op.author != delegation.audience ->
        {:error, :capability_wrong_audience}

      not MapSet.member?(delegation.ops, command) ->
        {:error, :operation_not_granted}

      not Enum.any?(delegation_ops, &MapSet.member?(op_ancestors, &1)) ->
        {:error, :capability_not_visible}

      not Enum.all?(roles_needed, &MapSet.member?(delegation.roles, &1)) ->
        {:error, :role_not_granted}

      revoked_as_of?(op, delegation, ancestors, index) ->
        {:error, :revoked_capability}

      true ->
        :ok
    end
  end

  defp revoked_as_of?(op, delegation, ancestors, index) do
    chain_ids = DelegationIndex.chain_ids(index, delegation)

    Enum.any?(index.revokes, fn %{op_id: revoke_op, deleg_id: delegation_id} ->
      delegation_id in chain_ids and
        not MapSet.member?(Map.get(ancestors, revoke_op, MapSet.new()), op.id)
    end)
  end

  defp authority_ok(_op, [], _ancestors, _timelines), do: :ok

  defp authority_ok(op, roles_needed, ancestors, timelines) do
    op_ancestors = Map.get(ancestors, op.id, MapSet.new())

    Enum.reduce_while(roles_needed, :ok, fn role, _acc ->
      timeline = Map.fetch!(timelines, role)
      holder_at_deps = RoleTimeline.holder_at(timeline, op_ancestors)

      cond do
        holder_at_deps != op.author ->
          {:halt, {:error, :not_holder}}

        RoleTimeline.stale_holder?(op, holder_at_deps, timeline, ancestors) ->
          {:halt, {:error, :stale_holder}}

        true ->
          {:cont, :ok}
      end
    end)
  end
end
