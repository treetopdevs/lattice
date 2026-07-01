defmodule Lattice.Tab.RealmTest do
  use ExUnit.Case, async: true
  alias Lattice.Tab.Realm

  describe "step/2 — boot" do
    test "boot control initializes state and emits hello + connecting status" do
      {state, out, render} =
        Realm.step(nil, %{"__lattice__" => "boot", "client_id" => "c-1", "last_seq" => 0})

      assert state.client_id == "c-1"
      assert [%{"type" => "hello", "client_id" => "c-1"}] = out
      assert %{kind: "status", text: "connecting"} in render
    end
  end

  describe "step/2 — server envelopes (delegates to Protocol)" do
    setup do
      {state, _o, _r} =
        Realm.step(nil, %{"__lattice__" => "boot", "client_id" => "c-1", "last_seq" => 0})

      {:ok, state: state}
    end

    test "welcome -> state_request + connected status", %{state: state} do
      {state, out, render} =
        Realm.step(state, %{
          "type" => "welcome",
          "tab_id" => "tab_9",
          "session_id" => "s",
          "client_id" => "c-1"
        })

      assert state.tab_id == "tab_9"
      assert out == [%{"type" => "state_request"}]
      assert %{kind: "status", text: "connected", tab_id: "tab_9"} in render
    end

    test "tab_call -> real tab_render_result + pulse", %{state: state} do
      {state, _o, _r} =
        Realm.step(state, %{
          "type" => "welcome",
          "tab_id" => "tab_A",
          "session_id" => "s",
          "client_id" => "c-1"
        })

      {^state, out, render} =
        Realm.step(state, %{
          "type" => "tab_call",
          "request_id" => "r1",
          "from_tab_id" => "tab_B",
          "payload" => %{"op" => "render", "pulse" => "blue"}
        })

      assert [
               %{
                 "type" => "tab_render_result",
                 "request_id" => "r1",
                 "result" => %{"realm" => "atomvm", "pulse" => "blue"}
               }
             ] = out

      assert %{kind: "pulse", route: "bridge"} in render
    end

    test "unknown envelope is a no-op", %{state: state} do
      assert {^state, [], []} = Realm.step(state, %{"type" => "totally_unknown"})
    end
  end

  describe "reply/3 shaping" do
    test "wraps out + render into the JSON-ready reply map" do
      assert Realm.reply([%{"type" => "hello"}], [%{kind: "status"}]) ==
               %{"out" => [%{"type" => "hello"}], "render" => [%{kind: "status"}]}
    end
  end
end
