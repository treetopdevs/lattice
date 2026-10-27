defmodule Treehouse.CatalogJSONTest do
  use ExUnit.Case, async: false
  alias Treehouse.CatalogJSON

  test "raw numbers have a bounded unsigned safe decimal spelling" do
    for token <- ["0", "1", "9007199254740991"] do
      assert {:ok, [_]} = CatalogJSON.decode("[" <> token <> "]")
    end

    for token <- [
          "-0",
          "-1",
          "1.0",
          "1e0",
          "1E+0",
          "01",
          "9007199254740992",
          "18446744073709551615",
          String.duplicate("1", 100_000)
        ] do
      assert {:error, :malformed_catalog} = CatalogJSON.decode("[" <> token <> "]")
    end
  end

  test "quoted numeric content and escapes stay opaque; Jason owns syntax" do
    for value <- ["-0 1.0 1e0", ~s(a"123), ~S(\"-0), "18446744073709551616"] do
      assert {:ok, [^value]} = CatalogJSON.decode(Jason.encode!([value]))
    end

    for value <- ["[1,]", ~s(["unterminated), "[true false]"] do
      assert {:error, :malformed_catalog} = CatalogJSON.decode(value)
    end
  end

  test "oversized decimals never reach integer conversion" do
    {_, calls} =
      Lattice.IntegerParseTrace.capture(fn ->
        assert {:ok, [1]} = CatalogJSON.decode("[1]")

        assert {:error, :malformed_catalog} =
                 CatalogJSON.decode("[" <> String.duplicate("9", 100_000) <> "]")
      end)

    assert "1" in calls
    refute Enum.any?(calls, &(byte_size(&1) > 20))
  end

  test "original artifact bytes enforce the exact transport cap" do
    exact = "[0]" <> String.duplicate(" ", 131_072 - 3)
    assert {:ok, [0]} = CatalogJSON.decode(exact)
    assert {:error, :control_history_limit} = CatalogJSON.decode(exact <> " ")

    assert {:error, :control_history_limit} =
             CatalogJSON.decode(Jason.encode!(String.duplicate("é", 65_536)))
  end
end
