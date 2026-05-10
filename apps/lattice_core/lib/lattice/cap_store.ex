defmodule Lattice.CapStore do
  @moduledoc """
  Owns capability grants, revocations, lookup, expiry, use limits, and owner checks.
  """

  use GenServer

  alias Lattice.{Audit, Cap, Topology}
  alias Lattice.Cap.{Attenuation, Caveat, Session}

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def grant(tab_id, target, ops, opts \\ []) do
    GenServer.call(__MODULE__, {:grant, tab_id, target, ops, opts})
  end

  def delegate(parent_cap_or_id, to_tab_id, opts \\ []) do
    with {:ok, parent_id} <- Cap.safe_token(parent_cap_or_id) do
      GenServer.call(__MODULE__, {:delegate, parent_id, to_tab_id, opts})
    else
      {:error, reason} ->
        Audit.record(:deny, %{reason: reason, op: :delegate})
        {:error, reason}
    end
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

  def authorize(tab_id, cap_or_id, op, payload \\ %{}) do
    with {:ok, cap_id} <- Cap.safe_token(cap_or_id) do
      GenServer.call(__MODULE__, {:authorize, tab_id, cap_id, Cap.normalize_op(op), payload})
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
          ops: MapSet.to_list(cap.ops),
          caveats: Enum.map(cap.caveats, &Caveat.external/1)
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

  def handle_call({:delegate, parent_id, to_tab_id, opts}, _from, state) do
    with {:ok, parent} <- fetch_live_parent(state, parent_id),
         true <- Topology.tab_connected?(to_tab_id) || {:error, :tab_not_connected},
         {:ok, child} <- Attenuation.derive(parent, to_tab_id, opts),
         :ok <- cap_id_available?(state, child.id) do
      Audit.record(:delegate, %{
        from_tab_id: parent.owner_tab_id,
        to_tab_id: to_tab_id,
        parent_id: parent.id,
        child_id: child.id,
        caveats: Enum.map(child.caveats, &Caveat.external/1)
      })

      Topology.register_cap(to_tab_id, child.id)
      {:reply, {:ok, child}, put_in(state, [:caps, child.id], child)}
    else
      {:error, reason} ->
        Audit.record(:deny, %{
          op: :delegate,
          parent_id: parent_id,
          to_tab_id: to_tab_id,
          reason: reason
        })

        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:revoke, cap_id, reason}, _from, state) do
    case Map.fetch(state.caps, cap_id) do
      {:ok, _cap} ->
        affected_ids = [cap_id | descendant_ids(state.caps, cap_id)]
        caps = revoke_caps(state.caps, affected_ids, reason)

        Enum.each(affected_ids, fn id ->
          revoked_cap = Map.fetch!(caps, id)

          Audit.record(:revoke, %{
            tab_id: revoked_cap.owner_tab_id,
            cap_id: id,
            parent_id: revoked_cap.parent_id,
            root_id: revoked_cap.root_id,
            reason: inspect(reason)
          })
        end)

        {:reply, :ok, %{state | caps: caps}}

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

  def handle_call({:authorize, tab_id, cap_id, op, payload}, _from, state) do
    case Map.fetch(state.caps, cap_id) do
      {:ok, cap} ->
        case check_cap(cap, tab_id, op, payload, state) do
          {:ok, checked_cap} ->
            used = %{checked_cap | uses: checked_cap.uses + 1}

            Audit.record(:cap_use, %{
              tab_id: tab_id,
              cap_id: cap_id,
              op: op,
              target: inspect_target(checked_cap.target),
              session_state: checked_cap.session && checked_cap.session.state
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

  defp fetch_live_parent(state, parent_id) do
    case Map.fetch(state.caps, parent_id) do
      {:ok, %Cap{revoked?: true}} -> {:error, :revoked}
      {:ok, cap} -> if Cap.expired?(cap), do: {:error, :expired}, else: {:ok, cap}
      :error -> {:error, :unknown_cap}
    end
  end

  defp cap_id_available?(state, cap_id) do
    if Map.has_key?(state.caps, cap_id), do: {:error, :cap_id_collision}, else: :ok
  end

  defp check_cap(%Cap{owner_tab_id: owner}, tab_id, _op, _payload, _state) when owner != tab_id,
    do: {:error, :wrong_owner, :deny}

  defp check_cap(%Cap{revoked?: true}, _tab_id, _op, _payload, _state),
    do: {:error, :revoked, :deny}

  defp check_cap(%Cap{} = cap, _tab_id, op, payload, state) do
    with :ok <- parent_chain_live?(cap, state),
         :ok <- base_cap_live?(cap, op),
         :ok <- Caveat.enforce(cap, payload),
         {:ok, session} <- Session.advance(cap.session, payload) do
      {:ok, %{cap | session: session}}
    else
      {:error, reason, event_type} -> {:error, reason, event_type}
      {:error, reason} -> {:error, reason, :deny}
    end
  end

  defp base_cap_live?(%Cap{} = cap, op) do
    cond do
      Cap.expired?(cap) -> {:error, :expired, :expired_cap}
      Cap.use_limited?(cap) -> {:error, :use_limit_exceeded, :use_limit_exceeded}
      MapSet.member?(cap.ops, op) -> :ok
      true -> {:error, :operation_not_allowed, :deny}
    end
  end

  defp parent_chain_live?(%Cap{parent_id: nil}, _state), do: :ok

  defp parent_chain_live?(%Cap{parent_id: parent_id}, state) do
    case Map.fetch(state.caps, parent_id) do
      {:ok, %Cap{revoked?: true}} ->
        {:error, :parent_revoked, :deny}

      {:ok, parent} ->
        if Cap.expired?(parent) do
          {:error, :parent_expired, :expired_cap}
        else
          parent_chain_live?(parent, state)
        end

      :error ->
        {:error, :parent_missing, :deny}
    end
  end

  defp descendant_ids(caps, cap_id) do
    children =
      caps
      |> Enum.filter(fn {_id, cap} -> cap.parent_id == cap_id end)
      |> Enum.map(fn {id, _cap} -> id end)

    children ++ Enum.flat_map(children, &descendant_ids(caps, &1))
  end

  defp revoke_caps(caps, ids, reason) do
    Enum.reduce(ids, caps, fn id, caps ->
      update_in(caps, [id], fn
        nil -> nil
        cap -> Cap.revoke(cap, reason)
      end)
    end)
  end

  defp inspect_target({:server_pid, pid}), do: inspect(pid)
  defp inspect_target({:server_name, name}), do: Atom.to_string(name)
  defp inspect_target({:tab, tab_id}), do: "tab:" <> tab_id
  defp inspect_target(other), do: inspect(other)
end
