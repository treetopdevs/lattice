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

    shim = Path.expand("~/.asdf/shims/elixir")

    elixir =
      if File.exists?(shim),
        do: shim,
        else:
          System.find_executable("elixir") ||
            raise("Elixir executable unavailable for restore probe")

    # Match the running test VM's OTP and Elixir, independently of PATH shadows.
    child_path =
      Enum.join(
        [
          Path.join(to_string(:code.root_dir()), "bin"),
          Path.expand("../../bin", Application.app_dir(:elixir)),
          System.get_env("PATH", "")
        ],
        ":"
      )

    {output, status} =
      System.cmd(elixir, ["-pa", Application.app_dir(:lattice_core, "ebin"), "-e", script],
        stderr_to_stdout: true,
        env: [{"PATH", child_path}]
      )

    assert status == 0, output
    assert output =~ "BEACON_RESTORE_OK", output
  end
end
