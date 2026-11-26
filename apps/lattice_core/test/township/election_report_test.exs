defmodule Township.ElectionReportTest do
  # async: false because the CLI cases swap Mix.shell/1.
  use ExUnit.Case, async: false

  alias Mix.Tasks.Lattice.Election.Report, as: ReportTask
  alias Township.Election.{OfflineBundle, Projection, Report, SecurityProfile}
  alias Township.ElectionReportFixture

  @status_cell ~r{<td class="claim-status">([^<]*)</td>}
  # Independent copy of the research manifest, in sorted scope order.
  @scopes [
    {"availability", "ability to complete setup, close, and tally"},
    {"ballot_privacy", "choice confidentiality beyond the ideal tally leakage"},
    {"board_integrity", "authorized immutable board publication"},
    {"censorship_resistance", "resistance to selective ballot denial"},
    {"closure_safety", "uniqueness and completeness of the certified ballot manifest"},
    {"convergence", "deterministic projection from a complete artifact set"},
    {"credential_surrender_resistance", "safety after credential surrender"},
    {"eligibility", "encrypted credential eligibility and duplicate handling"},
    {"forced_abstention_resistance", "safety under participation surveillance"},
    {"forced_choice_resistance", "safety under a demanded choice"},
    {"receipt_freeness", "inability to prove a vote to a coercer"},
    {"universal_verifiability", "public verification of the final result transcript"}
  ]
  @scope_row ~r{<tr><td><code>([^<]*)</code></td><td>([^<]*)</td><td class="claim-status">}
  @exclusions [
    "no pinned cryptographic construction",
    "no completed operational composition review"
  ]

  setup_all do
    scenario = ElectionReportFixture.close_scenario()
    bytes = ElectionReportFixture.bundle_bytes(scenario)
    {:ok, projection} = OfflineBundle.verify_bytes(bytes)

    %{
      scenario: scenario,
      bytes: bytes,
      projection: projection,
      tampered: ElectionReportFixture.tampered_projection(scenario)
    }
  end

  defp count(html, substring), do: length(String.split(html, substring)) - 1

  defp hand_built(status, overrides \\ []) do
    struct!(
      %Projection{
        election_id: "election:hand-built",
        phase: :setup,
        status: status,
        close_id: nil,
        rejected: [],
        faults: [],
        claim_set_id: SecurityProfile.claim_set_id()
      },
      overrides
    )
  end

  describe "honesty" do
    test "the fixed sentence heads the report and all twelve scopes are not_claimed", ctx do
      assert Report.honesty_sentence() =~ "makes no security claim"

      assert Report.honesty_sentence() ==
               "This election foundation makes no security claim. Every scope below is " <>
                 "explicitly not claimed; the profile's construction is unselected."

      html = Report.render(ctx.projection)

      assert html =~ ~s(<p class="honesty">#{Report.honesty_sentence()}</p>)
      assert length(Regex.scan(~r{<td class="claim-status">not_claimed</td>}, html)) == 12
      assert count(html, "not_claimed") == 12

      rows = @scope_row |> Regex.scan(html) |> Enum.map(fn [_, name, desc] -> {name, desc} end)
      assert rows == @scopes

      for {name, desc} <- @scopes do
        assert count(html, "<td><code>#{name}</code></td><td>#{desc}</td>") == 1
      end
    end

    # Maintenance: when an M4 gate flips a claim to :conditional, this test must be
    # edited deliberately so the change is loud.
    test "no claim inflation", ctx do
      html = Report.render(ctx.projection, close_evidence: ctx.scenario.evidence)
      lower = String.downcase(html)

      for banned <- [
            "guaranteed",
            "proven",
            "receipt-free: yes",
            "secure election",
            "supported",
            "pending claim"
          ] do
        refute lower =~ banned, "report contains #{inspect(banned)}"
      end

      statuses = @status_cell |> Regex.scan(html) |> Enum.map(&List.last/1)
      assert length(statuses) == 12
      assert Enum.all?(statuses, &(&1 in ["not_claimed", "conditional", "failed"]))

      for exclusion <- @exclusions do
        assert count(html, "<li><code>#{exclusion}</code></li>") == 12
      end
    end
  end

  describe "projection variants" do
    test "a verified bundle projection renders pending with profile_unselected", ctx do
      assert {:pending, [:profile_unselected]} = ctx.projection.status
      html = Report.render(ctx.projection)

      assert html =~ "<tr><th>status</th><td><code>pending</code></td></tr>"
      assert html =~ "<li><code>:profile_unselected</code></li>"
      assert html =~ "<tr><th>phase</th><td><code>setup</code></td></tr>"
      assert html =~ "<h3>rejected</h3>\n<p>none</p>"
      assert html =~ "<h3>faults</h3>\n<p>none</p>"
      assert html =~ ctx.projection.election_id
    end

    test "a tampered ballot renders invalid with its reason, digest and op id", ctx do
      assert {:invalid, [finding]} = ctx.tampered.status
      assert finding.reason == :artifact_size_mismatch
      assert ctx.tampered.rejected == [finding]

      html = Report.render(ctx.tampered)
      assert html =~ "<tr><th>status</th><td><code>invalid</code></td></tr>"

      row = "<tr><th>reason</th><td><code>artifact_size_mismatch</code></td></tr>"
      digest = "<tr><th>digest</th><td><code>#{finding.digest}</code></td></tr>"
      op_id = "<tr><th>op_id</th><td><code>#{finding.op_id}</code></td></tr>"

      # once in the findings table, once in the rejected table
      assert count(html, row) == 2
      assert count(html, digest) == 2
      assert count(html, op_id) == 2
    end

    test "hand-built forked, aborted and final statuses render tag and payload" do
      forked = Report.render(hand_built({:forked, [%{reason: :x_fork}]}))
      assert forked =~ "<tr><th>status</th><td><code>forked</code></td></tr>"
      assert forked =~ "<tr><th>reason</th><td><code>x_fork</code></td></tr>"

      aborted = Report.render(hand_built({:aborted, :x_abort}))
      assert aborted =~ "<tr><th>status</th><td><code>aborted</code></td></tr>"
      assert aborted =~ ~s(<pre class="mono">:x_abort</pre>)

      final = Report.render(hand_built({:final, :x_result}))
      assert final =~ "<tr><th>status</th><td><code>final</code></td></tr>"
      assert final =~ ~s(<pre class="mono">:x_result</pre>)

      faulted =
        Report.render(
          hand_built({:pending, [:profile_unselected]}, faults: [%{reason: :x_fault}])
        )

      assert faulted =~
               "<h3>faults</h3>\n<div class=\"scroll\"><table>\n" <>
                 "<tr><th>reason</th><td><code>x_fault</code></td></tr>\n"
    end
  end

  describe "close evidence" do
    test "renders the caveat, prerequisite and every id only when passed", ctx do
      evidence = ctx.scenario.evidence
      html = Report.render(ctx.projection, close_evidence: evidence)

      assert html =~
               "<p class=\"caveat\">This value is not global election finality and never " <>
                 "advances the public foundation projection beyond <code>:setup</code>.</p>"

      assert html =~ "<h2 id=\"close-evidence\">Close evidence</h2>"
      assert html =~ "<td><code>administrative_open_asserted</code></td>"

      assert html =~
               "<tr><th>open_certificate_id (operator-asserted)</th><td><code>" <>
                 "#{ctx.scenario.open_certificate_id}</code></td></tr>"

      assert length(evidence.ballot_wrapper_ids) == 2
      assert length(evidence.seal_digests) == 2
      assert length(evidence.certificate_op_ids) == 1

      for {label, ids} <- [
            {"ballot_wrapper_ids", evidence.ballot_wrapper_ids},
            {"ballot_digests", evidence.ballot_digests},
            {"seal_digests", evidence.seal_digests},
            {"certificate_op_ids", evidence.certificate_op_ids}
          ] do
        items = Enum.map_join(ids, &"<li><code>#{&1}</code></li>")
        assert html =~ "<h3>#{label} (#{length(ids)})</h3>\n<ol>#{items}</ol>\n"
      end

      assert html =~ "<h3>ballot_wrapper_ids (2)</h3>"
      assert html =~ "<h3>seal_digests (2)</h3>"
      assert html =~ "<h3>certificate_op_ids (1)</h3>"

      without = Report.render(ctx.projection)
      refute without =~ "Close evidence"
      refute without =~ "close-evidence"
      refute without =~ "not global election finality"
    end

    test "rejects unknown options and non-evidence values", ctx do
      assert_raise ArgumentError, fn -> Report.render(ctx.projection, unknown: true) end
      assert_raise ArgumentError, fn -> Report.render(ctx.projection, close_evidence: %{}) end
    end
  end

  describe "self-containment, escaping and determinism" do
    test "no scripts or URLs, byte-identical renders, escaped values", ctx do
      html = Report.render(ctx.projection, close_evidence: ctx.scenario.evidence)

      refute html =~ "<script"
      refute html =~ "http"
      refute html =~ "xmlns"
      assert String.starts_with?(html, "<!doctype html>")
      assert html =~ ~s(<meta charset="utf-8">)
      assert html == Report.render(ctx.projection, close_evidence: ctx.scenario.evidence)

      hostile =
        Report.render(
          hand_built({:pending, [:profile_unselected]},
            rejected: [%{reason: :x, op_id: "<b>x</b>", note: ~s("a" & 'b')}]
          )
        )

      assert hostile =~ "&lt;b&gt;x&lt;/b&gt;"
      refute hostile =~ "<b>x</b>"
      assert hostile =~ "&quot;a&quot; &amp; 'b'"
    end

    test "a claim set id mismatch says no and relabels the manifest", ctx do
      matching = Report.render(ctx.projection)

      assert matching =~
               "<tr><th>claim set id matches research manifest</th><td>yes</td></tr>"

      mismatched = Report.render(%{ctx.projection | claim_set_id: "some-other-claim-set"})

      assert mismatched =~
               "<tr><th>claim set id matches research manifest</th><td>no</td></tr>"

      assert mismatched =~ "module research manifest (not the one this projection names)"
      assert count(mismatched, "not_claimed") == 12
    end
  end

  describe "mix lattice.election.report" do
    setup do
      previous = Mix.shell()
      Mix.shell(Mix.Shell.Process)
      on_exit(fn -> Mix.shell(previous) end)
      :ok
    end

    @tag :tmp_dir
    test "writes a verified report, with close evidence only on request", ctx do
      bundle = Path.join(ctx.tmp_dir, "bundle.etf")
      File.write!(bundle, ctx.bytes)

      out = Path.join([ctx.tmp_dir, "plain", "report.html"])
      assert :ok = ReportTask.run(["--bundle", bundle, "--out", out])

      html = File.read!(out)
      assert html =~ ctx.projection.election_id
      assert html =~ Report.honesty_sentence()
      refute html =~ "Close evidence"
      assert File.ls!(Path.dirname(out)) == ["report.html"]
      assert_received {:mix_shell, :info, ["Election evidence report written: " <> ^out]}
      assert_received {:mix_shell, :info, ["projection verified by offline replay"]}

      closed = Path.join(ctx.tmp_dir, "closed.html")
      id = ctx.scenario.open_certificate_id

      assert :ok =
               ReportTask.run(["--bundle", bundle, "--out", closed, "--open-certificate", id])

      assert File.read!(closed) =~ "<h2 id=\"close-evidence\">Close evidence</h2>"
      expected = "close evidence verified under operator-asserted open certificate #{id}"
      assert_received {:mix_shell, :info, [^expected]}
    end

    @tag :tmp_dir
    test "replaces a symlink or hard link at --out, never writing through", ctx do
      bundle = Path.join(ctx.tmp_dir, "bundle.etf")
      File.write!(bundle, ctx.bytes)
      expected = Report.render(ctx.projection)
      victim = Path.join(ctx.tmp_dir, "victim.txt")
      File.write!(victim, "victim bytes")
      out_dir = Path.join(ctx.tmp_dir, "out")
      File.mkdir_p!(out_dir)

      for {name, link!} <- [{"sym.html", &File.ln_s!/2}, {"hard.html", &File.ln!/2}] do
        out = Path.join(out_dir, name)
        link!.(victim, out)

        assert :ok = ReportTask.run(["--bundle", bundle, "--out", out])
        assert File.read!(victim) == "victim bytes"
        assert File.lstat!(out).type == :regular
        assert File.read!(out) == expected
      end

      assert Enum.sort(File.ls!(out_dir)) == ["hard.html", "sym.html"]
      assert File.read!(bundle) == ctx.bytes
    end

    @tag :tmp_dir
    test "fails closed on a wrong certificate, a corrupted bundle or bad usage", ctx do
      bundle = Path.join(ctx.tmp_dir, "bundle.etf")
      File.write!(bundle, ctx.bytes)
      out = Path.join([ctx.tmp_dir, "never", "report.html"])

      assert_raise Mix.Error, ~r/close evidence not verified/, fn ->
        ReportTask.run(["--bundle", bundle, "--out", out, "--open-certificate", "wrong-id"])
      end

      refute File.exists?(out)

      flipped = Path.join(ctx.tmp_dir, "flipped.etf")
      middle = div(byte_size(ctx.bytes), 2)
      <<head::binary-size(middle), byte, tail::binary>> = ctx.bytes
      File.write!(flipped, <<head::binary, Bitwise.bxor(byte, 1), tail::binary>>)

      junk = Path.join(ctx.tmp_dir, "junk.etf")
      File.write!(junk, "junk")

      for path <- [flipped, junk] do
        assert_raise Mix.Error, ~r/offline bundle verification failed/, fn ->
          ReportTask.run(["--bundle", path, "--out", out])
        end

        refute File.exists?(out)
      end

      refute File.exists?(Path.dirname(out))

      # A sparse file one byte past the envelope limit is refused before verification.
      oversized = Path.join(ctx.tmp_dir, "oversized.etf")
      limit = OfflineBundle.max_envelope_byte_size()

      File.open!(oversized, [:write, :binary], fn io ->
        {:ok, _} = :file.position(io, limit)
        :ok = IO.binwrite(io, "x")
      end)

      assert File.stat!(oversized).size == limit + 1

      assert_raise Mix.Error, ~r/offline bundle exceeds #{limit} bytes/, fn ->
        ReportTask.run(["--bundle", oversized, "--out", out])
      end

      refute File.exists?(out)

      link = Path.join(ctx.tmp_dir, "bundle-link.etf")
      File.ln_s!(bundle, link)
      hard_link = Path.join(ctx.tmp_dir, "bundle-hard-link.etf")
      File.ln!(bundle, hard_link)

      for target <- [bundle, link, hard_link] do
        assert_raise Mix.Error, ~r/--out must not be the --bundle file/, fn ->
          ReportTask.run(["--bundle", bundle, "--out", target])
        end
      end

      assert File.read!(bundle) == ctx.bytes

      for argv <- [
            ["--bundle", bundle],
            ["--out", out],
            ["--bundle", bundle, "--out", out, "--open-certificate", ""],
            ["--bundle", bundle, "--out", out, "extra"],
            ["--bundle", bundle, "--out", out, "--unknown", "x"]
          ] do
        assert_raise Mix.Error, ~r/usage: mix lattice.election.report/, fn ->
          ReportTask.run(argv)
        end
      end
    end
  end
end
