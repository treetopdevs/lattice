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

    assert html =~ "was not a holder of the role"

    # the holder table binds clerk to the resident fingerprint, not just any mention
    [_, after_holders] = String.split(html, "<h2>Current holders</h2>", parts: 2)
    [holders, _] = String.split(after_holders, "<h2>", parts: 2)

    assert holders =~
             ~r/<td>clerk<\/td><td>[^<]*#{info.resident_fp}[^<]*<\/td><td>#{info.resident_fp}<\/td>/
  end

  @tag :tmp_dir
  test "structured and integer-list state renders without crashing", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "bundle")
    sim = Sim.new(Matter, "replica:matter:structured", ["clerk"], seed: "report-structured")
    {sim, _} = Sim.create_replica(sim, "clerk")
    {sim, _} = Sim.command(sim, "clerk", :post, [%{"text" => "hello"}])
    {sim, _} = Sim.command(sim, "clerk", :post, [[65, 66]])
    assert {:ok, _} = AuditBundle.write(dir, Sim.log(sim, "clerk"))

    assert {:ok, html, :verified} = AuditReport.render(dir)
    assert html =~ "hello"
    assert html =~ "[65, 66]"
    refute html =~ "<li>AB</li>"
  end

  @tag :tmp_dir
  test "structural rejections are listed and counted separately", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "bundle")
    sim = Sim.new(Matter, "replica:matter:rejected", ["clerk"], seed: "report-rejected")
    {sim, _} = Sim.create_replica(sim, "clerk")
    {sim, post} = Sim.command(sim, "clerk", :post, ["accepted post"])
    rejected = %{post | body: {:post, ["rejected post"]}, sig: <<0::512>>}
    rejected = %{rejected | id: Lattice.Op.recompute_id(rejected)}
    {:quarantined, log, :bad_signature} = Lattice.Log.accept(Sim.log(sim, "clerk"), rejected)
    assert {:ok, _} = AuditBundle.write(dir, log)

    assert {:ok, html, :verified} = AuditReport.render(dir)
    assert html =~ "Structurally rejected operations"
    assert html =~ rejected.id
    assert html =~ "bad_signature"
    assert html =~ "Structurally rejected</dt><dd><code>1</code>"
    assert html =~ "Authority-quarantined</dt><dd><code>0</code>"
  end

  @tag :tmp_dir
  test "beacon gloss does not name a signer", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "bundle")
    sim = Sim.new(Matter, "replica:matter:beacon", ["clerk"], seed: "report-beacon")
    {sim, _} = Sim.create_replica(sim, "clerk")
    {sim, beacon} = Sim.append(sim, "clerk", :authority, {:beacon, 1, %{}})
    assert {:ok, _} = AuditBundle.write(dir, Sim.log(sim, "clerk"))

    assert {:ok, html, :verified} = AuditReport.render(dir)
    assert html =~ beacon.id
    assert html =~ "unauthorized_beacon"
    refute html =~ "someone other than the root"
    assert html =~ "does not identify who signed it"
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
    dir = Path.join(tmp, "bundle")
    write_bundle(dir)
    File.write!(Path.join(dir, "<img src=x onerror=alert(1)>.txt"), "x")

    assert {:failed, html, [_ | _]} = AuditReport.render(dir)
    refute html =~ "<img"
    assert html =~ "&lt;img src=x onerror=alert(1)&gt;.txt"
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

  @tag :tmp_dir
  test "task refuses --out reached through a symlink into the bundle", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "bundle")
    write_bundle(dir)
    alias_dir = Path.join(tmp, "alias")
    File.ln_s!(dir, alias_dir)
    before = Map.new(File.ls!(dir), &{&1, File.read!(Path.join(dir, &1))})

    assert_raise Mix.Error, ~r/inside the bundle/, fn ->
      ReportTask.run(["--dir", dir, "--out", Path.join(alias_dir, "matter.log")])
    end

    assert_raise Mix.Error, ~r/inside the bundle/, fn ->
      ReportTask.run(["--dir", alias_dir, "--out", Path.join(dir, "matter.log")])
    end

    link = Path.join(tmp, "link.html")
    File.ln_s!(Path.join(dir, "matter.log"), link)

    assert_raise Mix.Error, ~r/inside the bundle/, fn ->
      ReportTask.run(["--dir", dir, "--out", link])
    end

    assert Map.new(File.ls!(dir), &{&1, File.read!(Path.join(dir, &1))}) == before
    assert :ok = AuditBundle.verify(dir)
  end

  @tag :tmp_dir
  test "large structured state renders in full", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "bundle")
    sim = Sim.new(Matter, "replica:matter:large", ["clerk"], seed: "report-large")
    {sim, _} = Sim.create_replica(sim, "clerk")
    {sim, _} = Sim.command(sim, "clerk", :post, [Enum.to_list(1..150)])
    long = %{"text" => String.duplicate("a", 5000) <> "TAIL_MARKER"}
    {sim, _} = Sim.command(sim, "clerk", :post, [long])
    assert {:ok, _} = AuditBundle.write(dir, Sim.log(sim, "clerk"))

    assert {:ok, html, :verified} = AuditReport.render(dir)
    assert html =~ "149, 150]"
    assert html =~ "TAIL_MARKER"
    refute html =~ "100, ..."
  end

  @tag :tmp_dir
  test "reason glosses do not assert unestablished facts", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "bundle")
    write_bundle(dir)
    assert {:ok, html, :verified} = AuditReport.render(dir)
    assert html =~ "not_holder: The author was not a holder of the role in the log view"
    refute html =~ "carried no capability."
    refute html =~ "had lapsed at the action"
    refute html =~ "when the action was taken"
  end

  @tag :tmp_dir
  test "task refuses --out that is a hard link to a bundle file", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "bundle")
    write_bundle(dir)
    link = Path.join(tmp, "hard.html")
    :ok = File.ln(Path.join(dir, "matter.log"), link)
    before = File.read!(Path.join(dir, "matter.log"))

    assert_raise Mix.Error, ~r/inside the bundle/, fn ->
      ReportTask.run(["--dir", dir, "--out", link])
    end

    assert File.read!(Path.join(dir, "matter.log")) == before
  end

  @tag :tmp_dir
  test "task refuses a case alias of the bundle directory", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "bundle")
    write_bundle(dir)
    upper = Path.join(tmp, "BUNDLE")

    # Only meaningful on a case-insensitive filesystem; elsewhere the alias is a new path.
    if File.exists?(upper) do
      before = File.read!(Path.join(dir, "matter.log"))

      assert_raise Mix.Error, ~r/inside the bundle/, fn ->
        ReportTask.run(["--dir", dir, "--out", Path.join(upper, "matter.log")])
      end

      assert File.read!(Path.join(dir, "matter.log")) == before
    end
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
