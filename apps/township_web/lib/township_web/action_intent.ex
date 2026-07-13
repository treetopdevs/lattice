defmodule TownshipWeb.ActionIntent do
  @moduledoc """
  Produces custody-free action requests for review in a participant's Township app.

  An action intent is public, unsigned input. It carries no operation dependencies,
  capability evidence, signer identity, or authority claim.
  """

  @max_replica_bytes 1_024
  @max_text_bytes 4_096
  @max_member_bytes 4_096
  @resident_grant_ops ["admit", "post", "set_summary", "set_title"]
  @intent_id_regex ~r/\A[0-9a-f]{32}\z/
  @ascii_edge_whitespace ~r/\A[\x09-\x0D\x20]+|[\x09-\x0D\x20]+\z/u

  @spec post_url(String.t(), String.t(), keyword()) ::
          {:ok, String.t()}
          | {:error, :invalid_replica | :invalid_text | :text_too_large | :invalid_intent_id}
  def post_url(replica, text, opts \\ []) do
    intent_id = Keyword.get_lazy(opts, :intent_id, &new_intent_id/0)

    with {:ok, replica} <- normalize_replica(replica),
         {:ok, text} <- normalize_text(text),
         :ok <- validate_intent_id(intent_id) do
      payload =
        Jason.OrderedObject.new([
          {"v", 1},
          {"id", intent_id},
          {"replica", replica},
          {"command",
           Jason.OrderedObject.new([
             {"command", "post"},
             {"text", text}
           ])}
        ])

      encoded = payload |> Jason.encode!() |> Base.url_encode64(padding: false)
      {:ok, "township://action?intent=#{encoded}"}
    end
  end

  @spec status_url(String.t(), :close_matter | :reopen_matter, keyword()) ::
          {:ok, String.t()}
          | {:error, :invalid_replica | :invalid_command | :invalid_intent_id}
  def status_url(replica, command, opts \\ []) do
    intent_id = Keyword.get_lazy(opts, :intent_id, &new_intent_id/0)

    with {:ok, replica} <- normalize_replica(replica),
         {:ok, command} <- normalize_status_command(command),
         :ok <- validate_intent_id(intent_id) do
      payload =
        Jason.OrderedObject.new([
          {"v", 2},
          {"id", intent_id},
          {"replica", replica},
          {"command", Jason.OrderedObject.new([{"command", command}])}
        ])

      encoded = payload |> Jason.encode!() |> Base.url_encode64(padding: false)
      {:ok, "township://action?intent=#{encoded}"}
    end
  end

  @spec field_url(String.t(), :set_title | :set_summary, String.t(), keyword()) ::
          {:ok, String.t()}
          | {:error,
             :invalid_replica
             | :invalid_command
             | :invalid_text
             | :text_too_large
             | :invalid_intent_id}
  def field_url(replica, command, text, opts \\ []) do
    intent_id = Keyword.get_lazy(opts, :intent_id, &new_intent_id/0)

    with {:ok, replica} <- normalize_replica(replica),
         {:ok, command} <- normalize_field_command(command),
         {:ok, text} <- normalize_text(text),
         :ok <- validate_intent_id(intent_id) do
      payload =
        Jason.OrderedObject.new([
          {"v", 3},
          {"id", intent_id},
          {"replica", replica},
          {"command",
           Jason.OrderedObject.new([
             {"command", command},
             {"text", text}
           ])}
        ])

      encoded = payload |> Jason.encode!() |> Base.url_encode64(padding: false)
      {:ok, "township://action?intent=#{encoded}"}
    end
  end

  @spec roster_url(String.t(), :admit | :remove_member, String.t(), keyword()) ::
          {:ok, String.t()}
          | {:error,
             :invalid_replica
             | :invalid_command
             | :invalid_member
             | :member_too_large
             | :invalid_intent_id}
  def roster_url(replica, command, member, opts \\ []) do
    intent_id = Keyword.get_lazy(opts, :intent_id, &new_intent_id/0)

    with {:ok, replica} <- normalize_replica(replica),
         {:ok, command} <- normalize_roster_command(command),
         {:ok, member} <- normalize_member(member),
         :ok <- validate_intent_id(intent_id) do
      payload =
        Jason.OrderedObject.new([
          {"v", 4},
          {"id", intent_id},
          {"replica", replica},
          {"command",
           Jason.OrderedObject.new([
             {"command", command},
             {"member", member}
           ])}
        ])

      encoded = payload |> Jason.encode!() |> Base.url_encode64(padding: false)
      {:ok, "township://action?intent=#{encoded}"}
    end
  end

  @spec grant_url(String.t(), String.t(), keyword()) ::
          {:ok, String.t()}
          | {:error, :invalid_replica | :invalid_audience | :invalid_intent_id}
  def grant_url(replica, audience, opts \\ []) do
    intent_id = Keyword.get_lazy(opts, :intent_id, &new_intent_id/0)

    with {:ok, replica} <- normalize_replica(replica),
         {:ok, audience} <- normalize_audience(audience),
         :ok <- validate_intent_id(intent_id) do
      payload =
        Jason.OrderedObject.new([
          {"v", 5},
          {"id", intent_id},
          {"replica", replica},
          {"authority",
           Jason.OrderedObject.new([
             {"action", "grant"},
             {"audience", audience},
             {"ops", @resident_grant_ops},
             {"roles", []},
             {"live", false}
           ])}
        ])

      encoded = payload |> Jason.encode!() |> Base.url_encode64(padding: false)
      {:ok, "township://action?intent=#{encoded}"}
    end
  end

  defp normalize_replica(replica) when is_binary(replica) do
    if String.valid?(replica) do
      replica = trim_ascii_edges(replica)

      if replica != "" and byte_size(replica) <= @max_replica_bytes do
        {:ok, replica}
      else
        {:error, :invalid_replica}
      end
    else
      {:error, :invalid_replica}
    end
  end

  defp normalize_replica(_replica), do: {:error, :invalid_replica}

  defp normalize_text(text) when is_binary(text) do
    if String.valid?(text) do
      text = trim_ascii_edges(text)

      cond do
        text == "" -> {:error, :invalid_text}
        byte_size(text) > @max_text_bytes -> {:error, :text_too_large}
        true -> {:ok, text}
      end
    else
      {:error, :invalid_text}
    end
  end

  defp normalize_text(_text), do: {:error, :invalid_text}

  defp normalize_member(member) when is_binary(member) do
    if String.valid?(member) do
      member = trim_ascii_edges(member)

      cond do
        member == "" -> {:error, :invalid_member}
        byte_size(member) > @max_member_bytes -> {:error, :member_too_large}
        true -> {:ok, member}
      end
    else
      {:error, :invalid_member}
    end
  end

  defp normalize_member(_member), do: {:error, :invalid_member}

  defp normalize_audience(audience) when is_binary(audience) do
    if String.valid?(audience) do
      audience = trim_ascii_edges(audience)

      with {:ok, public_key} <- Base.decode64(audience, padding: true),
           32 <- byte_size(public_key),
           ^audience <- Base.encode64(public_key) do
        {:ok, audience}
      else
        _invalid -> {:error, :invalid_audience}
      end
    else
      {:error, :invalid_audience}
    end
  end

  defp normalize_audience(_audience), do: {:error, :invalid_audience}

  defp normalize_status_command(:close_matter), do: {:ok, "close_matter"}
  defp normalize_status_command(:reopen_matter), do: {:ok, "reopen_matter"}
  defp normalize_status_command(_command), do: {:error, :invalid_command}

  defp normalize_field_command(:set_title), do: {:ok, "set_title"}
  defp normalize_field_command(:set_summary), do: {:ok, "set_summary"}
  defp normalize_field_command(_command), do: {:error, :invalid_command}

  defp normalize_roster_command(:admit), do: {:ok, "admit"}
  defp normalize_roster_command(:remove_member), do: {:ok, "remove_member"}
  defp normalize_roster_command(_command), do: {:error, :invalid_command}

  defp validate_intent_id(intent_id) when is_binary(intent_id) do
    if Regex.match?(@intent_id_regex, intent_id), do: :ok, else: {:error, :invalid_intent_id}
  end

  defp validate_intent_id(_intent_id), do: {:error, :invalid_intent_id}

  defp trim_ascii_edges(value), do: Regex.replace(@ascii_edge_whitespace, value, "")

  defp new_intent_id do
    16
    |> :crypto.strong_rand_bytes()
    |> Base.encode16(case: :lower)
  end
end
