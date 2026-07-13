defmodule TownshipWeb.ActionIntentTest do
  use ExUnit.Case, async: true

  alias TownshipWeb.ActionIntent

  @fixture_path Path.expand(
                  "../../../../clients/township-tauri-shell/test/fixtures/township_action_intent_v1.json",
                  __DIR__
                )

  @status_fixture_path Path.expand(
                         "../../../../clients/township-tauri-shell/test/fixtures/township_status_action_intent_v2.json",
                         __DIR__
                       )

  test "post_url emits the exact custody-free cross-runtime v1 contract" do
    fixture = @fixture_path |> File.read!() |> Jason.decode!()
    payload = fixture["payload"]

    assert {:ok, url} =
             ActionIntent.post_url(payload["replica"], payload["command"]["text"],
               intent_id: payload["id"]
             )

    assert url == fixture["url"]
    assert decoded_payload(url) == payload

    assert Map.keys(payload) |> Enum.sort() == ["command", "id", "replica", "v"]
    assert Map.keys(payload["command"]) |> Enum.sort() == ["command", "text"]

    refute Enum.any?(
             ~w(author cap capability delegation deps key local_realm private_key pubkey sig signature),
             &contains_key?(payload, &1)
           )
  end

  test "post_url trims public values and rejects malformed or oversized input" do
    id = "0123456789abcdef0123456789abcdef"

    assert {:ok, url} =
             ActionIntent.post_url(" replica:matter:one ", " resident update ", intent_id: id)

    assert decoded_payload(url) == %{
             "v" => 1,
             "id" => id,
             "replica" => "replica:matter:one",
             "command" => %{"command" => "post", "text" => "resident update"}
           }

    assert {:ok, unicode_url} =
             ActionIntent.post_url("replica\uFEFF", "\u0085resident update\u0085", intent_id: id)

    assert decoded_payload(unicode_url)["replica"] == "replica\uFEFF"
    assert decoded_payload(unicode_url)["command"]["text"] == "\u0085resident update\u0085"

    assert {:error, :invalid_replica} = ActionIntent.post_url(" ", "update", intent_id: id)
    assert {:error, :invalid_text} = ActionIntent.post_url("replica", " ", intent_id: id)

    assert {:error, :invalid_intent_id} =
             ActionIntent.post_url("replica", "update", intent_id: "not-an-id")

    assert {:error, :text_too_large} =
             ActionIntent.post_url("replica", String.duplicate("x", 4_097), intent_id: id)
  end

  test "status_url emits exact custody-free v2 close and reopen contracts" do
    fixture = @status_fixture_path |> File.read!() |> Jason.decode!()
    payload = fixture["payload"]

    assert {:ok, url} =
             ActionIntent.status_url(payload["replica"], :close_matter, intent_id: payload["id"])

    assert url == fixture["url"]
    assert decoded_payload(url) == payload

    assert {:ok, reopen_url} =
             ActionIntent.status_url(" replica:matter:one ", :reopen_matter,
               intent_id: "0123456789abcdef0123456789abcdef"
             )

    assert decoded_payload(reopen_url) == %{
             "v" => 2,
             "id" => "0123456789abcdef0123456789abcdef",
             "replica" => "replica:matter:one",
             "command" => %{"command" => "reopen_matter"}
           }

    assert {:error, :invalid_command} =
             ActionIntent.status_url("replica", :post,
               intent_id: "0123456789abcdef0123456789abcdef"
             )

    assert {:error, :invalid_replica} =
             ActionIntent.status_url(" ", :close_matter,
               intent_id: "0123456789abcdef0123456789abcdef"
             )

    assert {:error, :invalid_intent_id} =
             ActionIntent.status_url("replica", :close_matter, intent_id: "not-an-id")
  end

  defp decoded_payload(url) do
    %URI{scheme: "township", host: "action", path: nil, query: query, fragment: nil} =
      URI.parse(url)

    %{"intent" => encoded} = URI.decode_query(query)
    {:ok, json} = Base.url_decode64(encoded, padding: false)
    Jason.decode!(json)
  end

  defp contains_key?(value, key) when is_map(value) do
    Map.has_key?(value, key) or Enum.any?(Map.values(value), &contains_key?(&1, key))
  end

  defp contains_key?(value, key) when is_list(value),
    do: Enum.any?(value, &contains_key?(&1, key))

  defp contains_key?(_value, _key), do: false
end
