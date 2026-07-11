defmodule Lattice.Authority.DelegationIndex do
  @moduledoc false

  alias Lattice.Authority.Delegation
  alias Lattice.{Identity, Op}

  @enforce_keys [
    :entries,
    :validity,
    :policies,
    :root,
    :revokes,
    :invalid_ops,
    :unauthorized_revokes
  ]
  defstruct @enforce_keys

  @type entry :: %{
          required(:deleg) => Delegation.t() | nil,
          required(:op_ids) => [Op.id()],
          required(:invalid_ops) => %{Op.id() => atom()}
        }
  @type revoke :: %{required(:op_id) => Op.id(), required(:deleg_id) => String.t()}
  @type t :: %__MODULE__{
          entries: %{String.t() => entry()},
          validity: %{String.t() => :ok | {:error, atom()}},
          policies: map(),
          root: Identity.pubkey() | nil,
          revokes: [revoke()],
          invalid_ops: %{Op.id() => atom()},
          unauthorized_revokes: %{Op.id() => :unauthorized_revoke}
        }

  @doc false
  @spec build([Op.t()], String.t() | nil) :: t()
  def build(ordered, commitment) when is_list(ordered) do
    genesis_ids = genesis_delegation_ids(ordered)
    entries = collect(ordered)
    validity = validate(entries, commitment, genesis_ids)
    policies = collect_policies(ordered, entries, validity)
    root = resolve_root(ordered, entries, validity, commitment)

    %__MODULE__{
      entries: entries,
      validity: validity,
      policies: policies,
      root: root,
      revokes: collect_revokes(ordered, entries, root),
      invalid_ops: invalid_delegation_ops(entries, validity),
      unauthorized_revokes: unauthorized_revokes(ordered, entries, root)
    }
  end

  @doc false
  @spec active?(t(), String.t()) :: boolean()
  def active?(%__MODULE__{validity: validity}, delegation_id),
    do: Map.get(validity, delegation_id) == :ok

  @doc false
  @spec revoked?(t(), String.t()) :: boolean()
  def revoked?(%__MODULE__{revokes: revokes}, delegation_id),
    do: Enum.any?(revokes, &(&1.deleg_id == delegation_id))

  @doc false
  @spec valid_intro?(t(), Delegation.t(), Op.id()) :: boolean()
  def valid_intro?(%__MODULE__{entries: entries}, %Delegation{id: id}, op_id) do
    case Map.fetch(entries, id) do
      {:ok, %{op_ids: op_ids}} -> op_id in op_ids
      :error -> false
    end
  end

  @doc false
  @spec chain_ids(t(), Delegation.t()) :: [String.t()]
  def chain_ids(%__MODULE__{entries: entries} = index, %Delegation{} = delegation) do
    case delegation.parent_id && Map.fetch(entries, delegation.parent_id) do
      {:ok, %{deleg: %Delegation{} = parent}} ->
        [delegation.id | chain_ids(index, parent)]

      _ ->
        [delegation.id]
    end
  end

  @doc false
  @spec root_tag(Identity.pubkey()) :: String.t()
  def root_tag(pub) when is_binary(pub) do
    :crypto.hash(:sha256, pub) |> Base.url_encode64(padding: false)
  end

  @doc false
  @spec root_matches?(String.t() | nil, Identity.pubkey()) :: boolean()
  def root_matches?(nil, _audience), do: true
  def root_matches?(commitment, audience), do: root_tag(audience) == commitment

  defp genesis_delegation_ids(ordered) do
    for op <- ordered, match?({:genesis, %Delegation{}, _}, op.body), into: MapSet.new() do
      {:genesis, %Delegation{id: id}, _} = op.body
      id
    end
  end

  defp collect(ordered) do
    Enum.reduce(ordered, %{}, fn op, acc ->
      case delegation_in(op) do
        nil -> acc
        %Delegation{} = delegation -> collect_intro(acc, delegation, op.id)
      end
    end)
  end

  defp collect_intro(acc, %Delegation{} = delegation, op_id) do
    if Delegation.valid_sig?(delegation) do
      collect_valid_intro(acc, delegation, op_id)
    else
      collect_invalid_intro(acc, delegation, op_id)
    end
  end

  defp collect_valid_intro(acc, %Delegation{} = delegation, op_id) do
    Map.update(
      acc,
      delegation.id,
      %{deleg: delegation, op_ids: [op_id], invalid_ops: %{}},
      fn entry ->
        %{entry | deleg: entry.deleg || delegation, op_ids: [op_id | entry.op_ids]}
      end
    )
  end

  defp collect_invalid_intro(acc, %Delegation{} = delegation, op_id) do
    Map.update(
      acc,
      delegation.id,
      %{deleg: nil, op_ids: [], invalid_ops: %{op_id => :bad_delegation_sig}},
      fn entry ->
        %{entry | invalid_ops: Map.put(entry.invalid_ops, op_id, :bad_delegation_sig)}
      end
    )
  end

  defp delegation_in(%Op{kind: :authority, body: body}) do
    case body do
      {:genesis, %Delegation{} = delegation, _policies} -> delegation
      {:grant, %Delegation{} = delegation} -> delegation
      {:transfer, _role, %Delegation{} = delegation, _tick} -> delegation
      {:succeed, _role, %Delegation{} = delegation, _tick} -> delegation
      _ -> nil
    end
  end

  defp delegation_in(_op), do: nil

  defp collect_policies(ordered, entries, validity) do
    Enum.reduce(ordered, %{}, fn op, acc ->
      case op.body do
        {:genesis, %Delegation{id: id} = delegation, policies} when is_map(policies) ->
          if Map.get(validity, id) == :ok and valid_entry_intro?(entries, delegation, op.id),
            do: Map.merge(acc, policies),
            else: acc

        _ ->
          acc
      end
    end)
  end

  defp validate(entries, commitment, genesis_ids) do
    Map.new(entries, fn
      {id, %{deleg: %Delegation{} = delegation}} ->
        {id, validate_delegation(delegation, entries, commitment, genesis_ids)}

      {id, %{deleg: nil}} ->
        {id, {:error, :bad_delegation_sig}}
    end)
  end

  defp validate_delegation(%Delegation{} = delegation, entries, commitment, genesis_ids) do
    cond do
      not Delegation.valid_sig?(delegation) ->
        {:error, :bad_delegation_sig}

      is_nil(delegation.parent_id) ->
        validate_root_delegation(delegation, commitment, genesis_ids)

      true ->
        validate_parent(delegation, entries, commitment, genesis_ids)
    end
  end

  defp validate_root_delegation(delegation, commitment, genesis_ids) do
    cond do
      delegation.issuer != delegation.audience ->
        {:error, :nongenesis_root}

      MapSet.member?(genesis_ids, delegation.id) and
          not root_matches?(commitment, delegation.audience) ->
        {:error, :impostor_genesis}

      true ->
        :ok
    end
  end

  defp validate_parent(delegation, entries, commitment, genesis_ids) do
    case Map.fetch(entries, delegation.parent_id) do
      {:ok, %{deleg: %Delegation{} = parent}} ->
        cond do
          validate_delegation(parent, entries, commitment, genesis_ids) != :ok ->
            {:error, :invalid_parent}

          not Delegation.attenuates?(delegation, parent) ->
            {:error, :not_attenuated}

          true ->
            :ok
        end

      {:ok, %{deleg: nil}} ->
        {:error, :invalid_parent}

      :error ->
        {:error, :missing_parent}
    end
  end

  defp invalid_delegation_ops(entries, validity) do
    invalid_intros =
      for {_id, %{invalid_ops: invalid_ops}} <- entries,
          {op_id, reason} <- invalid_ops,
          into: %{},
          do: {op_id, reason}

    invalid_canonical =
      for {id, %{op_ids: op_ids}} <- entries,
          validity[id] != :ok,
          op_id <- op_ids,
          into: %{},
          do: {op_id, elem(validity[id], 1)}

    Map.merge(invalid_canonical, invalid_intros)
  end

  defp resolve_root(ordered, entries, validity, commitment) do
    Enum.find_value(ordered, fn op ->
      case op.body do
        {:genesis, %Delegation{id: id, audience: audience} = delegation, _policies} ->
          if Map.get(validity, id) == :ok and root_matches?(commitment, audience) and
               valid_entry_intro?(entries, delegation, op.id),
             do: audience

        _ ->
          nil
      end
    end)
  end

  defp unauthorized_revokes(ordered, entries, root) do
    for %Op{kind: :authority, id: id, body: {:revoke, delegation_id}} = op <- ordered,
        not revoke_authorized?(op, delegation_id, entries, root),
        into: %{},
        do: {id, :unauthorized_revoke}
  end

  defp collect_revokes(ordered, entries, root) do
    for op <- ordered,
        match?({:revoke, _}, op.body),
        {:revoke, delegation_id} = op.body,
        revoke_authorized?(op, delegation_id, entries, root),
        do: %{op_id: op.id, deleg_id: delegation_id}
  end

  defp revoke_authorized?(%Op{author: author}, delegation_id, entries, root) do
    case Map.fetch(entries, delegation_id) do
      {:ok, %{deleg: %Delegation{} = delegation}} ->
        author == delegation.issuer or author == root

      {:ok, %{deleg: nil}} ->
        false

      :error ->
        false
    end
  end

  defp valid_entry_intro?(entries, %Delegation{id: id}, op_id) do
    case Map.fetch(entries, id) do
      {:ok, %{op_ids: op_ids}} -> op_id in op_ids
      :error -> false
    end
  end
end
