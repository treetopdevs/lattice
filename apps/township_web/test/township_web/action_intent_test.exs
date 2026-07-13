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

  @field_fixture_path Path.expand(
                        "../../../../clients/township-tauri-shell/test/fixtures/township_field_action_intent_v3.json",
                        __DIR__
                      )

  @title_fixture_path Path.expand(
                        "../../../../clients/township-tauri-shell/test/fixtures/township_title_action_intent_v3.json",
                        __DIR__
                      )

  @remove_member_fixture_path Path.expand(
                                "../../../../clients/township-tauri-shell/test/fixtures/township_remove_member_action_intent_v4.json",
                                __DIR__
                              )

  @admit_fixture_path Path.expand(
                        "../../../../clients/township-tauri-shell/test/fixtures/township_admit_action_intent_v4.json",
                        __DIR__
                      )

  @grant_fixture_path Path.expand(
                        "../../../../clients/township-tauri-shell/test/fixtures/township_grant_action_intent_v5.json",
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

  test "field_url emits the exact custody-free v3 summary contract" do
    fixture = @field_fixture_path |> File.read!() |> Jason.decode!()
    payload = fixture["payload"]

    assert {:ok, url} =
             ActionIntent.field_url(
               payload["replica"],
               :set_summary,
               payload["command"]["text"],
               intent_id: payload["id"]
             )

    assert url == fixture["url"]
    assert decoded_payload(url) == payload
    assert Map.keys(payload) |> Enum.sort() == ["command", "id", "replica", "v"]
    assert Map.keys(payload["command"]) |> Enum.sort() == ["command", "text"]
  end

  test "field_url bundles title in the same exact v3 contract" do
    fixture = @title_fixture_path |> File.read!() |> Jason.decode!()
    payload = fixture["payload"]

    assert {:ok, url} =
             ActionIntent.field_url(
               payload["replica"],
               :set_title,
               payload["command"]["text"],
               intent_id: payload["id"]
             )

    assert url == fixture["url"]
    assert decoded_payload(url) == payload
  end

  test "roster_url emits the exact custody-free v4 remove-member contract" do
    fixture = @remove_member_fixture_path |> File.read!() |> Jason.decode!()
    payload = fixture["payload"]

    assert {:ok, url} =
             ActionIntent.roster_url(
               payload["replica"],
               :remove_member,
               payload["command"]["member"],
               intent_id: payload["id"]
             )

    assert url == fixture["url"]
    assert decoded_payload(url) == payload
    assert Map.keys(payload) |> Enum.sort() == ["command", "id", "replica", "v"]
    assert Map.keys(payload["command"]) |> Enum.sort() == ["command", "member"]

    refute Enum.any?(
             ~w(author cap capability delegation deps key local_realm private_key pubkey sig signature text),
             &contains_key?(payload, &1)
           )
  end

  test "roster_url bundles admit in the same exact v4 contract" do
    fixture = @admit_fixture_path |> File.read!() |> Jason.decode!()
    payload = fixture["payload"]

    assert {:ok, url} =
             ActionIntent.roster_url(
               payload["replica"],
               :admit,
               payload["command"]["member"],
               intent_id: payload["id"]
             )

    assert url == fixture["url"]
    assert decoded_payload(url) == payload
  end

  test "roster_url normalizes member ids independently and rejects malformed values" do
    id = "0123456789abcdef0123456789abcdef"

    assert {:ok, trimmed_url} =
             ActionIntent.roster_url(" replica:matter:one ", :remove_member, " resident:alice ",
               intent_id: id
             )

    assert decoded_payload(trimmed_url) == %{
             "v" => 4,
             "id" => id,
             "replica" => "replica:matter:one",
             "command" => %{"command" => "remove_member", "member" => "resident:alice"}
           }

    unicode_member = "\uFEFFresident:alice\u0085"

    assert {:ok, unicode_url} =
             ActionIntent.roster_url("replica", :remove_member, unicode_member, intent_id: id)

    assert decoded_payload(unicode_url)["command"]["member"] == unicode_member

    assert {:error, :invalid_command} =
             ActionIntent.roster_url("replica", :post, "resident", intent_id: id)

    assert {:error, :invalid_replica} =
             ActionIntent.roster_url(" ", :remove_member, "resident", intent_id: id)

    assert {:error, :invalid_member} =
             ActionIntent.roster_url("replica", :remove_member, " ", intent_id: id)

    assert {:error, :invalid_member} =
             ActionIntent.roster_url("replica", :remove_member, <<255>>, intent_id: id)

    assert {:error, :member_too_large} =
             ActionIntent.roster_url("replica", :remove_member, String.duplicate("x", 4_097),
               intent_id: id
             )

    assert {:error, :invalid_intent_id} =
             ActionIntent.roster_url("replica", :remove_member, "resident",
               intent_id: "not-an-id"
             )
  end

  test "grant_url emits the exact custody-free v5 resident grant contract" do
    fixture = @grant_fixture_path |> File.read!() |> Jason.decode!()
    payload = fixture["payload"]

    assert {:ok, url} =
             ActionIntent.grant_url(payload["replica"], payload["authority"]["audience"],
               intent_id: payload["id"]
             )

    assert url == fixture["url"]
    assert decoded_payload(url) == payload
    assert Map.keys(payload) |> Enum.sort() == ["authority", "id", "replica", "v"]

    assert Map.keys(payload["authority"]) |> Enum.sort() ==
             ["action", "audience", "live", "ops", "roles"]

    assert payload["authority"] == %{
             "action" => "grant",
             "audience" => "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=",
             "ops" => ["admit", "post", "set_summary", "set_title"],
             "roles" => [],
             "live" => false
           }

    refute Enum.any?(
             ~w(author cap capability delegation deps key local_realm parent private_key pubkey sig signature),
             &contains_key?(payload, &1)
           )
  end

  test "grant_url canonicalizes audience input and rejects invalid public keys" do
    id = "0123456789abcdef0123456789abcdef"
    audience = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE="

    assert {:ok, trimmed_url} =
             ActionIntent.grant_url(" replica:matter:one ", " #{audience} ", intent_id: id)

    assert decoded_payload(trimmed_url)["authority"]["audience"] == audience

    invalid_audiences = [
      "",
      " ",
      "not-base64!",
      String.trim_trailing(audience, "="),
      String.replace_suffix(audience, "E=", "F="),
      Base.encode64(:binary.copy(<<0>>, 31)),
      Base.encode64(:binary.copy(<<0>>, 33)),
      Base.encode64(:binary.copy(<<255>>, 32)) |> String.replace("/", "_"),
      <<255>>,
      nil
    ]

    for invalid <- invalid_audiences do
      assert {:error, :invalid_audience} =
               ActionIntent.grant_url("replica:matter:one", invalid, intent_id: id)
    end
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
