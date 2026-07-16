defmodule Township.Election.Spec do
  @moduledoc """
  Versioned, immutable public configuration for a Township election.

  The canonical form contains only `Lattice.Canonical` primitive terms and never
  contains an election id. The id is derived later from this spec's digest and an
  honored Matter-link op id.
  """

  alias Lattice.Canonical
  alias Township.Election.ProfileRef

  @schema "township-election-v1"
  @digest_domain "township-election-spec-v1"
  @fields [
    :schema,
    :subject,
    :question_digest,
    :choices,
    :profile,
    :supervisor,
    :registration_tellers,
    :ballot_boxes,
    :close_policy,
    :trustees,
    :max_corrupt_trustees,
    :tally_share_quorum,
    :result_policy,
    :domain
  ]

  @enforce_keys @fields
  defstruct @fields

  @type public_key :: binary()
  @type t :: %__MODULE__{
          schema: String.t(),
          subject: String.t(),
          question_digest: String.t(),
          choices: [term()],
          profile: ProfileRef.t(),
          supervisor: public_key(),
          registration_tellers: [public_key()],
          ballot_boxes: [public_key()],
          close_policy: map(),
          trustees: [public_key()],
          max_corrupt_trustees: non_neg_integer(),
          tally_share_quorum: pos_integer(),
          result_policy: term(),
          domain: String.t()
        }

  @spec new(map()) :: {:ok, t()} | {:error, atom()}
  def new(attrs) when is_map(attrs) do
    attrs = Map.put_new(attrs, :schema, @schema)

    with :ok <- validate_known_fields(attrs),
         :ok <- validate_schema(attrs.schema),
         :ok <- validate_binary(attrs.subject, :invalid_subject),
         :ok <- validate_binary(attrs.question_digest, :invalid_question_digest),
         :ok <- validate_choices(attrs.choices),
         {:ok, profile} <- ProfileRef.new(attrs.profile),
         :ok <- validate_public_key(attrs.supervisor),
         :ok <- validate_role_keys(attrs.registration_tellers),
         :ok <- validate_role_keys(attrs.ballot_boxes),
         :ok <- validate_close_policy(attrs.close_policy),
         :ok <- validate_role_keys(attrs.trustees),
         :ok <- validate_thresholds(attrs),
         :ok <- validate_canonical(attrs.result_policy),
         :ok <- validate_binary(attrs.domain, :invalid_domain) do
      {:ok, struct!(__MODULE__, Map.put(attrs, :profile, profile))}
    end
  rescue
    KeyError -> {:error, :missing_spec_field}
  end

  def new(_attrs), do: {:error, :invalid_election_spec}

  @spec schema() :: String.t()
  def schema, do: @schema

  @spec digest(t()) :: String.t()
  def digest(%__MODULE__{} = spec) do
    [@digest_domain, to_canonical_term(spec)]
    |> Canonical.term()
    |> hash()
  end

  @spec to_canonical_term(t()) :: map()
  def to_canonical_term(%__MODULE__{} = spec) do
    %{
      "schema" => spec.schema,
      "subject" => spec.subject,
      "question_digest" => spec.question_digest,
      "choices" => spec.choices,
      "profile" => ProfileRef.to_canonical_term(spec.profile),
      "supervisor" => spec.supervisor,
      "registration_tellers" => spec.registration_tellers,
      "ballot_boxes" => spec.ballot_boxes,
      "close_policy" => spec.close_policy,
      "trustees" => spec.trustees,
      "max_corrupt_trustees" => spec.max_corrupt_trustees,
      "tally_share_quorum" => spec.tally_share_quorum,
      "result_policy" => spec.result_policy,
      "domain" => spec.domain
    }
  end

  defp validate_known_fields(attrs) do
    if Map.keys(attrs) |> Enum.all?(&(&1 in @fields)),
      do: :ok,
      else: {:error, :unknown_spec_field}
  end

  defp validate_schema(@schema), do: :ok
  defp validate_schema(_schema), do: {:error, :unsupported_schema}

  defp validate_binary(value, _reason) when is_binary(value) and byte_size(value) > 0, do: :ok
  defp validate_binary(_value, reason), do: {:error, reason}

  defp validate_choices(choices) when is_list(choices) and choices != [] do
    if proper_list?(choices),
      do: validate_choice_values(choices),
      else: {:error, :noncanonical_spec}
  end

  defp validate_choices(_choices), do: {:error, :invalid_choices}

  defp validate_choice_values(choices) do
    with :ok <- validate_canonical(choices) do
      encoded = Enum.map(choices, &Canonical.term/1)
      if Enum.uniq(encoded) == encoded, do: :ok, else: {:error, :duplicate_choice}
    end
  end

  defp validate_public_key(key) when is_binary(key) and byte_size(key) > 0, do: :ok
  defp validate_public_key(_key), do: {:error, :invalid_role_key}

  defp validate_role_keys(keys) when is_list(keys) and keys != [] do
    cond do
      not proper_list?(keys) -> {:error, :invalid_role_key}
      not Enum.all?(keys, &(validate_public_key(&1) == :ok)) -> {:error, :invalid_role_key}
      Enum.uniq(keys) != keys -> {:error, :duplicate_role_key}
      true -> :ok
    end
  end

  defp validate_role_keys(_keys), do: {:error, :invalid_role_key}

  defp validate_close_policy(
         %{id: :unanimous_boxes_v1, members: :ballot_boxes, quorum: :all} = policy
       )
       when map_size(policy) == 3,
       do: :ok

  defp validate_close_policy(_policy), do: {:error, :unsupported_close_policy}

  defp validate_thresholds(attrs) do
    trustee_count = length(attrs.trustees)
    corrupt = attrs.max_corrupt_trustees
    quorum = attrs.tally_share_quorum

    cond do
      not is_integer(corrupt) or corrupt < 0 or corrupt >= trustee_count ->
        {:error, :corruption_bound_out_of_range}

      not is_integer(quorum) or quorum < 1 or quorum > trustee_count ->
        {:error, :tally_share_quorum_out_of_range}

      true ->
        :ok
    end
  end

  defp validate_canonical(value) do
    if Canonical.signable?(value), do: :ok, else: {:error, :noncanonical_spec}
  rescue
    _ -> {:error, :noncanonical_spec}
  end

  defp proper_list?([]), do: true
  defp proper_list?([_head | tail]), do: proper_list?(tail)
  defp proper_list?(_other), do: false

  defp hash(bytes), do: :sha256 |> :crypto.hash(bytes) |> Base.url_encode64(padding: false)
end
