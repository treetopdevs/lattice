defmodule LatticeCarrierServer.Operator.TreehouseBackupTest do
  @moduledoc """
  Row 295: `scripts/treehouse-relay/backup.sh` seed read-back and exact-id
  promotion, run under dash with synthetic seeds and a stubbed restic.
  """
  use ExUnit.Case, async: true

  alias LatticeCarrierServer.Manifest

  @moduletag :tmp_dir

  @script Path.expand("../../../../scripts/treehouse-relay/backup.sh", __DIR__)
  @stubs Path.expand("../support/treehouse_backup", __DIR__)
  @bound_key "qJ7tfzm+Gvc1O1lgfj/ZwdPgSAC/jcuxXMHoA2qVbB4="
  @dash "/bin/dash"

  test "the script is dash-parseable and keeps operator host defaults" do
    assert File.exists?(@dash)
    assert {"", 0} = System.cmd(@dash, ["-n", @script])
    source = File.read!(@script)

    assert source =~ ~r{TREEHOUSE_BACKUP_CADDY_ETC:-/etc/caddy}
    assert source =~ ~r{TREEHOUSE_BACKUP_CADDY_LIB:-/var/lib/caddy}
    assert source =~ ~r{TREEHOUSE_BACKUP_RESTIC_ETC:-/etc/restic}
    assert source =~ ~r{TREEHOUSE_BACKUP_RELAY_LIB:-/var/lib/treehouse-relay}
    assert source =~ ~r{TREEHOUSE_BACKUP_RESTIC_ENV:-/etc/restic/env}
    assert source =~ ~r{TREEHOUSE_BACKUP_SCRATCH_DIR:-/run}
    assert source =~ ~r{TREEHOUSE_BACKUP_RETRY_SECONDS:-1800}
    assert source =~ ~r{TREEHOUSE_BACKUP_ATTEMPTS:-4}
    assert source =~ @bound_key
  end

  test "a matching snapshot seed is promoted by exact id despite a stale pending snapshot", %{
    tmp_dir: tmp
  } do
    id = "cafef00d"
    ctx = prepare!(tmp, backup_ids: [id], dump_plan: ["ok"], stale_pending: ["deadbeef"])
    {output, 0, log} = run_backup(ctx)

    assert output =~ "snapshot #{id} saved"
    assert stub_lines(ctx, "daily") == [id]
    assert "deadbeef" in stub_lines(ctx, "incomplete")
    refute "deadbeef" in stub_lines(ctx, "daily")
    assert log =~ "restic tag --set daily #{id}\n"
    refute log =~ "restic tag --set daily deadbeef\n"
    assert log =~ "restic forget --tag daily "
    assert logged_backup_paths(log, ctx)
    assert log =~ "restic dump #{id} #{ctx.seed_path}"
  end

  test "a wrong snapshot seed is not promoted or daily-pruned and is not retried", %{
    tmp_dir: tmp
  } do
    ctx = prepare!(tmp, backup_ids: ["aabbccdd"], dump_plan: ["wrong", "ok"])
    {output, status, log} = run_backup(ctx)

    assert status == 1
    assert output =~ "holds a seed that fails the check"
    refute log =~ "restic tag --set daily "
    refute log =~ "restic forget --tag daily "
    refute log =~ "restic forget --tag incomplete "
    refute log =~ "sleep "
    assert log =~ "restic dump aabbccdd #{ctx.seed_path}"
    refute dump_count(log) > 1
  end

  test "an empty snapshot seed copy is not promoted or daily-pruned", %{tmp_dir: tmp} do
    ctx = prepare!(tmp, backup_ids: ["01234567"], dump_plan: ["empty"])
    {output, status, log} = run_backup(ctx)

    assert status == 1
    assert output =~ "service identity seed missing or malformed"
    refute log =~ "restic tag --set daily "
    refute log =~ "restic forget --tag daily "
  end

  test "a malformed snapshot seed copy is not promoted or daily-pruned", %{tmp_dir: tmp} do
    ctx = prepare!(tmp, backup_ids: ["89abcdef"], dump_plan: ["malformed"])
    {_output, status, log} = run_backup(ctx)

    assert status == 1
    refute log =~ "restic tag --set daily "
    refute log =~ "restic forget --tag daily "
  end

  test "a failed dump is retried and then promoted by the successful id", %{tmp_dir: tmp} do
    ctx =
      prepare!(tmp,
        backup_ids: ["11111111", "22222222"],
        dump_plan: ["fail", "ok"]
      )

    {output, 0, log} = run_backup(ctx)

    assert output =~ "could not read the seed back from snapshot 11111111"
    assert output =~ "snapshot 22222222 saved"
    assert log =~ "sleep 0\n"
    refute log =~ "sleep 1800\n"
    assert dump_count(log) == 2
    assert log =~ "restic tag --set daily 22222222\n"
    refute log =~ "restic tag --set daily 11111111\n"
    assert log =~ "restic forget --tag daily "
  end

  test "a timed-out dump is retried and then promoted by the successful id", %{tmp_dir: tmp} do
    ctx =
      prepare!(tmp,
        backup_ids: ["aaaaaaa1", "aaaaaaa2"],
        dump_plan: ["timeout", "ok"]
      )

    {output, 0, log} = run_backup(ctx)

    assert output =~ "could not read the seed back from snapshot aaaaaaa1"
    assert log =~ "timeout-dump 124\n"
    assert log =~ "sleep 0\n"
    refute log =~ "sleep 1800\n"
    assert log =~ "restic tag --set daily aaaaaaa2\n"
    refute log =~ "restic tag --set daily aaaaaaa1\n"
  end

  test "exhausted dump failures never promote or daily-prune", %{tmp_dir: tmp} do
    ids = ["f1000001", "f1000002", "f1000003", "f1000004"]
    ctx = prepare!(tmp, backup_ids: ids, dump_plan: ["fail", "fail", "fail", "fail"])
    {output, status, log} = run_backup(ctx)

    assert status == 1
    assert output =~ "could not read the seed back"
    assert dump_count(log) == 4
    assert sleep_count(log) == 3
    refute log =~ "sleep 1800\n"
    refute log =~ "restic tag --set daily "
    refute log =~ "restic forget --tag daily "
    assert log =~ "restic forget --tag incomplete "
  end

  test "exhausted dump timeouts never promote or daily-prune", %{tmp_dir: tmp} do
    ids = ["d1000001", "d1000002", "d1000003", "d1000004"]
    ctx = prepare!(tmp, backup_ids: ids, dump_plan: ["timeout", "timeout", "timeout", "timeout"])
    {output, status, log} = run_backup(ctx)

    assert status == 1
    assert output =~ "could not read the seed back"
    assert timeout_dump_count(log) == 4
    refute log =~ "restic tag --set daily "
    refute log =~ "restic forget --tag daily "
    assert log =~ "restic forget --tag incomplete "
  end

  test "restic/env cannot retarget the bound public key snapshotted from the process", %{
    tmp_dir: tmp
  } do
    ctx = prepare!(tmp, backup_ids: ["b1000001"], dump_plan: ["ok"])

    File.write!(
      ctx.restic_env,
      "TREEHOUSE_BACKUP_EXPECTED_PUBLIC_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n"
    )

    {_output, 0, log} = run_backup(ctx)
    assert log =~ "restic tag --set daily b1000001\n"
  end

  test "restic/env cannot overwrite the frozen __tb_* names", %{tmp_dir: tmp} do
    ctx = prepare!(tmp, backup_ids: ["b1000002"], dump_plan: ["ok"])

    File.write!(
      ctx.restic_env,
      "__tb_expected_public_key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n"
    )

    {_output, status, log} = run_backup(ctx)
    assert status != 0
    assert stub_lines(ctx, "daily") == []
    refute log =~ "restic tag --set daily "
  end

  test "a backup path with whitespace is refused before restic runs", %{tmp_dir: tmp} do
    ctx = prepare!(tmp, backup_ids: ["cafef00d"], dump_plan: ["ok"])
    spaced = Path.join(ctx.tmp, "caddy config")
    File.mkdir_p!(spaced)
    ctx = %{ctx | caddy_etc: spaced}
    {output, status, log} = run_backup(ctx)

    assert status == 1
    assert output =~ "unsafe characters"
    refute log =~ "restic backup "
    refute log =~ "restic tag --set daily "
    assert stub_lines(ctx, "daily") == []
  end

  test "a failed pending quarantine does not promote a leftover snapshot", %{tmp_dir: tmp} do
    ctx = prepare!(tmp, backup_ids: ["cafef00d"], dump_plan: ["ok"], stale_pending: ["deadbeef"])
    {_output, status, log} = run_backup(ctx, %{"TREEHOUSE_BACKUP_STUB_QUARANTINE" => "fail"})

    assert status == 1
    assert stub_lines(ctx, "daily") == []
    assert stub_lines(ctx, "pending") == ["deadbeef"]
    refute log =~ "restic backup "
    refute log =~ "restic tag --set daily "
  end

  defp prepare!(tmp, opts) do
    {good_contents, good_key} = seed_and_key()
    {wrong_contents, _wrong_key} = seed_and_key()
    refute good_contents == wrong_contents

    host = Path.join(tmp, "host")
    caddy_etc = Path.join(host, "etc/caddy")
    caddy_lib = Path.join(host, "var/lib/caddy")
    restic_etc = Path.join(host, "etc/restic")
    relay_lib = Path.join(host, "var/lib/treehouse-relay")
    scratch = Path.join(tmp, "scratch")
    stub_dir = Path.join(tmp, "stub")
    File.mkdir_p!(caddy_etc)
    File.mkdir_p!(caddy_lib)
    File.mkdir_p!(restic_etc)
    File.mkdir_p!(relay_lib)
    File.mkdir_p!(scratch)
    File.mkdir_p!(stub_dir)

    seed_path = Path.join(relay_lib, "service-identity.seed")
    File.write!(seed_path, good_contents)
    restic_env = Path.join(restic_etc, "env")
    File.write!(restic_env, "RESTIC_REPOSITORY=/does-not-matter\nRESTIC_PASSWORD=x\n")
    File.write!(Path.join(stub_dir, "good_seed"), good_contents)
    File.write!(Path.join(stub_dir, "wrong_seed"), wrong_contents)
    File.write!(Path.join(stub_dir, "log"), "")

    File.write!(
      Path.join(stub_dir, "backup_ids"),
      Enum.join(Keyword.fetch!(opts, :backup_ids), "\n") <> "\n"
    )

    File.write!(
      Path.join(stub_dir, "dump_plan"),
      Enum.join(Keyword.fetch!(opts, :dump_plan), "\n") <> "\n"
    )

    File.write!(
      Path.join(stub_dir, "pending"),
      case Keyword.get(opts, :stale_pending, []) do
        [] -> ""
        ids -> Enum.join(ids, "\n") <> "\n"
      end
    )

    File.write!(Path.join(stub_dir, "incomplete"), "")
    File.write!(Path.join(stub_dir, "daily"), "")

    %{
      tmp: tmp,
      caddy_etc: caddy_etc,
      caddy_lib: caddy_lib,
      restic_etc: restic_etc,
      relay_lib: relay_lib,
      restic_env: restic_env,
      seed_path: seed_path,
      scratch: scratch,
      stub_dir: stub_dir,
      expected_key: good_key
    }
  end

  defp run_backup(ctx, extra_env \\ %{}) do
    env =
      Map.merge(
        %{
          "PATH" => @stubs <> ":" <> System.get_env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin"),
          "TREEHOUSE_BACKUP_STUB_DIR" => ctx.stub_dir,
          "TREEHOUSE_BACKUP_CADDY_ETC" => ctx.caddy_etc,
          "TREEHOUSE_BACKUP_CADDY_LIB" => ctx.caddy_lib,
          "TREEHOUSE_BACKUP_RESTIC_ETC" => ctx.restic_etc,
          "TREEHOUSE_BACKUP_RELAY_LIB" => ctx.relay_lib,
          "TREEHOUSE_BACKUP_RESTIC_ENV" => ctx.restic_env,
          "TREEHOUSE_BACKUP_EXPECTED_PUBLIC_KEY" => ctx.expected_key,
          "TREEHOUSE_BACKUP_SCRATCH_DIR" => ctx.scratch,
          "TREEHOUSE_BACKUP_RETRY_SECONDS" => "0",
          "TREEHOUSE_BACKUP_ATTEMPTS" => "4"
        },
        extra_env
      )

    {output, status} =
      System.cmd(@dash, [@script], env: env, stderr_to_stdout: true)

    log = File.read!(Path.join(ctx.stub_dir, "log"))
    {output, status, log}
  end

  defp stub_lines(ctx, name) do
    ctx.stub_dir
    |> Path.join(name)
    |> File.read!()
    |> String.split("\n", trim: true)
  end

  defp seed_and_key do
    contents = Base.encode16(:crypto.strong_rand_bytes(32), case: :lower) <> "\n"
    {:ok, pub} = Manifest.identity_public_key(contents)
    {contents, Base.encode64(pub)}
  end

  defp dump_count(log) do
    log
    |> String.split("\n", trim: true)
    |> Enum.count(&String.starts_with?(&1, "restic dump "))
  end

  defp timeout_dump_count(log) do
    log
    |> String.split("\n", trim: true)
    |> Enum.count(&(&1 == "timeout-dump 124"))
  end

  defp sleep_count(log) do
    log
    |> String.split("\n", trim: true)
    |> Enum.count(&String.starts_with?(&1, "sleep "))
  end

  defp logged_backup_paths(log, ctx) do
    log
    |> String.split("\n", trim: true)
    |> Enum.any?(fn line ->
      String.starts_with?(line, "restic backup --tag pending ") and
        String.contains?(line, ctx.caddy_etc) and
        String.contains?(line, ctx.caddy_lib) and
        String.contains?(line, ctx.restic_etc) and
        String.contains?(line, ctx.relay_lib)
    end)
  end
end
