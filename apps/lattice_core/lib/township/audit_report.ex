defmodule Township.AuditReport do
  @moduledoc """
  Renders a self-contained, deterministic HTML auditor report from a Township audit bundle.

  The bundle is loaded and verified once through `Township.AuditBundle.load_verified/1`;
  every section is derived from that returned snapshot, never from a second read of the
  mutable directory. A verified report states authenticity and projection consistency,
  not completeness. A failed verification renders only a NOT VERIFIED banner and the
  verbatim error list, with no state, holders or graph.

  The page has one inline stylesheet, no script and no URLs. Every interpolated value
  passes through one private `escape/1`.
  """

  alias Lattice.Graph.Export
  alias Lattice.Log
  alias Township.{AuditBundle, ReadModel}

  @verified_banner "VERIFIED: authenticity and projection consistency, not completeness"
  @attestation_sentence "The legacy attestation stub is not receipt-free and makes no coercion-resistance claim."

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
      attestation_section(model.attest),
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
      list(Enum.map(model.members.current, &label(&1, labels)))
    ]
  end

  defp holders_section(holders, labels) do
    rows =
      holders
      |> Enum.sort_by(fn {role, _fp} -> to_string(role) end)
      |> Enum.map(fn {role, fp} -> [to_string(role), label(fp, labels), fp] end)

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
