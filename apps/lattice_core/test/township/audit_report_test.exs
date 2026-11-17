defmodule Township.AuditReportTest do
  use ExUnit.Case, async: false

  alias Lattice.Sim
  alias Mix.Tasks.Lattice.Township.Report, as: ReportTask
  alias Township.{AuditBundle, AuditReport, Matter}

  @moduletag timeout: 120_000

  @repo_root Path.expand("../../../..", __DIR__)
  @tracked_dir Path.join(@repo_root, "artifacts/township")
  @hostile_post "<img src=x onerror=alert(1)>"
  @hostile_label "<b>\"x\"&'y'</b>"

  # A stale clerk action (not_holder) plus an ill-formed grant (omitted delegation).
  defp scenario do
    sim = Sim.new(Matter, "replica:matter:report", ["clerk", "resident"], seed: "report-fixture")
    {sim, _} = Sim.create_replica(sim, "clerk")
    {sim, _} = Sim.command(sim, "clerk", :set_title, ["Report matter"])
    {sim, _} = Sim.command(sim, "clerk", :post, [@hostile_post])
    {sim, _} = Sim.grant(sim, "clerk", "resident", ops: [:post, :set_summary])
    {sim, good} = Sim.grant(sim, "clerk", "resident", ops: [:post], roles: [:clerk])
    {sim, bad} = Sim.append(sim, "clerk", :authority, {:grant, %{good | roles: [:clerk]}})

    {sim, _} =
      Sim.transfer(sim, "clerk", "resident", :clerk,
        at_tick: 1,
        ops: [:close_matter, :reopen_matter]
      )

    sim = Sim.sync_all(sim)
    {sim, stale} = Sim.command(sim, "clerk", :reopen_matter, [])
    sim = Sim.sync_all(sim)
    {sim, bad.id, stale.id}
  end

  defp write_bundle(dir) do
    {sim, bad_id, stale_id} = scenario()
    resident_fp = Lattice.Identity.fingerprint(Sim.identity(sim, "resident"))
    labels = %{resident_fp => @hostile_label}
    log = Sim.log(sim, "resident")
    assert {:ok, _} = AuditBundle.write(dir, log, labels: labels)
    assert :ok = AuditBundle.verify(dir)
    %{bad_id: bad_id, stale_id: stale_id, resident_fp: resident_fp}
  end

  @tag :tmp_dir
  test "verified render carries banner, holders, reasons, glosses and the receipt caveat", %{
    tmp_dir: tmp
  } do
    dir = Path.join(tmp, "bundle")
    info = write_bundle(dir)

    assert {:ok, html, :verified} = AuditReport.render(dir)
    assert html =~ "VERIFIED: authenticity and projection consistency, not completeness"
    assert html =~ "Report matter"
    assert html =~ info.resident_fp
    assert html =~ info.bad_id
    assert html =~ "receipt_free?"
    assert html =~ "The legacy attestation stub is not receipt-free"
    assert html =~ "Omitted ill-formed delegations"

    {:ok, snap} = AuditBundle.load_verified(dir)
    model = Township.ReadModel.observe(snap.log, labels: snap.labels)

    assert Map.has_key?(model.roles.reasons, info.stale_id)

    for {id, reason} <- model.roles.reasons do
      assert html =~ id
      assert html =~ Atom.to_string(reason)
    end

    assert html =~ info.stale_id
    assert html =~ "not_holder"

    assert html =~ "did not hold the role"
  end

  @tag :tmp_dir
  test "a corrupt bundle renders only the failure banner and errors", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "bundle")
    write_bundle(dir)
    File.write!(Path.join(dir, "state.json"), "x", [:append])

    assert {:failed, html, errors} = AuditReport.render(dir)
    assert "state.json mismatch" in errors
    assert html =~ "NOT VERIFIED"
    assert html =~ "state.json mismatch"
    refute html =~ "Report matter"
    refute html =~ "<table"
    refute html =~ "<details"
  end

  @tag :tmp_dir
  test "render is byte-deterministic", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "bundle")
    write_bundle(dir)
    assert {:ok, a, :verified} = AuditReport.render(dir)
    assert {:ok, b, :verified} = AuditReport.render(dir)
    assert a == b
  end

  @tag :tmp_dir
  test "hostile post and label text is escaped", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "bundle")
    write_bundle(dir)
    assert {:ok, html, :verified} = AuditReport.render(dir)
    refute html =~ "<img"
    assert html =~ "&lt;img src=x onerror=alert(1)&gt;"
    refute html =~ "<b>"
    assert html =~ "&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;"
  end

  @tag :tmp_dir
  test "hostile verification error text is escaped", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "<script>alert(1)</script>")
    File.mkdir_p!(dir)
    assert {:failed, html, [_ | _]} = AuditReport.render(dir)
    refute html =~ "<script"
  end

  @tag :tmp_dir
  test "no script or URLs", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "bundle")
    write_bundle(dir)
    assert {:ok, html, :verified} = AuditReport.render(dir)
    refute html =~ "<script"
    refute html =~ "http://"
    refute html =~ "https://"
  end

  @tag :tmp_dir
  test "task writes an external report and leaves the bundle verifiable", %{tmp_dir: tmp} do
    Mix.shell(Mix.Shell.Process)
    on_exit(fn -> Mix.shell(Mix.Shell.IO) end)
    dir = Path.join(tmp, "bundle")
    write_bundle(dir)
    out = Path.join(tmp, "out/report.html")

    ReportTask.run(["--dir", dir, "--out", out])
    assert File.exists?(out)
    assert File.read!(out) =~ "VERIFIED"
    assert_received {:mix_shell, :info, [msg]}
    assert msg =~ "(VERIFIED)"
    assert :ok = AuditBundle.verify(dir)

    # default out sits beside the bundle dir
    ReportTask.run(["--dir", dir])
    assert File.exists?(Path.join(tmp, "bundle.report.html"))
  end

  @tag :tmp_dir
  test "task on a corrupt bundle raises but leaves the failure file", %{tmp_dir: tmp} do
    Mix.shell(Mix.Shell.Process)
    on_exit(fn -> Mix.shell(Mix.Shell.IO) end)
    dir = Path.join(tmp, "bundle")
    write_bundle(dir)
    File.write!(Path.join(dir, "state.json"), "x", [:append])
    out = Path.join(tmp, "bad.html")

    assert_raise Mix.Error, ~r/verification failed/, fn ->
      ReportTask.run(["--dir", dir, "--out", out])
    end

    assert File.read!(out) =~ "NOT VERIFIED"
  end

  @tag :tmp_dir
  test "task refuses --out inside the bundle", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "bundle")
    write_bundle(dir)
    before = Map.new(File.ls!(dir), &{&1, File.read!(Path.join(dir, &1))})

    assert_raise Mix.Error, ~r/inside the bundle/, fn ->
      ReportTask.run(["--dir", dir, "--out", Path.join(dir, "report.html")])
    end

    assert Map.new(File.ls!(dir), &{&1, File.read!(Path.join(dir, &1))}) == before
    assert :ok = AuditBundle.verify(dir)
  end

  test "task usage errors raise" do
    assert_raise Mix.Error, ~r/usage/, fn -> ReportTask.run([]) end
  end

  test "tracked bundle renders with its quarantine and label" do
    assert {:ok, html, :verified} = AuditReport.render(@tracked_dir)
    assert html =~ "not_holder"
    assert html =~ "resident"
    assert html =~ "Zoning variance #24"
  end
end
