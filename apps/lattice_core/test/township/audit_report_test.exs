defmodule Township.AuditReportTest do
  use ExUnit.Case, async: false

  alias Lattice.{Log, Sim}
  alias Mix.Tasks.Lattice.Township.Report, as: ReportTask
  alias Township.{AuditBundle, AuditReport, Matter, ReadModel}
  alias Township.Election.{Report, SecurityProfile}

  @moduletag timeout: 120_000

  @repo_root Path.expand("../../../..", __DIR__)
  @tracked_dir Path.join(@repo_root, "artifacts/township")
  @hostile_post "<img src=x onerror=alert(1)>"
  @hostile_label "<b>\"x\"&'y'</b>"
  @hostile_digest "<script>x</script>"

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

  # Rows 401 + 402: succession, beacons, leases and link_election commands in one log.
  # `succession_sim/0` is copied from authority_observe_test.exs, plus a realm with no
  # capability at all.
  defp succession_sim do
    sim =
      Sim.new(
        Matter,
        "replica:matter:report-observe",
        ["clerk", "resident", "neighbor", "outsider"],
        seed: "report-observe"
      )

    {sim, genesis} =
      Sim.create_replica(sim, "clerk",
        policies: %{clerk: %{successor: "resident", dormant_ticks: 2}}
      )

    {Sim.sync_all(sim), genesis}
  end

  defp observe_scenario do
    {sim, genesis} = succession_sim()
    {sim, claim} = Sim.succeed(sim, "resident", :clerk, at_tick: 3, ops: [:close_matter])
    sim = Sim.sync_all(sim)
    {sim, deleg} = Sim.transfer(sim, "resident", "neighbor", :clerk, ops: [:close_matter])
    sim = Sim.sync_all(sim)

    {sim, b1} = Sim.beacon(sim, "clerk", 1)
    {sim, b5} = Sim.beacon(sim, "clerk", 5)
    {sim, stale} = Sim.beacon(sim, "clerk", 2)
    sim = Sim.sync_all(sim)
    {sim, non_root} = Sim.beacon(sim, "resident", 9)
    sim = Sim.sync_all(sim)

    {sim, expired} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 3)
    {sim, active} = Sim.grant(sim, "clerk", "neighbor", ops: [:post], expires_epoch: 9)
    {sim, _link_cap} = Sim.grant(sim, "clerk", "resident", ops: [:link_election])
    sim = Sim.sync_all(sim)

    {sim, hostile} = Sim.command(sim, "resident", :link_election, [@hostile_digest])
    {sim, listy} = Sim.command(sim, "resident", :link_election, [[123]])
    sim = Sim.sync_all(sim)
    {sim, unauth} = Sim.command(sim, "outsider", :link_election, ["digest:outsider"])
    sim = Sim.sync_all(sim)

    log = Sim.log(sim, "clerk")

    transfer_op =
      Enum.find(Log.topo_ops(log), &match?({:transfer, :clerk, ^deleg, _}, &1.body))

    %{
      sim: sim,
      log: log,
      chronology: [genesis.id, claim.id, transfer_op.id],
      transfer_delegation: deleg.id,
      beacons: [b1.id, b5.id],
      stale: stale.id,
      non_root: non_root.id,
      expired: expired.id,
      active: active.id,
      hostile: hostile.id,
      listy: listy.id,
      unauth: unauth.id
    }
  end

  defp fp(sim, realm), do: Lattice.Identity.fingerprint(Sim.identity(sim, realm))

  defp write_observe_bundle(dir, info \\ observe_scenario()) do
    assert {:ok, _} = AuditBundle.write(dir, info.log)
    assert :ok = AuditBundle.verify(dir)
    info
  end

  # The slice from `<h2>heading</h2>` up to the next `<h2`.
  defp section(html, heading) do
    [_, rest] = String.split(html, "<h2>#{heading}</h2>", parts: 2)
    [slice | _] = String.split(rest, "<h2", parts: 2)
    slice
  end

  defp election_slice(html) do
    [_, rest] = String.split(html, "<h2>Election evidence</h2>", parts: 2)
    [slice, _] = String.split(rest, "<h2>Trust graph</h2>", parts: 2)
    slice
  end

  defp model_for(dir) do
    {:ok, snap} = AuditBundle.load_verified(dir)
    ReadModel.observe(snap.log, labels: snap.labels)
  end

  defp count(html, substring), do: length(String.split(html, substring)) - 1

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
    model = ReadModel.observe(snap.log, labels: snap.labels)

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
    # Row 325 (D-880): the read model replaces non-text Matter values with the
    # malformed marker before the bundle is written, so the report shows the marker.
    assert html =~ "<li>(malformed)</li>"
    refute html =~ "hello"
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
    assert File.read!(out) == elem(AuditReport.render(dir), 1)
    assert File.ls!(Path.dirname(out)) == ["report.html"]
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
  test "large text state renders in full", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "bundle")
    sim = Sim.new(Matter, "replica:matter:large", ["clerk"], seed: "report-large")
    {sim, _} = Sim.create_replica(sim, "clerk")
    {sim, _} = Sim.command(sim, "clerk", :post, [Enum.to_list(1..150)])
    long = String.duplicate("a", 5000) <> "TAIL_MARKER"
    {sim, _} = Sim.command(sim, "clerk", :post, [long])
    assert {:ok, _} = AuditBundle.write(dir, Sim.log(sim, "clerk"))

    assert {:ok, html, :verified} = AuditReport.render(dir)
    assert html =~ "<li>(malformed)</li>"
    assert html =~ "TAIL_MARKER"
    refute html =~ "..."
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
  test "task replaces a symlink or hard link at --out, never writing through", %{tmp_dir: tmp} do
    Mix.shell(Mix.Shell.Process)
    on_exit(fn -> Mix.shell(Mix.Shell.IO) end)
    dir = Path.join(tmp, "bundle")
    write_bundle(dir)
    {:ok, expected, :verified} = AuditReport.render(dir)
    victim = Path.join(tmp, "victim.txt")
    File.write!(victim, "victim bytes")
    out_dir = Path.join(tmp, "out")
    File.mkdir_p!(out_dir)

    for {name, link!} <- [{"sym.html", &File.ln_s!/2}, {"hard.html", &File.ln!/2}] do
      out = Path.join(out_dir, name)
      link!.(victim, out)

      ReportTask.run(["--dir", dir, "--out", out])
      assert File.read!(victim) == "victim bytes"
      assert File.lstat!(out).type == :regular
      assert File.read!(out) == expected
    end

    assert Enum.sort(File.ls!(out_dir)) == ["hard.html", "sym.html"]
    assert :ok = AuditBundle.verify(dir)
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
    assert html =~ "<h2>Role chronology</h2>"
    assert html =~ "<h2>Election evidence</h2>"
    assert html =~ "No accepted beacons."
    assert html =~ "No leased delegations."
    assert html =~ "No link_election command in this matter log."
  end

  describe "rows 401 + 402 sections" do
    @describetag :tmp_dir

    test "role chronology lists clerk acquisitions oldest first, without ticks", %{
      tmp_dir: tmp
    } do
      dir = Path.join(tmp, "bundle")
      info = write_observe_bundle(dir)
      assert {:ok, html, :verified} = AuditReport.render(dir)

      chronology = section(html, "Role chronology")
      [_, clerk] = String.split(chronology, "<h3>clerk</h3>", parts: 2)

      rows =
        ~r{<tr><td>(\d+)</td><td>([^<]*)</td><td>([^<]*)</td><td>([^<]*)</td></tr>}
        |> Regex.scan(clerk)
        |> Enum.map(fn [_, n, holder, id, deleg] -> {n, holder, id, deleg} end)

      holders = Enum.map(["clerk", "resident", "neighbor"], &fp(info.sim, &1))
      delegations = Enum.map(model_for(dir).roles.chronology.clerk, & &1.delegation_id)

      assert rows ==
               [["1", "2", "3"], holders, info.chronology, delegations]
               |> Enum.zip()

      assert List.last(delegations) == info.transfer_delegation
      assert delegations |> Enum.uniq() |> length() == 3
      assert Enum.all?(delegations, &(is_binary(&1) and &1 != ""))
      assert chronology =~ "Author-asserted ticks are untrusted (ADR 0004) and are not shown"
      refute chronology =~ "at_tick"
      refute chronology =~ "tick 3"
      refute chronology =~ ~r/dorman/i
    end

    test "beacons show the global max epoch and accepted beacons only", %{tmp_dir: tmp} do
      dir = Path.join(tmp, "bundle")
      info = write_observe_bundle(dir)
      assert {:ok, html, :verified} = AuditReport.render(dir)

      beacons = section(html, "Beacons")
      assert beacons =~ "Highest accepted beacon epoch on this log: 5"

      assert beacons =~
               "A beacon is a logical tick accepted under the replica&#39;s beacon policy"

      refute beacons =~ "root-signed"

      ids =
        ~r{<tr><td>([^<]*)</td><td>(\d+)</td></tr>}
        |> Regex.scan(beacons)
        |> Enum.map(fn [_, id, _] -> id end)

      assert Enum.sort(ids) == Enum.sort(info.beacons)
      refute beacons =~ info.stale
      refute beacons =~ info.non_root

      ledger = section(html, "Authority ledger")
      assert ledger =~ ~r/#{info.stale}<\/td><td>stale_beacon:/
      assert ledger =~ ~r/#{info.non_root}<\/td><td>unauthorized_beacon:/
    end

    test "a witness-certified beacon is listed without calling it root-signed", %{
      tmp_dir: tmp
    } do
      dir = Path.join(tmp, "bundle")
      sim = Sim.new(Matter, "replica:matter:report-witnessed", ["clerk", "w0", "w1"])

      policy = %{mode: :witnessed, version: 1, witnesses: ["w0", "w1"], threshold: 2}

      {sim, _} =
        Sim.create_replica(sim, "clerk",
          policies: %{__beacon__: Map.put(policy, :max_epoch_step, 10)}
        )

      {sim, beacon} = Sim.beacon(Sim.sync_all(sim), "w0", 4, witnesses: ["w0", "w1"])
      log = sim |> Sim.sync_all() |> Sim.log("clerk")
      refute beacon.author == Sim.identity(sim, "clerk").pub
      assert {:ok, _} = AuditBundle.write(dir, log)

      assert {:ok, html, :verified} = AuditReport.render(dir)
      beacons = section(html, "Beacons")
      assert beacons =~ "Highest accepted beacon epoch on this log: 4"
      assert beacons =~ "<tr><td>#{beacon.id}</td><td>4</td></tr>"
      assert beacons =~ "accepted under the replica&#39;s beacon policy, not a clock."
      refute beacons =~ "root-signed"
    end

    test "leases render the read model's lease view sorted by delegation", %{tmp_dir: tmp} do
      dir = Path.join(tmp, "bundle")
      info = write_observe_bundle(dir)
      assert {:ok, html, :verified} = AuditReport.render(dir)
      leases = model_for(dir).roles.leases

      assert Enum.sort([info.expired, info.active]) ==
               leases |> Enum.map(& &1.delegation_id) |> Enum.sort()

      rendered =
        ~r{<tr><td>([^<]*)</td><td>([^<]*)</td><td>([^<]*)</td><td>(\d+)</td><td>(true|false)</td><td>([a-z]+)</td></tr>}
        |> Regex.scan(section(html, "Leases"))
        |> Enum.map(fn [_, id, issuer, audience, epoch, expired, status] ->
          {id, issuer, audience, epoch, expired, status}
        end)

      expected =
        leases
        |> Enum.sort_by(& &1.delegation_id)
        |> Enum.map(fn l ->
          {l.delegation_id, l.issuer, l.audience, to_string(l.expires_epoch),
           to_string(l.expired?), to_string(l.status)}
        end)

      assert rendered == expected
      clerk = fp(info.sim, "clerk")
      resident = fp(info.sim, "resident")
      neighbor = fp(info.sim, "neighbor")
      assert {_, ^clerk, ^resident, "3", "true", _} = List.keyfind(rendered, info.expired, 0)

      assert {_, ^clerk, ^neighbor, "9", "false", "active"} =
               List.keyfind(rendered, info.active, 0)
    end

    test "election evidence lists link commands with their verdict and the manifest", %{
      tmp_dir: tmp
    } do
      dir = Path.join(tmp, "bundle")
      info = write_observe_bundle(dir)
      assert {:ok, html, :verified} = AuditReport.render(dir)
      model = model_for(dir)
      assert model.roles.reasons[info.hostile] == nil
      assert model.roles.reasons[info.listy] == nil
      assert reason = model.roles.reasons[info.unauth]

      slice = election_slice(html)
      assert slice =~ "carries no election board, election spec, projection or close evidence"
      assert slice =~ "not a verified election link"

      rows =
        ~r{<tr><td>([^<]*)</td><td>([^<]*)</td><td>([^<]*)</td><td>([^<]*)</td></tr>}
        |> Regex.scan(section(html, "Election evidence"))
        |> Map.new(fn [_, id, author, digest, verdict] -> {id, {author, digest, verdict}} end)

      resident = fp(info.sim, "resident")
      outsider = fp(info.sim, "outsider")
      assert map_size(rows) == 3

      assert rows[info.hostile] ==
               {resident, "&lt;script&gt;x&lt;/script&gt;", "honored in this log"}

      assert rows[info.listy] == {resident, "[123]", "honored in this log"}
      assert {^outsider, "digest:outsider", verdict} = rows[info.unauth]
      assert verdict =~ "#{reason}: "
      refute html =~ "<script"

      assert count(html, ~s(<td class="claim-status">not_claimed</td>)) == 12
      manifest = IO.iodata_to_binary(Report.security_manifest_html())
      assert String.contains?(html, manifest)
      assert String.contains?(html, Report.honesty_sentence())

      assert slice =~
               "Research manifest claim_set_id</dt><dd><code>" <>
                 SecurityProfile.claim_set_id()

      lower = String.downcase(slice)

      for banned <- ["guaranteed", "proven", "receipt-free: yes", "secure election", "supported"] do
        refute lower =~ banned, "election slice contains #{inspect(banned)}"
      end
    end

    test "a vacant role renders as vacant, not as an unknown key", %{tmp_dir: tmp} do
      dir = Path.join(tmp, "bundle")
      sim = Sim.new(Matter, "replica:matter:report-vacant", ["clerk"], seed: "report-vacant")
      assert {:ok, _} = AuditBundle.write(dir, Sim.log(sim, "clerk"))
      assert model_for(dir).roles.holders == %{clerk: nil}

      assert {:ok, html, :verified} = AuditReport.render(dir)
      holders = section(html, "Current holders")
      assert holders =~ "<tr><td>clerk</td><td>none (vacant)</td><td></td></tr>"
      refute holders =~ "unknown key"
    end

    test "a nil or non-list link_election argument never renders as an empty cell", %{
      tmp_dir: tmp
    } do
      dir = Path.join(tmp, "bundle")
      {sim, _} = succession_sim()
      {sim, _} = Sim.grant(sim, "clerk", "resident", ops: [:link_election])
      sim = Sim.sync_all(sim)
      {sim, nil_arg} = Sim.command(sim, "resident", :link_election, [nil])
      {sim, empty} = Sim.command(sim, "resident", :link_election, [""])
      {sim, bare} = Sim.append(sim, "resident", :command, {:link_election, nil})
      log = sim |> Sim.sync_all() |> Sim.log("clerk")
      assert {:ok, _} = AuditBundle.write(dir, log)

      assert {:ok, html, :verified} = AuditReport.render(dir)

      digests =
        ~r{<tr><td>([^<]*)</td><td>[^<]*</td><td>([^<]*)</td><td>[^<]*</td></tr>}
        |> Regex.scan(section(html, "Election evidence"))
        |> Map.new(fn [_, id, digest] -> {id, digest} end)

      assert digests[nil_arg.id] == "nil"
      assert digests[empty.id] == ""
      assert digests[bare.id] == "nil"
    end

    test "a bundle without beacons, leases or links shows the empty states", %{tmp_dir: tmp} do
      dir = Path.join(tmp, "bundle")
      write_bundle(dir)
      assert {:ok, html, :verified} = AuditReport.render(dir)
      assert html =~ "No accepted beacons."
      assert html =~ "No leased delegations."
      assert html =~ "No link_election command in this matter log."
      refute html =~ "<td>nil</td>"
    end

    test "the failed page carries none of the new sections", %{tmp_dir: tmp} do
      dir = Path.join(tmp, "bundle")
      write_observe_bundle(dir)
      File.write!(Path.join(dir, "state.json"), "x", [:append])
      assert {:failed, html, _} = AuditReport.render(dir)

      for heading <- ["Role chronology", "Beacons", "Leases", "Election evidence"] do
        refute html =~ heading
      end

      refute html =~ "Security manifest"
    end

    test "new sections are byte-deterministic and carry no script or URL", %{tmp_dir: tmp} do
      info = observe_scenario()
      a_dir = Path.join(tmp, "a")
      b_dir = Path.join(tmp, "b")
      write_observe_bundle(a_dir, info)
      write_observe_bundle(b_dir, info)
      assert {:ok, a, :verified} = AuditReport.render(a_dir)
      assert {:ok, ^a, :verified} = AuditReport.render(a_dir)
      assert {:ok, b, :verified} = AuditReport.render(b_dir)
      assert a != b
      assert String.replace(a, "<code>#{a_dir}</code>", "<code>#{b_dir}</code>") == b

      refute a =~ "<script"
      refute a =~ "http://"
      refute a =~ "https://"
    end
  end
end
