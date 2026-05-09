defmodule Lattice.CapStore do
  @moduledoc """
  Owns capability grants, revocations, lookup, expiry, use limits, and owner checks.
  """

  use GenServer

  alias Lattice.{Audit, Cap, Topology}

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def grant(tab_id, target, ops, opts \\ []) do
    GenServer.call(__MODULE__, {:grant, tab_id, target, ops, opts})
  end

  def revoke(cap_or_id, reason \\ :manual) do
    with {:ok, cap_id} <- Cap.safe_token(cap_or_id) do
      GenServer.call(__MODULE__, {:revoke, cap_id, reason})
    else
      {:error, reason} ->
        Audit.record(:deny, %{reason: reason, op: :revoke})
        {:error, reason}
    end
  end

  def revoke_tab(tab_id, reason \\ :tab_closed) do
    GenServer.call(__MODULE__, {:revoke_tab, tab_id, reason})
  end

  def authorize(tab_id, cap_or_id, op) do
    with {:ok, cap_id} <- Cap.safe_token(cap_or_id) do
      GenServer.call(__MODULE__, {:authorize, tab_id, cap_id, Cap.normalize_op(op)})
    else
      {:error, reason} ->
        Audit.record(:deny, %{tab_id: tab_id, op: op, reason: reason})
        {:error, reason}
    end
  end

  def get(cap_or_id) do
    with {:ok, cap_id} <- Cap.safe_token(cap_or_id) do
      GenServer.call(__MODULE__, {:get, cap_id})
    end
  end

  def snapshot, do: GenServer.call(__MODULE__, :snapshot)
  def reset, do: GenServer.call(__MODULE__, :reset)

  @impl true
  def init(_opts), do: {:ok, %{caps: %{}}}

  @impl true
  def handle_call({:grant, tab_id, target, ops, opts}, _from, state) do
    if Topology.tab_connected?(tab_id) do
      cap = Cap.new(tab_id, target, ops, opts)

      if Map.has_key?(state.caps, cap.id) do
        Audit.record(:deny, %{
          tab_id: tab_id,
          cap_id: cap.id,
          target: inspect_target(target),
          reason: :cap_id_collision
        })

        {:reply, {:error, :cap_id_collision}, state}
      else
        Audit.record(:grant, %{
          tab_id: tab_id,
          cap_id: cap.id,
          target: inspect_target(target),
          ops: MapSet.to_list(cap.ops)
        })

        Topology.register_cap(tab_id, cap.id)
        {:reply, {:ok, cap}, put_in(state, [:caps, cap.id], cap)}
      end
    else
      Audit.record(:deny, %{
        tab_id: tab_id,
        reason: :grant_to_unknown_or_disconnected_tab,
        target: inspect_target(target)
      })

      {:reply, {:error, :tab_not_connected}, state}
    end
  end

  def handle_call({:revoke, cap_id, reason}, _from, state) do
    case Map.fetch(state.caps, cap_id) do
      {:ok, cap} ->
        revoked = Cap.revoke(cap, reason)

        Audit.record(:revoke, %{tab_id: cap.owner_tab_id, cap_id: cap_id, reason: inspect(reason)})

        {:reply, :ok, put_in(state, [:caps, cap_id], revoked)}

      :error ->
        Audit.record(:deny, %{cap_id: cap_id, reason: :revoke_unknown_cap})
        {:reply, {:error, :unknown_cap}, state}
    end
  end

  def handle_call({:revoke_tab, tab_id, reason}, _from, state) do
    {caps, revoked_ids} =
      Enum.reduce(state.caps, {%{}, []}, fn
        {id, %Cap{owner_tab_id: ^tab_id} = cap}, {caps, ids} ->
          revoked = Cap.revoke(cap, reason)
          {Map.put(caps, id, revoked), [id | ids]}

        {id, cap}, {caps, ids} ->
          {Map.put(caps, id, cap), ids}
      end)

    Enum.each(revoked_ids, fn cap_id ->
      Audit.record(:revoke, %{tab_id: tab_id, cap_id: cap_id, reason: inspect(reason)})
    end)

    {:reply, :ok, %{state | caps: caps}}
  end

  def handle_call({:authorize, tab_id, cap_id, op}, _from, state) do
    case Map.fetch(state.caps, cap_id) do
      {:ok, cap} ->
        case check_cap(cap, tab_id, op) do
          :ok ->
            used = %{cap | uses: cap.uses + 1}

            Audit.record(:cap_use, %{
              tab_id: tab_id,
              cap_id: cap_id,
              op: op,
              target: inspect_target(cap.target)
            })

            {:reply, {:ok, used}, put_in(state, [:caps, cap_id], used)}

          {:error, reason, event_type} ->
            Audit.record(event_type, %{
              tab_id: tab_id,
              owner_tab_id: cap.owner_tab_id,
              cap_id: cap_id,
              op: op,
              reason: reason
            })

            {:reply, {:error, reason}, state}
        end

      :error ->
        Audit.record(:deny, %{tab_id: tab_id, cap_id: cap_id, op: op, reason: :unknown_cap})
        {:reply, {:error, :unknown_cap}, state}
    end
  end

  def handle_call({:get, cap_id}, _from, state) do
    {:reply, Map.fetch(state.caps, cap_id), state}
  end

  def handle_call(:snapshot, _from, state) do
    active_caps =
      state.caps
      |> Enum.reject(fn {_id, cap} ->
        cap.revoked? or Cap.expired?(cap) or Cap.use_limited?(cap)
      end)
      |> Map.new()

    {:reply, %{caps: state.caps, active_caps: active_caps}, state}
  end

  def handle_call(:reset, _from, _state), do: {:reply, :ok, %{caps: %{}}}

  defp check_cap(%Cap{owner_tab_id: owner}, tab_id, _op) when owner != tab_id,
    do: {:error, :wrong_owner, :deny}

  defp check_cap(%Cap{revoked?: true}, _tab_id, _op), do: {:error, :revoked, :deny}

  defp check_cap(%Cap{} = cap, _tab_id, op) do
    cond do
      Cap.expired?(cap) ->
        {:error, :expired, :expired_cap}

      Cap.use_limited?(cap) ->
        {:error, :use_limit_exceeded, :use_limit_exceeded}

      MapSet.member?(cap.ops, op) ->
        :ok

      true ->
        {:error, :operation_not_allowed, :deny}
    end
  end

  defp inspect_target({:server_pid, pid}), do: inspect(pid)
  defp inspect_target({:server_name, name}), do: Atom.to_string(name)
  defp inspect_target({:tab, tab_id}), do: "tab:" <> tab_id
  defp inspect_target(other), do: inspect(other)
end
