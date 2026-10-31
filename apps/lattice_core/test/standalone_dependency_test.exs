defmodule LatticeCore.StandaloneDependencyTest do
  @moduledoc """
  Plan 287 step 4: a consumer outside the umbrella can depend on `lattice_core` with
  `runtime: false` and call the pure modules without starting any Lattice process.

  The test copies `apps/lattice_core` (its `mix.exs` and `lib`) into an isolated temp
  dir with no umbrella around it, as a sparse checkout of that subtree would have it,
  and checks the copy loads as a project of its own. It then builds an empty Mix
  project that depends on the copy by path (jason by the umbrella's own path, so no
  network) and runs `Lattice.Verdict.explain/3` over a restored `handoff_lapse` log.
  """
  use ExUnit.Case, async: true

  @moduletag timeout: 600_000

  alias Lattice.{FaultScenario, Log}

  @core_dir Path.expand("..", __DIR__)

  # Mix variables the parent `mix test` may have set; the child must not inherit them.
  @scrubbed ~w(MIX_EXS MIX_BUILD_PATH MIX_BUILD_ROOT MIX_DEPS_PATH MIX_LOCKFILE MIX_TARGET
               MIX_PROJECT MIX_INSTALL_DIR ERL_LIBS)

  @check """
  [path] = System.argv()
  # The host owns its replica vocabulary: `restore_verified/1` decodes with `:safe`,
  # so the replica module's atoms must be interned before the dump is read.
  Code.ensure_loaded!(Treehouse.Thread)
  {:ok, %{log: log}} = Lattice.Log.restore_verified(path)
  started = Enum.map(Application.started_applications(), &elem(&1, 0))

  counts =
    log
    |> Lattice.Log.op_ids()
    |> Enum.map(fn id ->
      {verdict, record} = Lattice.Verdict.explain(Treehouse.Thread, log, id)
      "\#{verdict}:\#{record.reason}"
    end)
    |> Enum.frequencies()
    |> Enum.sort()

  IO.puts("STANDALONE started_core=\#{:lattice_core in started} \#{inspect(counts)}")
  """

  setup do
    root =
      Path.join(System.tmp_dir!(), "lattice-standalone-#{System.unique_integer([:positive])}")

    dir = Path.join(root, "consumer")
    core = Path.join([root, "sparse", "apps", "lattice_core"])
    File.mkdir_p!(Path.join(dir, "lib"))
    File.mkdir_p!(core)
    File.cp!(Path.join(@core_dir, "mix.exs"), Path.join(core, "mix.exs"))
    File.cp_r!(Path.join(@core_dir, "lib"), Path.join(core, "lib"))
    on_exit(fn -> File.rm_rf(root) end)
    %{dir: dir, core: core}
  end

  test "lattice_core compiles as a runtime: false dependency and Verdict runs unstarted",
       %{dir: dir, core: core} do
    # Without the umbrella's config it must load as a plain project, not raise.
    mix!(core, ["deps"])

    {:ok, logs} = FaultScenario.run("handoff_lapse", "demo")
    log_path = Path.join(dir, "thread.root.log")
    :ok = Log.dump(logs["thread.root"], log_path)

    File.write!(Path.join(dir, "mix.exs"), consumer_mix_exs(core))
    File.write!(Path.join(dir, "check.exs"), @check)

    mix!(dir, ["deps.compile"])
    output = mix!(dir, ["run", "check.exs", log_path])

    assert output =~ "STANDALONE started_core=false"

    assert output =~
             ~s([{"honored:", 4}, {"quarantined:capability_wrong_audience", 1}, ) <>
               ~s({"quarantined:lease_expired", 1}])
  end

  defp consumer_mix_exs(core) do
    jason = Mix.Project.deps_paths() |> Map.fetch!(:jason)

    """
    defmodule StandaloneConsumer.MixProject do
      use Mix.Project

      def project,
        do: [app: :standalone_consumer, version: "0.1.0", elixir: "~> 1.19", deps: deps()]

      def application, do: [extra_applications: [:logger]]

      defp deps do
        [
          {:lattice_core, path: #{inspect(core)}, runtime: false},
          {:jason, path: #{inspect(jason)}, override: true}
        ]
      end
    end
    """
  end

  # Run the same Elixir and Erlang as this test, whatever `mix` on PATH resolves to.
  defp mix!(dir, args) do
    elixir_bin = Path.expand("../../bin", :code.lib_dir(:elixir))
    erlang_bin = Path.join(:code.root_dir(), "bin")
    path = Enum.join([elixir_bin, erlang_bin, System.get_env("PATH", "")], ":")

    env =
      [{"MIX_ENV", "dev"}, {"PATH", path}, {"MIX_QUIET", "1"}] ++
        Enum.map(@scrubbed, &{&1, nil})

    {output, status} =
      System.cmd(Path.join(elixir_bin, "mix"), args, cd: dir, env: env, stderr_to_stdout: true)

    assert status == 0, "mix #{Enum.join(args, " ")} failed:\n#{output}"
    output
  end
end
