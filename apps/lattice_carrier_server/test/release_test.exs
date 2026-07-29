defmodule LatticeCarrierServer.ReleaseTest do
  @moduledoc """
  The `lattice_carrier_pilot` release must actually build the way production
  builds it: `MIX_ENV=prod mix release lattice_carrier_pilot` invoked from
  the umbrella root (plan 158/159). A release definition that only lives in
  a child app's `mix.exs` is invisible to `mix release` at the umbrella
  root — Mix umbrella releases must be declared in the root project's
  `releases:` keyword list. This regression actually shells out to `mix
  release` rather than asserting the release atom exists in a keyword list,
  so it fails for the same reason a real deploy would fail.
  """

  use ExUnit.Case, async: false

  @moduletag timeout: 300_000

  test "MIX_ENV=prod mix release lattice_carrier_pilot succeeds from the umbrella root" do
    release_dir = Path.join([repo_root(), "_build", "prod", "rel", "lattice_carrier_pilot"])
    File.rm_rf!(release_dir)

    {output, status} =
      System.cmd(mix_bin(), ["release", "lattice_carrier_pilot", "--overwrite"],
        cd: repo_root(),
        stderr_to_stdout: true,
        env: [{"MIX_ENV", "prod"}]
      )

    assert status == 0, "mix release lattice_carrier_pilot failed:\n#{output}"
    refute output =~ "Unknown release"

    release_bin = Path.join(release_dir, "bin/lattice_carrier_pilot")
    assert File.exists?(release_bin), "expected a built release executable at #{release_bin}"

    {renamed_output, renamed_status} =
      System.cmd(release_bin, ["eval", ~s|IO.puts("SHOULD_NOT_BOOT")|],
        stderr_to_stdout: true,
        env: [
          {"RELEASE_NAME", "renamed_pilot"},
          {"SECRET_KEY_BASE", String.duplicate("s", 64)}
        ]
      )

    assert renamed_status != 0
    assert renamed_output =~ "LATTICE_CARRIER_MANIFEST is required"
    refute renamed_output =~ "SHOULD_NOT_BOOT"
  end

  defp repo_root, do: Path.expand("../../..", __DIR__)

  defp mix_bin do
    if System.get_env("CI") == "true" do
      System.find_executable("mix") || flunk("CI-provided mix executable is unavailable")
    else
      shim = Path.expand("~/.asdf/shims/mix")

      if File.exists?(shim) do
        shim
      else
        flunk("required asdf mix shim is unavailable at #{shim}")
      end
    end
  end
end
