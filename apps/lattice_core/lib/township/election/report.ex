defmodule Township.Election.Report do
  @moduledoc """
  Pure, self-contained HTML evidence report for the research election foundation.

  The report renders a verified `Township.Election.Projection`, optional
  `Township.Election.CloseEvidence`, and the module-owned
  `Township.Election.SecurityProfile.research/0` manifest. It is a downstream
  formatter only: it re-verifies nothing, and it never upgrades or translates a
  value. Claim statuses render verbatim from the manifest, every exclusion renders
  in full, and the fixed `honesty_sentence/0` heads the document.

  Output rules:

    * one inline `<style>`, no scripts, no URLs, neutral colours only, and no
      class or colour keyed on a claim status;
    * every interpolated value is HTML-escaped, including `inspect/2` output,
      which is never truncated;
    * attributes are always double-quoted, so the escaper replaces `&`, `<`, `>`
      and `"` and deliberately leaves `'` alone (the honesty sentence therefore
      appears verbatim); do not introduce a single-quoted attribute;
    * equal inputs give byte-identical output: map keys are sorted explicitly.
  """

  alias Township.Election.{CloseEvidence, Projection, SecurityProfile}

  @honesty_sentence "This election foundation makes no security claim. Every scope below is explicitly not claimed; the profile's construction is unselected."
  @close_caveat "This value is not global election finality and never advances the public foundation projection beyond `:setup`."
  @inspect_opts [limit: :infinity, printable_limit: :infinity]

  @style """
  body{margin:0;padding:24px 16px;background:#fafafa;color:#1f1f1f;font:15px/1.5 system-ui,sans-serif}
  main{max-width:1100px;margin:0 auto}
  h1{font-size:1.5rem;margin:0 0 12px}
  h2{font-size:1.15rem;margin:28px 0 8px;border-bottom:1px solid #d4d4d4;padding-bottom:4px}
  h3{font-size:1rem;margin:16px 0 6px}
  .honesty{border:1px solid #8a8a8a;background:#efefef;padding:10px 12px;font-weight:600}
  .caveat{border-left:4px solid #8a8a8a;background:#efefef;padding:8px 12px}
  .scroll{overflow-x:auto}
  table{border-collapse:collapse;margin:6px 0 12px;width:100%}
  th,td{border:1px solid #d4d4d4;padding:4px 8px;text-align:left;vertical-align:top}
  th{background:#f0f0f0;font-weight:600}
  code,.mono{font-family:ui-monospace,monospace;font-size:.9em;word-break:break-all}
  ul,ol{margin:4px 0 8px;padding-left:22px}
  """

  @doc "Fixed sentence rendered at the top of every report."
  @spec honesty_sentence() :: String.t()
  def honesty_sentence, do: @honesty_sentence

  @doc "Caveat copied from `Township.Election.CloseEvidence`, rendered with any close evidence."
  @spec close_caveat() :: String.t()
  def close_caveat, do: @close_caveat

  @doc """
  Render one projection, and optionally verified close evidence, as an HTML document.

  The only option is `close_evidence: CloseEvidence.t() | nil` (default `nil`).
  Unknown options raise `ArgumentError`.
  """
  @spec render(Projection.t(), keyword()) :: String.t()
  def render(%Projection{} = projection, opts \\ []) do
    opts = Keyword.validate!(opts, close_evidence: nil)
    close_evidence = close_evidence_option(opts[:close_evidence])
    profile = SecurityProfile.research()
    module_claim_set_id = SecurityProfile.claim_set_id()
    matches? = projection.claim_set_id == module_claim_set_id

    IO.iodata_to_binary([
      "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n",
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n",
      "<title>Township election evidence report</title>\n<style>\n",
      @style,
      "</style>\n</head>\n<body>\n<main>\n",
      header(projection, module_claim_set_id, matches?),
      projection_section(projection),
      close_section(close_evidence),
      manifest_section(profile, matches?),
      "</main>\n</body>\n</html>\n"
    ])
  end

  defp close_evidence_option(nil), do: nil
  defp close_evidence_option(%CloseEvidence{} = evidence), do: evidence

  defp close_evidence_option(other) do
    raise ArgumentError,
          "close_evidence must be a Township.Election.CloseEvidence or nil, got: " <>
            inspect(other, @inspect_opts)
  end

  # -- sections ---------------------------------------------------------------

  defp header(projection, module_claim_set_id, matches?) do
    [
      "<h1>Township election evidence report</h1>\n",
      "<p class=\"honesty\">",
      escape(@honesty_sentence),
      "</p>\n",
      kv_table([
        {"election_id", code(projection.election_id || "none")},
        {"phase", code(text(projection.phase))},
        {"projection claim_set_id", code(projection.claim_set_id)},
        {"research manifest claim_set_id", code(module_claim_set_id)},
        {"claim set id matches research manifest", escape(if(matches?, do: "yes", else: "no"))}
      ])
    ]
  end

  defp projection_section(%Projection{} = projection) do
    {tag, payload} = status_parts(projection.status)

    [
      "<h2 id=\"projection\">Projection</h2>\n",
      kv_table([{"status", code(tag)}]),
      payload,
      "<h3>rejected</h3>\n",
      entry_tables(projection.rejected),
      "<h3>faults</h3>\n",
      entry_tables(projection.faults)
    ]
  end

  defp status_parts({:pending, requirements}) when is_list(requirements),
    do: {"pending", ["<h3>requirements</h3>\n", inspect_list(requirements)]}

  defp status_parts({:invalid, entries}) when is_list(entries),
    do: {"invalid", ["<h3>findings</h3>\n", entry_tables(entries)]}

  defp status_parts({:forked, entries}) when is_list(entries),
    do: {"forked", ["<h3>findings</h3>\n", entry_tables(entries)]}

  defp status_parts({:aborted, reason}),
    do: {"aborted", ["<h3>reason</h3>\n", pre(reason)]}

  defp status_parts({:final, result}),
    do: {"final", ["<h3>result</h3>\n", pre(result)]}

  defp status_parts(other), do: {"unrecognised", ["<h3>raw status</h3>\n", pre(other)]}

  defp close_section(nil), do: []

  defp close_section(%CloseEvidence{} = evidence) do
    [
      "<h2 id=\"close-evidence\">Close evidence</h2>\n",
      "<p class=\"caveat\">",
      with_code_spans(@close_caveat),
      "</p>\n",
      kv_table([
        {"election_id", code(evidence.election_id)},
        {"open_certificate_id (operator-asserted)", code(evidence.open_certificate_id)},
        {"manifest_digest", code(evidence.manifest_digest)},
        {"prerequisite", code(text(evidence.prerequisite))}
      ]),
      id_list("ballot_wrapper_ids", evidence.ballot_wrapper_ids),
      id_list("ballot_digests", evidence.ballot_digests),
      id_list("seal_digests", evidence.seal_digests),
      id_list("certificate_op_ids", evidence.certificate_op_ids),
      "<h3>rejected</h3>\n",
      entry_tables(evidence.rejected)
    ]
  end

  defp manifest_section(%SecurityProfile{} = profile, matches?) do
    heading =
      if matches?,
        do: "Security manifest",
        else: "Security manifest: module research manifest (not the one this projection names)"

    [
      "<h2 id=\"security-manifest\">",
      escape(heading),
      "</h2>\n",
      kv_table([
        {"profile_id", code(profile.profile_id)},
        {"implementation_status", code(text(profile.implementation_status))},
        {"construction status", code(text(profile.construction.status))},
        {"construction paper", code(text(profile.construction.paper))},
        {"construction version", code(text(profile.construction.version))},
        {"construction parameters_digest", code(text(profile.construction.parameters_digest))},
        {"theorem_reference", code(text(profile.theorem_reference))}
      ]),
      "<h3>ideal_leakage</h3>\n",
      string_list(Enum.map(profile.ideal_leakage, &text/1)),
      "<h3>claims (",
      escape(Integer.to_string(map_size(profile.claims))),
      " scopes)</h3>\n",
      claims_table(profile.claims)
    ]
  end

  defp claims_table(claims) do
    rows =
      claims
      |> Enum.sort_by(&elem(&1, 0))
      |> Enum.map(fn {name, claim} ->
        [
          "<tr><td>",
          code(text(name)),
          "</td><td>",
          escape(claim.scope),
          "</td><td class=\"claim-status\">",
          escape(Atom.to_string(claim.status)),
          "</td><td>",
          string_list(claim.assumptions),
          "</td><td>",
          string_list(claim.exclusions),
          "</td><td>",
          string_list(claim.evidence),
          "</td></tr>\n"
        ]
      end)

    [
      "<div class=\"scroll\"><table>\n<thead><tr><th>scope</th><th>description</th>",
      "<th>status</th><th>assumptions</th><th>exclusions</th><th>evidence</th></tr></thead>\n",
      "<tbody>\n",
      rows,
      "</tbody></table></div>\n"
    ]
  end

  # -- building blocks ----------------------------------------------------------

  defp kv_table(rows) do
    body =
      Enum.map(rows, fn {label, value_html} ->
        ["<tr><th>", escape(label), "</th><td>", value_html, "</td></tr>\n"]
      end)

    ["<div class=\"scroll\"><table>\n", body, "</table></div>\n"]
  end

  defp entry_tables([]), do: "<p>none</p>\n"

  defp entry_tables(entries) when is_list(entries), do: Enum.map(entries, &entry_table/1)

  defp entry_tables(other), do: pre(other)

  defp entry_table(entry) when is_map(entry) do
    rows =
      entry
      |> Enum.map(fn {key, value} -> {text(key), value} end)
      |> Enum.sort_by(&elem(&1, 0))
      |> Enum.map(fn {key, value} -> {key, code(entry_value(value))} end)

    kv_table(rows)
  end

  defp entry_table(other), do: pre(other)

  defp id_list(label, ids) when is_list(ids) do
    [
      "<h3>",
      escape(label),
      " (",
      escape(Integer.to_string(length(ids))),
      ")</h3>\n",
      string_list(Enum.map(ids, &text/1), "ol")
    ]
  end

  defp id_list(label, other), do: ["<h3>", escape(label), "</h3>\n", pre(other)]

  defp inspect_list(values), do: string_list(Enum.map(values, &inspect(&1, @inspect_opts)))

  defp string_list(values, tag \\ "ul")
  defp string_list([], _tag), do: "none"

  defp string_list(values, tag) when is_list(values) do
    items = Enum.map(values, fn value -> ["<li>", code(text(value)), "</li>"] end)
    ["<", tag, ">", items, "</", tag, ">\n"]
  end

  defp string_list(other, _tag), do: pre(other)

  defp pre(term), do: ["<pre class=\"mono\">", escape(inspect(term, @inspect_opts)), "</pre>\n"]

  defp code(value), do: ["<code>", escape(value), "</code>"]

  # Atoms render bare (`artifact_size_mismatch`), nil renders "none", binaries
  # render as-is, and anything else renders through untruncated `inspect/2`.
  defp text(nil), do: "none"
  defp text(value) when is_binary(value), do: value
  defp text(value) when is_atom(value), do: Atom.to_string(value)
  defp text(value), do: inspect(value, @inspect_opts)

  # Inside evidence maps a nil value stays literally `nil`, never "none".
  defp entry_value(nil), do: "nil"
  defp entry_value(value), do: text(value)

  # Backtick-delimited spans become `<code>`; every piece is escaped first.
  defp with_code_spans(sentence) do
    sentence
    |> String.split("`")
    |> Enum.with_index()
    |> Enum.map(fn
      {piece, index} when rem(index, 2) == 1 -> code(piece)
      {piece, _index} -> escape(piece)
    end)
  end

  defp escape(value) when is_binary(value) do
    value
    |> String.replace("&", "&amp;")
    |> String.replace("<", "&lt;")
    |> String.replace(">", "&gt;")
    |> String.replace("\"", "&quot;")
  end
end
