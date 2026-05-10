defmodule Lattice.Cap.Caveat do
  @moduledoc """
  Runtime caveats for attenuated Lattice capabilities.

  Caveats are deliberately ordinary data. The gateway can enforce them before
  forwarding, graph policy can inspect them, and demos can serialize the same
  authority shape that tests exercise.
  """

  alias Lattice.Cap.Typed

  @enforce_keys [:type, :value]
  defstruct [:type, :value]

  @type type ::
          :amount_max
          | :vendor
          | :requires_confirmation
          | :provenance_label
          | :delegation
          | :allowed_realm
          | :payload_schema

  @type t :: %__MODULE__{type: type(), value: term()}

  def new(type, value), do: %__MODULE__{type: type, value: value}
  def amount_max(value), do: new(:amount_max, value)
  def vendor(value), do: new(:vendor, normalize_symbol(value))
  def requires_confirmation(value \\ true), do: new(:requires_confirmation, value)
  def provenance_label(value), do: new(:provenance_label, value)
  def delegation(value), do: new(:delegation, value)
  def allowed_realm(value), do: new(:allowed_realm, value)
  def payload_schema(schema), do: new(:payload_schema, schema)

  def from_opts(opts) do
    base = opts |> Keyword.get(:caveats, []) |> Enum.flat_map(&normalize_many/1)

    derived =
      []
      |> maybe_put(:amount_max, Keyword.get(opts, :amount_max))
      |> maybe_put(:vendor, Keyword.get(opts, :vendor))
      |> maybe_put(:requires_confirmation, Keyword.get(opts, :requires_confirmation))
      |> maybe_put(:provenance_label, Keyword.get(opts, :provenance_label))
      |> maybe_put(:delegation, Keyword.get(opts, :delegation))
      |> maybe_put(:allowed_realm, Keyword.get(opts, :allowed_realm))
      |> maybe_put(:payload_schema, Keyword.get(opts, :schema))

    Enum.map(base ++ derived, &normalize/1)
  end

  def normalize(%__MODULE__{} = caveat), do: caveat
  def normalize({:amount_max, value}), do: amount_max(value)
  def normalize({:vendor, value}), do: vendor(value)
  def normalize({:requires_confirmation, value}), do: requires_confirmation(value)
  def normalize({:provenance_label, value}), do: provenance_label(value)
  def normalize({:delegation, value}), do: delegation(value)
  def normalize({:allowed_realm, value}), do: allowed_realm(value)
  def normalize({:payload_schema, value}), do: payload_schema(value)

  def enforce(cap, payload) do
    with :ok <- enforce_schema(cap, payload) do
      cap.caveats
      |> Enum.reduce_while(:ok, fn caveat, :ok ->
        case enforce_one(caveat, payload) do
          :ok -> {:cont, :ok}
          {:error, reason} -> {:halt, {:error, reason}}
        end
      end)
    end
  end

  def values(caveats, type) do
    caveats
    |> Enum.map(&normalize/1)
    |> Enum.filter(&(&1.type == type))
    |> Enum.map(& &1.value)
  end

  def strongest_number(caveats, type) do
    case values(caveats, type) do
      [] -> nil
      values -> Enum.min(values)
    end
  end

  def strongest_symbol(caveats, type) do
    case values(caveats, type) do
      [] -> nil
      [value | _] -> normalize_symbol(value)
    end
  end

  def has?(caveats, type), do: Enum.any?(caveats, &(&1.type == type))

  def external(%__MODULE__{type: type, value: value}) do
    %{"type" => Atom.to_string(type), "value" => external_value(value)}
  end

  defp enforce_schema(%{schema: nil}, _payload), do: :ok
  defp enforce_schema(%{schema: schema}, payload), do: Typed.validate(schema, payload)

  defp enforce_one(%__MODULE__{type: :amount_max, value: max}, payload) do
    case fetch_payload(payload, [:amount, "amount"]) do
      {:ok, amount} when is_number(amount) and amount <= max -> :ok
      {:ok, amount} when is_number(amount) -> {:error, :amount_exceeds_caveat}
      _ -> {:error, :amount_required}
    end
  end

  defp enforce_one(%__MODULE__{type: :vendor, value: expected}, payload) do
    case fetch_payload(payload, [:vendor, "vendor"]) do
      {:ok, vendor} ->
        if normalize_symbol(vendor) == expected, do: :ok, else: {:error, :vendor_not_allowed}

      _ ->
        {:error, :vendor_required}
    end
  end

  defp enforce_one(%__MODULE__{type: :requires_confirmation, value: true}, payload) do
    case fetch_payload(payload, [
           :confirmed?,
           "confirmed?",
           :confirmed,
           "confirmed",
           :confirmation
         ]) do
      {:ok, true} -> :ok
      _ -> {:error, :confirmation_required}
    end
  end

  defp enforce_one(%__MODULE__{type: :requires_confirmation}, _payload), do: :ok

  defp enforce_one(%__MODULE__{type: :provenance_label, value: label}, payload) do
    case fetch_payload(payload, [:provenance_label, "provenance_label"]) do
      {:ok, ^label} ->
        :ok

      {:ok, value} ->
        if normalize_symbol(value) == normalize_symbol(label),
          do: :ok,
          else: {:error, :provenance_label_required}

      _ ->
        {:error, :provenance_label_required}
    end
  end

  defp enforce_one(%__MODULE__{type: :payload_schema}, _payload), do: :ok
  defp enforce_one(%__MODULE__{type: :delegation}, _payload), do: :ok
  defp enforce_one(%__MODULE__{type: :allowed_realm}, _payload), do: :ok

  defp normalize_many(%__MODULE__{} = caveat), do: [caveat]
  defp normalize_many({type, value}), do: [normalize({type, value})]
  defp normalize_many(list) when is_list(list), do: Enum.map(list, &normalize/1)

  defp maybe_put(acc, _type, nil), do: acc
  defp maybe_put(acc, type, value), do: [{type, value} | acc]

  defp fetch_payload(payload, keys) when is_map(payload) do
    Enum.find_value(keys, :error, fn key ->
      if Map.has_key?(payload, key), do: {:ok, Map.fetch!(payload, key)}
    end)
  end

  defp fetch_payload(_payload, _keys), do: :error

  defp normalize_symbol(value) when is_atom(value), do: value
  defp normalize_symbol(value) when is_binary(value), do: String.downcase(value)
  defp normalize_symbol(value), do: value

  defp external_value(%MapSet{} = set), do: MapSet.to_list(set)
  defp external_value(value), do: value
end
