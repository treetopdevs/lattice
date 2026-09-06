defmodule Lattice2.WitnessedBeaconRestoreTest do
  use ExUnit.Case, async: true

  alias Lattice.{Log, Sim}
  alias Township.Matter

  test "witnessed beacon vocabulary restores in a fresh VM without loading the beacon module" do
    sim = Sim.new(Matter, "matter:beacon-restore", ["clerk", "w0", "w1"], seed: "beacon:restore")

    {sim, _} =
      Sim.create_replica(sim, "clerk",
        policies: %{
          __beacon__: %{
            mode: :witnessed,
            version: 1,
            witnesses: ["w0", "w1"],
            threshold: 2,
            max_epoch_step: 10
          }
        }
      )

    {sim, _} = Sim.beacon(sim, "w0", 4, witnesses: ["w0", "w1"])
    log = Sim.log(sim, "w0")

    path =
      Path.join(System.tmp_dir!(), "beacon-restore-#{System.unique_integer([:positive])}.log")

    on_exit(fn -> File.rm(path) end)
    assert :ok = Log.dump(log, path)

    script = """
    # Only application vocabulary is owned by the host. Log owns beacon vocabulary.
    _host_vocabulary = [:clerk, :admit, :post, :set_summary, :set_title, :close_matter,
      :reopen_matter, :remove_member, :link_election]
    case Lattice.Log.restore(#{inspect(path)}) do
      {:ok, restored} ->
        2 = map_size(restored.ops)
        IO.puts("BEACON_RESTORE_OK")
      other -> IO.puts(inspect(other))
    end
    """

    elixir = Path.expand("~/.asdf/installs/elixir/1.19.5-otp-28/bin/elixir")

    {output, status} =
      System.cmd(elixir, ["-pa", Application.app_dir(:lattice_core, "ebin"), "-e", script],
        stderr_to_stdout: true
      )

    assert status == 0, output
    assert output =~ "BEACON_RESTORE_OK", output
  end
end
