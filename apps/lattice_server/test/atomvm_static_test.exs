defmodule LatticeServer.AtomvmStaticTest do
  use ExUnit.Case, async: false

  alias LatticeServer.TestSupport.HTTP

  setup do
    tab_dir = Path.join(System.tmp_dir!(), "atomvm_tab_#{System.unique_integer([:positive])}")
    File.mkdir_p!(tab_dir)
    File.write!(Path.join(tab_dir, "index.html"), "<!doctype html><title>atomvm</title>")
    File.write!(Path.join(tab_dir, "AtomVM-web-v0.7.0-alpha.1.wasm"), <<0, 97, 115, 109>>)

    listener = :"atomvm_static_test_#{System.unique_integer([:positive])}"
    port = HTTP.free_port()

    {:ok, _pid} =
      LatticeServer.start_http(
        listener: listener,
        port: port,
        static_dir: Path.expand("../../../examples/browser_demo", __DIR__),
        atomvm_tab_dir: tab_dir,
        auto_story?: false,
        grant_targets: %{}
      )

    on_exit(fn ->
      LatticeServer.stop_http(listener)
      File.rm_rf!(tab_dir)
    end)

    {:ok, port: port}
  end

  describe "/atomvm_tab isolation" do
    test "index.html is served cross-origin-isolated", %{port: port} do
      assert {:ok, 200, head, body} = HTTP.raw_http_with_head(port, "GET", "/atomvm_tab/index.html")
      assert body =~ "atomvm"
      assert head =~ "cross-origin-opener-policy: same-origin"
      assert head =~ "cross-origin-embedder-policy: require-corp"
      assert head =~ "cross-origin-resource-policy: same-origin"
    end

    test ".wasm is served with application/wasm + isolation", %{port: port} do
      assert {:ok, 200, head, _body} =
               HTTP.raw_http_with_head(port, "GET", "/atomvm_tab/AtomVM-web-v0.7.0-alpha.1.wasm")

      assert head =~ "content-type: application/wasm"
      assert head =~ "cross-origin-embedder-policy: require-corp"
    end

    test "unknown atomvm_tab file is 404 (whitelist preserved)", %{port: port} do
      assert {:ok, 404, _head, _body} = HTTP.raw_http_with_head(port, "GET", "/atomvm_tab/secret.key")
    end
  end

  describe "JS demo route is not isolated" do
    test "/ has no cross-origin-embedder-policy header", %{port: port} do
      assert {:ok, 200, head, _body} = HTTP.raw_http_with_head(port, "GET", "/")
      refute head =~ "cross-origin-embedder-policy"
    end
  end
end
