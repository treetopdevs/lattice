defmodule Lattice.Tab.CodecTest do
  use ExUnit.Case, async: true
  alias Lattice.Tab.Codec

  describe "decode/1" do
    test "decodes a JSON object to a string-keyed map" do
      assert {:ok, %{"type" => "welcome", "tab_id" => "tab_9"}} =
               Codec.decode(~s({"type":"welcome","tab_id":"tab_9"}))
    end

    test "returns {:error, _} on malformed JSON" do
      assert {:error, _} = Codec.decode("not-json")
    end
  end

  describe "encode/1" do
    test "encodes a string-keyed envelope" do
      assert Codec.decode(Codec.encode(%{"type" => "hello", "client_id" => "c1"})) ==
               {:ok, %{"type" => "hello", "client_id" => "c1"}}
    end

    test "stringifies atom-keyed render intents" do
      {:ok, decoded} =
        Codec.decode(Codec.encode(%{kind: "status", text: "connected", tab_id: "t1"}))

      assert decoded == %{"kind" => "status", "text" => "connected", "tab_id" => "t1"}
    end

    test "encodes the {out, render} reply envelope" do
      reply = %{
        "out" => [%{"type" => "hello"}],
        "render" => [%{kind: "status", text: "connecting"}]
      }

      {:ok, decoded} = Codec.decode(Codec.encode(reply))

      assert decoded == %{
               "out" => [%{"type" => "hello"}],
               "render" => [%{"kind" => "status", "text" => "connecting"}]
             }
    end
  end
end
