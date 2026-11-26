defmodule Township.ReportFileTest do
  use ExUnit.Case, async: true

  alias Township.ReportFile

  @moduletag :tmp_dir

  setup %{tmp_dir: tmp} do
    dir = Path.join(tmp, "out")
    File.mkdir_p!(dir)
    victim = Path.join(tmp, "victim.txt")
    File.write!(victim, "victim bytes")
    %{dir: dir, dest: Path.join(dir, "report.html"), victim: victim}
  end

  test "writes the exact bytes and leaves no temporary file", %{dir: dir, dest: dest} do
    assert :ok = ReportFile.write(dest, ["<html>", "report", "</html>"])
    assert File.read!(dest) == "<html>report</html>"
    assert File.ls!(dir) == ["report.html"]

    assert :ok = ReportFile.write(dest, "second")
    assert File.read!(dest) == "second"
    assert File.ls!(dir) == ["report.html"]
  end

  test "a symlink at the destination is replaced, never written through", ctx do
    File.ln_s!(ctx.victim, ctx.dest)

    assert :ok = ReportFile.write(ctx.dest, "new report")
    assert File.read!(ctx.victim) == "victim bytes"
    assert File.lstat!(ctx.dest).type == :regular
    assert File.read!(ctx.dest) == "new report"
  end

  test "a hard link at the destination is replaced, never written through", ctx do
    File.ln!(ctx.victim, ctx.dest)

    assert :ok = ReportFile.write(ctx.dest, "new report")
    assert File.read!(ctx.victim) == "victim bytes"
    assert File.read!(ctx.dest) == "new report"
  end

  test "a link planted at the temporary name is refused and left in place", ctx do
    tmp = Path.join(ctx.dir, ".report-fixed.tmp")
    File.ln_s!(ctx.victim, tmp)

    assert {:error, :eexist} = ReportFile.write(ctx.dest, "new report", suffix: "fixed")
    assert File.read!(ctx.victim) == "victim bytes"
    refute File.exists?(ctx.dest)
    assert File.lstat!(tmp).type == :symlink
  end

  test "a destination basename near NAME_MAX still writes", ctx do
    dest = Path.join(ctx.dir, String.duplicate("r", 250) <> ".html")

    assert :ok = ReportFile.write(dest, "long name")
    assert File.read!(dest) == "long name"
    assert File.ls!(ctx.dir) == [Path.basename(dest)]
  end

  test "a directory at the destination fails and removes the temporary file", ctx do
    File.mkdir_p!(ctx.dest)

    assert {:error, _reason} = ReportFile.write(ctx.dest, "new report")
    assert File.dir?(ctx.dest)
    assert File.ls!(ctx.dir) == ["report.html"]
  end
end
