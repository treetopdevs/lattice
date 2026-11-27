defmodule Township.AuditReport do
  @moduledoc """
  Renders a self-contained, deterministic HTML auditor report from a Township audit bundle.

  The bundle is loaded and verified once through `Township.AuditBundle.load_verified/1`;
  every section is derived from that returned snapshot, never from a second read of the
  mutable directory. A verified report states authenticity and projection consistency,
  not completeness. A failed verification renders only a NOT VERIFIED banner and the
  verbatim error list, with no state, holders or graph.

  Sections, in order: matter state, current holders, authority ledger, role chronology,
  beacons, leases, attestation, election evidence (followed by the embedded research
  security manifest), trust graph and op-DAG summary. The failed page carries none of
  them.

  Non-claims of the newer sections:

    * **Role chronology** lists honored role acquisitions oldest first, as judged by one
      analysis pass. Author-asserted ticks are untrusted (ADR 0004) and are never shown;
      the list does not establish elapsed time or that any holder was inactive.
    * **Beacons** reports the highest accepted beacon epoch across the whole log, not
      per causal branch and not the epoch any one operation observed. A beacon is a
      logical tick accepted under the replica's beacon policy, not a clock; the
      section does not say who signed a beacon.
    * **Leases** shows the live-path `expired?` check next to the delegation status;
      neither is a wall-clock statement.
    * **Election evidence** states that a `township-audit-bundle-v1` bundle carries no
      election board, spec, projection or close evidence. It lists the `link_election`
      commands in the accepted log with their authority verdict only: without a spec the
      report cannot run `Township.Election.verify_link/3`, so a row is not a verified
      election link. No election phase, result, close, receipt-freeness or coercion
      resistance is shown or claimed.

  The page has one inline stylesheet, no script and no URLs. Every interpolated value
  passes through one private `escape/1`, apart from the embedded
  `Township.Election.Report.security_manifest_html/0` fragment. That fragment holds only
  values `Township.Election.Report` owns and is escaped by that module's own D-793
  escaper, which leaves `'` alone; it is safe here only because every attribute on this
  page is double-quoted and no caller data reaches the fragment. Do not feed caller data
  into it.
  """

  alias Lattice.Graph.Export
  alias Lattice.Log
  alias Township.{AuditBundle, ReadModel}
  alias Township.Election.{Report, SecurityProfile}

  @verified_banner "VERIFIED: authenticity and projection consistency, not completeness"
  @attestation_sentence "The legacy attestation stub is not receipt-free and makes no coercion-resistance claim."
  @chronology_caption "Honored role acquisitions in this log, oldest first, as judged by one analysis pass. Author-asserted ticks are untrusted (ADR 0004) and are not shown; this list does not establish elapsed time or that any holder was inactive."
  @beacon_caption "Global to the log, not per causal branch; it is not the epoch any one operation observed. A beacon is a logical tick accepted under the replica's beacon policy, not a clock. Rejected beacons appear in the authority ledger."
  @lease_caption "expired? is the live-path check against beacons accepted anywhere on this log; status is the delegation verdict, so a revoked or invalid chain reports that status even when it has also lapsed."
  @election_intro "This audit bundle (township-audit-bundle-v1) carries no election board, election spec, projection or close evidence. The VERIFIED banner covers matter.log only. No election phase, result or close is shown, and none can be derived from this bundle."
  @link_caption "The report holds no election spec, so it cannot run Township.Election.verify_link/3; a row is the authority verdict on a command in this log, not a verified election link."
  @unknown_key "unknown key"
  @vacant_role "none (vacant)"

  @gloss %{
    not_holder:
      "The author was not a holder of the role in the log view that judged this operation.",
    stale_holder:
      "The author held the role earlier, and the log view that judged this operation records a later holder.",
    lease_expired:
      "The delegation lease was expired at the logical epoch the log view supplies for this operation; the reason does not establish a real-time order between the operation and the epoch.",
    unauthorized_beacon:
      "A logical-tick beacon failed authorization under the replica's policy; the reason does not identify who signed it.",
    stale_beacon:
      "A logical-tick beacon did not advance past the epoch accepted in the log view that judged it.",
    malformed_term: "The operation's authority term was structurally invalid.",
    no_capability:
      "No matching delegation was found in the included log for this command's capability (the command may have carried none, or one the log does not contain).",
    invalid_capability: "The command's capability did not verify.",
    capability_wrong_audience: "The capability was issued to a different identity.",
    capability_not_visible: "The capability's delegation chain was not visible to the author.",
    operation_not_granted: "The capability did not grant this operation.",
    role_not_granted: "The capability did not grant this role.",
    revoked_capability: "The capability was revoked in the log view that judged this operation.",
    malformed_command: "The command body was malformed.",
    unknown_command: "The command is not defined by this replica.",
    bad_command_arity: "The command had the wrong number of arguments."
  }

  @doc """
  Render the report for the bundle at `bundle_dir`.

  Returns `{:ok, html, :verified}` when the bundle verifies, or
  `{:failed, html, errors}` with the verbatim verification errors otherwise. In the
  failed case the html carries only the NOT VERIFIED banner and the escaped errors.
  No `opts` keys are defined yet.
  """
  @spec render(String.t(), keyword()) ::
          {:ok, String.t(), :verified} | {:failed, String.t(), [String.t()]}
  def render(bundle_dir, opts \\ []) when is_binary(bundle_dir) do
    Keyword.validate!(opts, [])
    render_loaded(AuditBundle.load_verified(bundle_dir))
  end

  defp render_loaded({:ok, snapshot}) do
    model = ReadModel.observe(snapshot.log, labels: snapshot.labels)
    body = [header(snapshot), sections(snapshot, model)]
    {:ok, page("Township audit report", body), :verified}
  end

  defp render_loaded({:error, errors}) do
    body = [
      "<h1>Township audit report</h1>\n",
      ~s(<p class="banner bad">NOT VERIFIED</p>\n),
      "<p>The bundle failed verification. No state is shown.</p>\n",
      "<ul>\n",
      Enum.map(errors, fn error -> ["<li><code>", escape(error), "</code></li>\n"] end),
      "</ul>\n"
    ]

    {:failed, page("Township audit report: not verified", body), errors}
  end

  defp header(snapshot) do
    [
      "<h1>Township audit report</h1>\n",
      ~s(<p class="banner ok">),
      escape(@verified_banner),
      "</p>\n",
      "<dl>\n",
      kv("Bundle", snapshot.bundle_dir),
      kv("matter.log SHA-256", snapshot.matter_sha256),
      kv("Schema", snapshot.schema),
      "</dl>\n"
    ]
  end

  defp kv(key, value),
    do: ["<dt>", escape(key), "</dt><dd><code>", escape(value), "</code></dd>\n"]

  defp sections(snapshot, model) do
    structural = structural_rejections(snapshot.log)

    [
      matter_section(model, snapshot.labels),
      holders_section(model.roles.holders, snapshot.labels),
      ledger_section(model, structural),
      chronology_section(model.roles.chronology, snapshot.labels),
      beacons_section(model.roles.beacons),
      leases_section(model.roles.leases, snapshot.labels),
      attestation_section(model.attest),
      election_section(snapshot, model),
      graph_section(model.trust_graph),
      dag_section(snapshot.log, model.roles.quarantine, structural)
    ]
  end

  defp matter_section(model, labels) do
    t = model.threads

    [
      "<h2>Matter state</h2>\n<dl>\n",
      kv("Title", t.title),
      kv("Summary", t.summary),
      kv("Clerk locked", t.clerk_locked?),
      "</dl>\n<h3>Posts</h3>\n",
      list(t.posts),
      "<h3>Members</h3>\n",
      list(Enum.map(model.members.current, &key_label(&1, labels)))
    ]
  end

  defp holders_section(holders, labels) do
    rows =
      holders
      |> Enum.sort_by(fn {role, _fp} -> to_string(role) end)
      |> Enum.map(fn {role, fp} -> [to_string(role), holder_label(fp, labels), fp || ""] end)

    ["<h2>Current holders</h2>\n", table(["Role", "Label", "Fingerprint"], rows)]
  end

  defp ledger_section(model, structural) do
    audit_rows =
      model.roles.audit
      |> Enum.map(fn entry ->
        reason = Map.get(entry, :reason)

        [
          to_string(Map.get(entry, :event)),
          to_string(Map.get(entry, :op)),
          reason_text(reason),
          role_text(Map.get(entry, :role))
        ]
      end)
      |> Enum.sort()

    denied_rows =
      model.members.denied
      |> Enum.map(fn d ->
        [to_string(d.command), to_string(d.op_id), reason_text(d.reason), text(d.member)]
      end)
      |> Enum.sort()

    quarantine_rows =
      model.roles.reasons
      |> Enum.map(fn {id, reason} -> [id, reason_text(reason)] end)
      |> Enum.sort()

    [
      "<h2>Authority ledger</h2>\n",
      table(["Event", "Op", "Reason", "Role"], audit_rows),
      "<h3>Authority-quarantined operations</h3>\n",
      table(["Op", "Reason"], quarantine_rows),
      "<h3>Structurally rejected operations</h3>\n",
      "<p>Rejected on arrival (for example a bad signature); preserved as evidence and never part of the accepted history.</p>\n",
      table(["Op", "Reason"], structural_rows(structural)),
      "<h3>Denied member mutations</h3>\n",
      table(["Command", "Op", "Reason", "Member"], denied_rows)
    ]
  end

  defp attestation_section(attest) do
    [
      "<h2>Attestation</h2>\n<dl>\n",
      kv("Status", text(attest.status)),
      kv("receipt_free?", attest.receipt_free?),
      "</dl>\n<p>",
      escape(@attestation_sentence),
      "</p>\n"
    ]
  end

  defp chronology_section(chronology, labels) do
    roles =
      chronology
      |> Enum.reject(fn {_role, acquisitions} -> acquisitions == [] end)
      |> Enum.sort_by(fn {role, _} -> to_string(role) end)
      |> Enum.map(fn {role, acquisitions} ->
        rows =
          acquisitions
          |> Enum.with_index(1)
          |> Enum.map(fn {a, n} ->
            [n, key_label(a.holder, labels), a.op_id, a.delegation_id]
          end)

        [
          "<h3>",
          escape(to_string(role)),
          "</h3>\n",
          table(["#", "Holder", "Acquisition op", "Delegation"], rows)
        ]
      end)

    [
      "<h2>Role chronology</h2>\n<p>",
      escape(@chronology_caption),
      "</p>\n",
      if(roles == [], do: ["<p><em>none</em></p>\n"], else: roles)
    ]
  end

  defp beacons_section(%{valid: valid, max_epoch: max_epoch}) do
    headline =
      case max_epoch do
        nil -> "No accepted beacons."
        n -> "Highest accepted beacon epoch on this log: #{n}"
      end

    [
      "<h2>Beacons</h2>\n<p>",
      escape(headline),
      "</p>\n",
      if(valid == [],
        do: [],
        else: table(["Op", "Epoch"], Enum.map(valid, fn b -> [b.op_id, b.epoch] end))
      ),
      "<p>",
      escape(@beacon_caption),
      "</p>\n"
    ]
  end

  defp leases_section([], _labels),
    do: ["<h2>Leases</h2>\n<p>", escape("No leased delegations."), "</p>\n"]

  defp leases_section(leases, labels) do
    rows =
      leases
      |> Enum.sort_by(& &1.delegation_id)
      |> Enum.map(fn l ->
        [
          l.delegation_id,
          key_label(l.issuer, labels),
          key_label(l.audience, labels),
          l.expires_epoch,
          l.expired?,
          l.status
        ]
      end)

    headers = [
      "Delegation",
      "Issuer",
      "Audience",
      "Expires after epoch",
      "expired? (live-path)",
      "Status"
    ]

    [
      "<h2>Leases</h2>\n",
      table(headers, rows),
      "<p>",
      escape(@lease_caption),
      "</p>\n"
    ]
  end

  defp election_section(snapshot, model) do
    rows =
      snapshot.log
      |> Log.topo_ops()
      |> Enum.filter(&match?(%{kind: :command, body: {:link_election, _}}, &1))
      |> Enum.sort_by(& &1.id)
      |> Enum.map(fn %{body: {:link_election, args}} = op ->
        [
          op.id,
          key_label(author_fingerprint(op.author), snapshot.labels),
          spec_digest_arg(args),
          link_verdict(Map.get(model.roles.reasons, op.id))
        ]
      end)

    links =
      case rows do
        [] ->
          ["<p>", escape("No link_election command in this matter log."), "</p>\n"]

        rows ->
          [
            table(["Op", "Author", "spec_digest argument", "Authority verdict"], rows),
            "<p>",
            escape(@link_caption),
            "</p>\n"
          ]
      end

    [
      "<h2>Election evidence</h2>\n<p>",
      escape(@election_intro),
      "</p>\n<h3>link_election commands in matter.log</h3>\n",
      links,
      "<dl>\n",
      kv("Research manifest claim_set_id", SecurityProfile.claim_set_id()),
      "</dl>\n",
      Report.security_manifest_html()
    ]
  end

  # A well-formed command carries one binary argument; anything else (including a nil
  # digest or a non-list body) is shown inspected, so it never collapses to an empty cell.
  defp spec_digest_arg([digest]) when is_binary(digest), do: digest
  defp spec_digest_arg([other]), do: inspect_whole(other)
  defp spec_digest_arg(args), do: inspect_whole(args)

  defp inspect_whole(value),
    do: inspect(value, charlists: :as_lists, limit: :infinity, printable_limit: :infinity)

  defp link_verdict(nil), do: "honored in this log"
  defp link_verdict(reason), do: reason_text(reason)

  defp author_fingerprint(pub) when is_binary(pub) and byte_size(pub) == 32,
    do: Lattice.Identity.fingerprint(pub)

  defp author_fingerprint(_pub), do: nil

  defp graph_section(graph) do
    dot = Export.export(graph, :dot) <> "\n"
    mermaid = Export.export(graph, :mermaid) <> "\n"

    [
      "<h2>Trust graph</h2>\n<h3>Nodes</h3>\n",
      map_table(graph.nodes),
      "<h3>Edges</h3>\n",
      map_table(graph.edges),
      omitted(graph.omitted),
      "<details><summary>Graphviz DOT source</summary><pre>",
      escape(dot),
      "</pre></details>\n<details><summary>Mermaid source</summary><pre>",
      escape(mermaid),
      "</pre></details>\n"
    ]
  end

  defp omitted([]), do: []

  defp omitted(ids) do
    ["<h3>Omitted ill-formed delegations</h3>\n", list(Enum.sort(ids))]
  end

  defp structural_rejections(log) do
    case Log.verified_quarantine(log) do
      {:ok, findings} -> findings
      {:error, _} -> []
    end
  end

  defp structural_rows(findings),
    do: Enum.map(findings, fn f -> [f.op_id, to_string(f.reason)] end)

  defp dag_section(log, quarantine, structural) do
    [
      "<h2>Op-DAG summary</h2>\n<dl>\n",
      kv("Total ops", log |> Log.op_ids() |> Enum.count()),
      kv("Authority-quarantined", length(quarantine)),
      kv("Structurally rejected", length(structural)),
      "</dl>\n<h3>Frontier</h3>\n",
      list(log |> Log.frontier() |> Enum.sort())
    ]
  end

  defp reason_text(nil), do: ""

  defp reason_text(reason) do
    case Map.fetch(@gloss, reason) do
      {:ok, text} -> "#{reason}: #{text}"
      :error -> to_string(reason)
    end
  end

  defp role_text(nil), do: ""
  defp role_text(role), do: to_string(role)

  # A role with no current holder is vacant, not an unfingerprintable key.
  defp holder_label(nil, _labels), do: @vacant_role
  defp holder_label(fp, labels), do: key_label(fp, labels)

  defp key_label(nil, _labels), do: @unknown_key
  defp key_label(fp, labels), do: label(fp, labels)

  defp label(fp, labels) do
    case Map.fetch(labels, fp) do
      {:ok, name} -> "#{text(name)} #{text(fp)}"
      :error -> text(fp)
    end
  end

  defp list([]), do: ["<p><em>none</em></p>\n"]

  defp list(items) do
    ["<ul>\n", Enum.map(items, fn i -> ["<li>", escape(i), "</li>\n"] end), "</ul>\n"]
  end

  defp map_table([]), do: ["<p><em>none</em></p>\n"]

  defp map_table(maps) do
    keys = maps |> Enum.flat_map(&Map.keys/1) |> Enum.uniq() |> Enum.sort()

    rows =
      maps
      |> Enum.map(fn m -> Enum.map(keys, fn k -> cell(Map.get(m, k)) end) end)
      |> Enum.sort()

    table(Enum.map(keys, &to_string/1), rows)
  end

  defp cell(value), do: text(value)

  defp table(_headers, []), do: ["<p><em>none</em></p>\n"]

  defp table(headers, rows) do
    [
      ~s(<div class="scroll"><table>\n<thead><tr>),
      Enum.map(headers, fn h -> ["<th>", escape(h), "</th>"] end),
      "</tr></thead>\n<tbody>\n",
      Enum.map(rows, fn row ->
        ["<tr>", Enum.map(row, fn c -> ["<td>", escape(c), "</td>"] end), "</tr>\n"]
      end),
      "</tbody>\n</table></div>\n"
    ]
  end

  defp page(title, body) do
    IO.iodata_to_binary([
      "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n",
      ~s(<meta name="viewport" content="width=device-width, initial-scale=1">\n),
      "<title>",
      escape(title),
      "</title>\n<style>\n",
      css(),
      "</style>\n</head>\n<body>\n<main>\n",
      body,
      "</main>\n</body>\n</html>\n"
    ])
  end

  defp css do
    """
    :root{--bg:#fff;--fg:#1b1f23;--muted:#586069;--line:#d0d7de;--ok:#1a7f37;--okbg:#dafbe1;--bad:#cf222e;--badbg:#ffebe9;--code:#f6f8fa}
    @media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--ok:#3fb950;--okbg:#12261e;--bad:#ff7b72;--badbg:#2d1214;--code:#161b22}}
    body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;margin:0}
    main{max-width:60rem;margin:0 auto;padding:1rem}
    h1,h2,h3{line-height:1.2}
    code,pre{background:var(--code);font:14px ui-monospace,monospace;overflow-wrap:anywhere}
    pre{padding:.75rem;overflow-x:auto;white-space:pre-wrap}
    .banner{font-weight:700;padding:.75rem 1rem;border-radius:6px;border:1px solid}
    .banner.ok{color:var(--ok);background:var(--okbg);border-color:var(--ok)}
    .banner.bad{color:var(--bad);background:var(--badbg);border-color:var(--bad)}
    .scroll{overflow-x:auto}
    .honesty{border:1px solid var(--line);padding:.75rem 1rem;font-weight:600}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid var(--line);padding:.25rem .5rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}
    dt{color:var(--muted);margin-top:.5rem}
    dd{margin:0}
    """
  end

  defp text(value) when is_binary(value),
    do:
      if(String.printable?(value),
        do: value,
        else: inspect(value, limit: :infinity, printable_limit: :infinity)
      )

  defp text(value) when is_atom(value) or is_number(value), do: to_string(value)

  defp text(value),
    do: inspect(value, charlists: :as_lists, limit: :infinity, printable_limit: :infinity)

  defp escape(value) do
    value
    |> text()
    |> String.replace("&", "&amp;")
    |> String.replace("<", "&lt;")
    |> String.replace(">", "&gt;")
    |> String.replace("\"", "&quot;")
    |> String.replace("'", "&#39;")
  end
end
