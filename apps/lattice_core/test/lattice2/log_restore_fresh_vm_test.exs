defmodule Lattice2.LogRestoreFreshVmTest do
  use ExUnit.Case, async: true

  alias Lattice.Authority
  alias Lattice.Authority.Delegation
  alias Lattice.{Identity, Log, Op}

  # `Log.restore/1` decodes dumps with `:safe`, which refuses atoms the running
  # VM has not interned. A freshly booted server VM loads modules lazily, so the
  # decoder module itself must keep the dump format's policy vocabulary alive:
  # a witnessed-recovery dump must restore in a bare VM that loaded nothing but
  # Lattice.Log and its struct dependencies.
  test "a witnessed-policy dump restores in a fresh bare VM" do
    clerk = Identity.from_seed("clerk", "log-restore-fresh-vm:clerk")
    successor = Identity.from_seed("resident", "log-restore-fresh-vm:resident")
    witness_a = :crypto.hash(:sha256, "log-restore-fresh-vm:witness-a")
    witness_b = :crypto.hash(:sha256, "log-restore-fresh-vm:witness-b")
    replica = Authority.bind_replica("matter:log-restore-fresh-vm", clerk.pub)

    delegation =
      Delegation.genesis(clerk, replica, ops: [:close_matter], roles: [:clerk], live: true)

    policies = %{
      clerk: %{
        successor: successor.pub,
        recovery: %{
          mode: :witnessed,
          version: 1,
          witnesses: [witness_a, witness_b],
          threshold: 2
        }
      }
    }

    genesis = Op.new(clerk, replica, [], :authority, {:genesis, delegation, policies})
    log = Log.append!(Log.new(replica), genesis)

    path =
      Path.join(
        System.tmp_dir!(),
        "log-restore-fresh-vm-#{System.unique_integer([:positive])}.log"
      )

    on_exit(fn -> File.rm(path) end)
    assert :ok = Log.dump(log, path)

    core_ebin = Application.app_dir(:lattice_core, "ebin")

    script = """
    # The host owns its app-level vocabulary (roles, command names), exactly as
    # the stable carrier server does by loading its configured state reporter;
    # the substrate succession/policy vocabulary must come from Lattice.Log.
    _host_vocabulary = [:clerk, :close_matter]

    case Lattice.Log.restore(#{inspect(path)}) do
      {:ok, restored} ->
        1 = map_size(restored.ops)
        IO.puts("FRESH_VM_RESTORE_OK")

      other ->
        IO.puts("FRESH_VM_RESTORE_FAILED " <> inspect(other))
    end
    """

    {output, exit_status} =
      System.cmd(elixir_bin(), ["-pa", core_ebin, "-e", script], stderr_to_stdout: true)

    assert exit_status == 0, "bare VM exited #{exit_status}: #{output}"

    assert String.contains?(output, "FRESH_VM_RESTORE_OK"),
           "witnessed-policy dump must restore in a fresh VM: #{output}"
  end

  defp elixir_bin do
    direct = Path.expand("~/.asdf/installs/elixir/1.19.5-otp-28/bin/elixir")
    if File.exists?(direct), do: direct, else: "elixir"
  end
end
