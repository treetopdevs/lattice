defmodule Lattice.Cap.Attenuation do
  @moduledoc """
  Monotonic attenuation for PID-as-capability grants.

  A child capability may narrow target, operations, use count, expiration,
  payload caveats, schema, and session protocol. It may not widen any parent
  authority.
  """

  alias Lattice.Cap
  alias Lattice.Cap.Caveat

  def derive(%Cap{} = parent, child_owner_tab_id, opts) do
    with :ok <- parent_delegates?(parent),
         {:ok, ops} <- child_ops(parent, Keyword.get(opts, :ops, MapSet.to_list(parent.ops))),
         {:ok, target} <- child_target(parent, Keyword.get(opts, :target, parent.target)),
         {:ok, expires_at, ttl_ms} <- child_expiry(parent, opts),
         {:ok, use_limit} <-
           child_use_limit(parent, Keyword.get(opts, :use_limit, parent.use_limit)),
         child_caveats <- Caveat.from_opts(opts),
         :ok <- caveats_monotonic?(parent.caveats, child_caveats),
         schema <- Keyword.get(opts, :schema, parent.schema),
         session <- Keyword.get(opts, :session, parent.session) do
      {:ok,
       Cap.new(child_owner_tab_id, target, MapSet.to_list(ops),
         id: Keyword.get(opts, :id),
         issuer: Keyword.get(opts, :issuer, {:delegated, parent.id}),
         parent_id: parent.id,
         root_id: parent.root_id || parent.id,
         expires_at: expires_at,
         ttl_ms: ttl_ms,
         use_limit: use_limit,
         caveats: parent.caveats ++ child_caveats,
         delegation_allowed?: Keyword.get(opts, :delegation_allowed?, false),
         provenance: provenance(parent, child_owner_tab_id, opts),
         schema: schema,
         session: session,
         audit: Map.merge(parent.audit, Keyword.get(opts, :audit, %{}))
       )}
    end
  end

  def subset?(%Cap{} = child, %Cap{} = parent) do
    with {:ok, _ops} <- child_ops(parent, MapSet.to_list(child.ops)),
         {:ok, _target} <- child_target(parent, child.target),
         {:ok, _expires_at, _ttl_ms} <- child_expiry(parent, expires_at: child.expires_at),
         {:ok, _use_limit} <- child_use_limit(parent, child.use_limit),
         :ok <- caveats_monotonic?(parent.caveats, child.caveats) do
      true
    else
      _ -> false
    end
  end

  defp parent_delegates?(%Cap{delegation_allowed?: true}), do: :ok

  defp parent_delegates?(%Cap{caveats: caveats}) do
    if :allowed in Caveat.values(caveats, :delegation) do
      :ok
    else
      {:error, :delegation_forbidden}
    end
  end

  defp child_ops(parent, ops) do
    child = Cap.normalize_ops(ops)

    if MapSet.subset?(child, parent.ops) do
      {:ok, child}
    else
      {:error, :authority_escalation}
    end
  end

  defp child_target(parent, target) do
    if target == parent.target do
      {:ok, target}
    else
      {:error, :target_escalation}
    end
  end

  defp child_expiry(parent, opts) do
    ttl_ms = Keyword.get(opts, :ttl_ms) || Keyword.get(opts, :ttl)

    requested =
      Keyword.get(opts, :expires_at) ||
        if(ttl_ms, do: System.monotonic_time(:millisecond) + ttl_ms)

    cond do
      is_nil(parent.expires_at) ->
        {:ok, requested, ttl_ms}

      is_nil(requested) ->
        {:ok, parent.expires_at, ttl_ms}

      requested <= parent.expires_at ->
        {:ok, requested, ttl_ms}

      true ->
        {:error, :expiry_escalation}
    end
  end

  defp child_use_limit(_parent, nil), do: {:ok, nil}
  defp child_use_limit(%Cap{use_limit: nil}, use_limit), do: {:ok, use_limit}

  defp child_use_limit(%Cap{use_limit: parent_limit}, child_limit)
       when child_limit <= parent_limit,
       do: {:ok, child_limit}

  defp child_use_limit(_parent, _child_limit), do: {:error, :use_limit_escalation}

  defp caveats_monotonic?(parent_caveats, child_caveats) do
    all = parent_caveats ++ child_caveats

    with :ok <- number_monotonic?(parent_caveats, all, :amount_max),
         :ok <- symbol_monotonic?(parent_caveats, all, :vendor),
         :ok <- symbol_monotonic?(parent_caveats, all, :provenance_label),
         :ok <- confirmation_monotonic?(parent_caveats, all),
         :ok <- delegation_monotonic?(parent_caveats, all) do
      :ok
    end
  end

  defp number_monotonic?(parent, child, type) do
    parent_value = Caveat.strongest_number(parent, type)
    child_value = Caveat.strongest_number(child, type)

    cond do
      is_nil(parent_value) -> :ok
      is_number(child_value) and child_value <= parent_value -> :ok
      true -> {:error, :caveat_escalation}
    end
  end

  defp symbol_monotonic?(parent, child, type) do
    parent_value = Caveat.strongest_symbol(parent, type)
    child_value = Caveat.strongest_symbol(child, type)

    cond do
      is_nil(parent_value) -> :ok
      child_value == parent_value -> :ok
      true -> {:error, :caveat_escalation}
    end
  end

  defp confirmation_monotonic?(parent, child) do
    if Caveat.has?(parent, :requires_confirmation) and
         not Caveat.has?(child, :requires_confirmation) do
      {:error, :caveat_escalation}
    else
      :ok
    end
  end

  defp delegation_monotonic?(parent, child) do
    parent_forbids? = :forbidden in Caveat.values(parent, :delegation)
    child_allows? = :allowed in Caveat.values(child, :delegation)

    if parent_forbids? and child_allows?, do: {:error, :delegation_forbidden}, else: :ok
  end

  defp provenance(parent, child_owner_tab_id, opts) do
    parent.provenance ++
      [
        %{
          "parent_id" => parent.id,
          "root_id" => parent.root_id || parent.id,
          "from_tab_id" => parent.owner_tab_id,
          "to_tab_id" => child_owner_tab_id,
          "label" => Keyword.get(opts, :provenance_label),
          "at" => System.monotonic_time(:millisecond)
        }
      ]
  end
end
