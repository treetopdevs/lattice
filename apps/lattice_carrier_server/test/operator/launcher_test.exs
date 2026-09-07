defmodule LatticeCarrierServer.Operator.LauncherTest do
  use ExUnit.Case, async: false
  @launcher Path.expand("../../../../scripts/treehouse_operator_locked.sh", __DIR__)

  if :os.type() == {:unix, :linux} do
    test "two Linux processes exclude, then SIGKILL releases the same lock" do
      root = Path.expand(".operator-lock-#{System.unique_integer([:positive])}", File.cwd!())
      File.mkdir!(root)
      File.chmod!(root, 0o700)
      on_exit(fn -> File.rm_rf!(root) end)

      port =
        Port.open({:spawn_executable, @launcher}, [
          :binary,
          :exit_status,
          args: [root, "/bin/sh", "-c", "echo LOCKED; exec sleep 120"]
        ])

      assert_receive {^port, {:data, "LOCKED\n"}}, 5_000
      {:os_pid, pid} = Port.info(port, :os_pid)
      assert {_, 75} = System.cmd(@launcher, [root, "/bin/true"], stderr_to_stdout: true)
      assert {_, 0} = System.cmd("kill", ["-KILL", Integer.to_string(pid)])
      assert_receive {^port, {:exit_status, _}}, 5_000
      assert {_, 0} = System.cmd(@launcher, [root, "/bin/true"], stderr_to_stdout: true)
    end
  else
    @tag skip: "Actual Linux flock/SIGKILL proof requires the Linux hosted gate"
    test "two Linux processes exclude, then SIGKILL releases the same lock", do: :ok

    test "unsupported host refuses without executing the requested mutation" do
      assert {"unsupported_operator_platform\n", 78} =
               System.cmd(@launcher, ["/", "/bin/false"], stderr_to_stdout: true)
    end
  end
end
