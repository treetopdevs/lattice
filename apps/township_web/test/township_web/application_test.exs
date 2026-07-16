defmodule TownshipWeb.ApplicationTest do
  use ExUnit.Case, async: false

  import Phoenix.ConnTest
  import Phoenix.LiveViewTest

  alias TownshipWeb.CarrierProjection

  @endpoint TownshipWeb.Endpoint

  test "configured carrier projection is supervised by the web application" do
    previous = Application.get_env(:township_web, :instrument_projection_options, :missing)

    on_exit(fn ->
      :ok = Application.stop(:township_web)
      restore_projection_config(previous)
      {:ok, _apps} = Application.ensure_all_started(:township_web)
    end)

    :ok = Application.stop(:township_web)

    Application.put_env(:township_web, :instrument_projection_options,
      connect_opts: [],
      replica: "replica:matter:supervised-projection",
      peer_realm: "clerk",
      schedule: :manual
    )

    assert {:ok, _apps} = Application.ensure_all_started(:township_web)
    assert projection = Process.whereis(CarrierProjection)
    assert Process.alive?(projection)

    runtime_apps = Application.spec(:township_web, :applications)
    assert :lattice_web_socket in runtime_apps
    refute :lattice_node_spike in runtime_apps
    refute :lattice_server in runtime_apps
    refute :cowboy in runtime_apps
    assert Process.whereis(TownshipWeb.PubSub)
    assert Process.whereis(TownshipWeb.Endpoint)

    {:ok, view, _html} = live(build_conn(), "/township")
    assert has_element?(view, "#instrument-connecting", "Carrier connecting")
    refute render(view) =~ "Zoning variance #24"
  end

  defp restore_projection_config(:missing) do
    Application.delete_env(:township_web, :instrument_projection_options)
  end

  defp restore_projection_config(value) do
    Application.put_env(:township_web, :instrument_projection_options, value)
  end
end
