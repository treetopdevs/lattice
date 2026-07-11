defmodule Lattice.Authority.RoleTimeline do
  @moduledoc false

  alias Lattice.Authority.{Delegation, DelegationIndex}
  alias Lattice.Op

  defstruct holder: nil,
            acquires: [],
            heartbeats: [],
            decided: %{},
            quarantine: %{},
            audit: []

  @type t :: %__MODULE__{
          holder: binary() | nil,
          acquires: [map()],
          heartbeats: [map()],
          decided: map(),
          quarantine: %{Op.id() => atom()},
          audit: [map()]
        }

  @doc false
  @spec roles(module()) :: MapSet.t(atom())
  def roles(module) do
    field_roles =
      module.__lattice_fields__()
      |> Enum.map(fn {field, _spec} -> module.authority_role(field) end)
      |> Enum.reject(&is_nil/1)

    succession_roles = Map.keys(module.__lattice_succession__())
    MapSet.new(field_roles ++ succession_roles)
  end

  @doc false
  @spec build(atom(), [Op.t()], map(), DelegationIndex.t()) :: t()
  def build(role, ordered, ancestors, %DelegationIndex{} = index) do
    Enum.reduce(ordered, %__MODULE__{}, fn op, timeline ->
      case role_event(op, role, index) do
        nil ->
          timeline

        {:genesis, delegation} ->
          if index.validity[delegation.id] == :ok and
               MapSet.member?(delegation.roles, role) do
            record_acquire(timeline, op, delegation.audience, 0)
          else
            timeline
          end

        {:transfer, delegation, at_tick} ->
          decide_transfer(timeline, op, role, delegation, at_tick, ancestors, index)

        {:succeed, delegation, at_tick} ->
          decide_succeed(timeline, op, role, delegation, at_tick, ancestors, index)

        {:heartbeat, at_tick} ->
          decide_heartbeat(timeline, op, at_tick, ancestors)
      end
    end)
  end

  @doc false
  @spec holder_at(t(), MapSet.t(Op.id())) :: binary() | nil
  def holder_at(%__MODULE__{acquires: acquires}, ancestors) do
    acquires
    |> Enum.filter(&MapSet.member?(ancestors, &1.op_id))
    |> List.last()
    |> case do
      nil -> nil
      %{holder: holder} -> holder
    end
  end

  @doc false
  @spec stale_holder?(Op.t(), binary(), t(), map()) :: boolean()
  def stale_holder?(op, author, %__MODULE__{} = timeline, ancestors) do
    op_ancestors = Map.get(ancestors, op.id, MapSet.new())

    acquire_index =
      timeline.acquires
      |> Enum.with_index()
      |> Enum.filter(fn {acquire, _index} ->
        MapSet.member?(op_ancestors, acquire.op_id) and acquire.holder == author
      end)
      |> List.last()

    case acquire_index do
      nil ->
        false

      {_acquire, index} ->
        case Enum.at(timeline.acquires, index + 1) do
          nil ->
            false

          %{op_id: next_op} ->
            not MapSet.member?(Map.get(ancestors, next_op, MapSet.new()), op.id)
        end
    end
  end

  defp role_event(%Op{kind: :authority, body: body} = op, role, index) do
    case body do
      {:genesis, %Delegation{} = delegation, _policies} ->
        if DelegationIndex.valid_intro?(index, delegation, op.id) and
             MapSet.member?(delegation.roles, role),
           do: {:genesis, delegation}

      {:transfer, ^role, %Delegation{} = delegation, tick} ->
        if DelegationIndex.valid_intro?(index, delegation, op.id),
          do: {:transfer, delegation, tick}

      {:succeed, ^role, %Delegation{} = delegation, tick} ->
        if DelegationIndex.valid_intro?(index, delegation, op.id),
          do: {:succeed, delegation, tick}

      {:heartbeat, ^role, tick} ->
        {:heartbeat, tick}

      _ ->
        nil
    end
  end

  defp role_event(_op, _role, _index), do: nil

  defp record_acquire(timeline, op, new_holder, at_tick) do
    %{
      timeline
      | holder: new_holder,
        acquires: timeline.acquires ++ [%{op_id: op.id, holder: new_holder, at_tick: at_tick}],
        decided:
          Map.put(timeline.decided, op.id, %{
            type: :acquire,
            holder: new_holder,
            at_tick: at_tick
          })
    }
  end

  defp decide_transfer(timeline, op, role, delegation, at_tick, ancestors, index) do
    op_ancestors = Map.get(ancestors, op.id, MapSet.new())
    holder_at_deps = holder_at(timeline, op_ancestors)

    cond do
      index.validity[delegation.id] != :ok or op.author != delegation.issuer or
          not MapSet.member?(delegation.roles, role) ->
        reject(timeline, op, :invalid_transfer, role)

      holder_at_deps != op.author ->
        reject(timeline, op, :transfer_not_holder, role)

      timeline.holder != op.author ->
        reject(timeline, op, :double_transfer, role)

      true ->
        record_acquire(timeline, op, delegation.audience, at_tick)
    end
  end

  defp decide_succeed(timeline, op, role, delegation, at_tick, ancestors, index) do
    op_ancestors = Map.get(ancestors, op.id, MapSet.new())
    last_active = last_active_from(timeline.acquires, timeline.heartbeats, op_ancestors)
    policy = Map.get(index.policies, role)

    cond do
      index.validity[delegation.id] != :ok or op.author != delegation.audience or
        op.author != delegation.issuer or not MapSet.member?(delegation.roles, role) ->
        reject(timeline, op, :invalid_succession, role)

      is_nil(policy) or op.author != policy.successor ->
        reject(timeline, op, :unauthorized_succession, role)

      at_tick < last_active + policy.dormant_ticks ->
        reject(timeline, op, :premature_succession, role)

      true ->
        record_acquire(timeline, op, delegation.audience, at_tick)
    end
  end

  defp decide_heartbeat(timeline, op, at_tick, ancestors) do
    op_ancestors = Map.get(ancestors, op.id, MapSet.new())
    holder_at_deps = holder_at(timeline, op_ancestors)

    if op.author == holder_at_deps do
      %{
        timeline
        | heartbeats: [%{op_id: op.id, at_tick: at_tick} | timeline.heartbeats],
          decided: Map.put(timeline.decided, op.id, %{type: :heartbeat, at_tick: at_tick})
      }
    else
      timeline
    end
  end

  defp reject(timeline, op, reason, role) do
    %{
      timeline
      | quarantine: Map.put(timeline.quarantine, op.id, reason),
        audit:
          timeline.audit ++
            [%{event: :authority_quarantine, op: op.id, reason: reason, role: role}]
    }
  end

  defp last_active_from(acquires, heartbeats, ancestors) do
    ticks =
      for event <- acquires ++ heartbeats,
          MapSet.member?(ancestors, event.op_id),
          do: event.at_tick

    Enum.max([0 | ticks])
  end
end
