defmodule Lattice.Treehouse.ContractTest do
  use ExUnit.Case, async: true

  @moduletag :treehouse_contract

  @repo_root Path.expand("../../../..", __DIR__)

  @plan178_path Path.join(@repo_root, "plans/178-treehouse-contract-correction.md")
  @one_pager_path Path.join(@repo_root, "plans/treehouse_one_pager.html")
  @readme_path Path.join(@repo_root, "plans/README.md")
  @plan158_path Path.join(@repo_root, "plans/158-real-device-beta-poc-program-map.md")

  @prohibited_phrases [
    "nothing hosted",
    "serverless",
    "no server to",
    "nothing to seize",
    "use-limited",
    "does not orphan",
    "zero server dependency",
    "guaranteed availability",
    "there is no landlord",
    "uncapturable",
    "ttl'd",
    "no registry to scrape",
    "cannot be deleted, paywalled"
  ]

  # The only code spans in plan 178 that may carry a prohibited phrase: the quoted old
  # one-pager claims in the corrections table. Every other code span is scanned as prose.
  @quoted_old_claims [
    "durable, uncapturable community spaces",
    "because there is no server to do any of those things to",
    "there is no landlord",
    "does not orphan the space",
    "TTL'd, use-limited capabilities",
    "nothing hosted",
    "nothing hosted, nothing to seize",
    "zero server dependency"
  ]

  # The one authoritative listing of the prohibited phrases themselves.
  @prohibited_list_prefix "Prohibited phrases (case-insensitive"

  @commands [
    "create space",
    "create thread",
    "issue invitation",
    "revoke invitation",
    "admit member",
    "remove member",
    "transfer admin",
    "change moderator",
    "revoke grant",
    "witnessed succession",
    "post",
    "author edit",
    "author tombstone",
    "moderator tombstone"
  ]

  @denial_precedence [
    "missing or not-causal target",
    "quarantined target",
    "wrong target kind or thread",
    "wrong author",
    "already tombstoned"
  ]

  @roles ["admin", "moderator", "member"]

  @beta_exclusions [
    "notifications",
    "background delivery",
    "media",
    "reactions, votes and polls",
    "bots and integrations",
    "federation and cross-space identity",
    "E2EE",
    "automated recovery and key rotation",
    "the 60-day multi-community exit gate",
    "invite use limits and bearer invites",
    "founder-loss survival",
    "any availability guarantee",
    "production compaction",
    "receipt-free anything"
  ]

  @required_plan178_sentences [
    "The relay is a plaintext host: its operator, or for a member-operated relay the host " <>
      "device and its OS including any administrator, that device's backups and every " <>
      "transport peer the relay manifest admits, can read the log; the host can withhold " <>
      "availability; and the relay cannot decide semantic authority or erase device-held " <>
      "history.",
    "Founder loss is not survived today: AF-2 fails because beacons are honored only from " <>
      "the replica root, witnessed recovery covers a role and not the root, and key " <>
      "rotation and recovery are M3; manual admin transfer is the only handoff the first " <>
      "beta claims.",
    "An invitation is recipient-bound and has one signed ID and one recipient; replay is " <>
      "idempotent, rebinding is quarantined, and revocation closes it; it is not a bearer " <>
      "link and carries no expiry or use-limit claim.",
    "History is device-held and replayable; thread rollover, archiving a thread and " <>
      "starting a new one under the same Space, is the pilot volume policy against the " <>
      "4,000-op / 8 MiB / 5-second thresholds, and no safe-unbounded-history claim is made.",
    "The first beta allows at most 12 Thread replicas per Space (Plan 158 Decision 8)",
    "an authorized edit cannot launder a quarantined lineage into visibility",
    "the signed command bytes determine the complete ordered array in both runtimes",
    "Status inspection reads only the causal `context.visible_ops` and `context.verdicts`",
    "an existing singular effect normalizes to a one-element array",
    "## Frozen contract",
    "### Command vocabulary",
    "### Conflict rules",
    "### Roles",
    "### Hosting and plaintext",
    "### Beta exclusions"
  ]

  @required_one_pager_sentences [
    "the host can withhold availability; and the relay cannot decide semantic authority " <>
      "or erase device-held history",
    "Founder loss is not survived today: AF-2 fails because beacons are honored only from " <>
      "the replica root",
    "it is not a bearer link and carries no expiry or use-limit claim",
    "the relay is a member-operated or operator-hosted plaintext host: its operator, or " <>
      "for a member-operated relay the host device and its OS including any administrator, " <>
      "that device's backups and every transport peer the relay manifest admits, can read " <>
      "the log, and the host can withhold availability",
    "can read that copy, and the host can withhold availability; it cannot decide who holds " <>
      "a role or erase what members' devices hold",
    "History is device-held and replayable: wipe every device but one and the record and " <>
      "role structure that phone had synced survive on it",
    "Member key loss is the AF-3 design item (social re-admission by group attestation; " <>
      "no path built today); founder/root key loss is AF-2 and fails today",
    "Reactions, votes and polls are absent from the first beta"
  ]

  @readme_row "| 178 | Treehouse Contract Correction: frozen text-only beta contract, " <>
                "one-pager claims corrected to D1/AF-2, copy pinned by test | **P0** | S | " <>
                "158, 177 | DONE (2026-09-03; lands with " <>
                "apps/lattice_core/test/treehouse/contract_test.exs) |"

  @plan158_addition "\nStatus 2026-09-03: corrected and frozen in " <>
                      "`plans/178-treehouse-contract-correction.md`; the\n" <>
                      "one-pager copy and the contract sentences are pinned by\n" <>
                      "`apps/lattice_core/test/treehouse/contract_test.exs`."

  test "plan 178 freezes the Treehouse beta contract" do
    plan = read_plan178() |> normalize_whitespace()

    for sentence <- @required_plan178_sentences do
      assert String.contains?(plan, normalize_whitespace(sentence)),
             "plans/178-treehouse-contract-correction.md is missing required sentence: " <>
               inspect(sentence)
    end
  end

  test "plan 178 freezes the exact ordered command vocabulary" do
    assert list_items(read_plan178(), "### Command vocabulary") == @commands
  end

  test "plan 178 freezes the application denial precedence in order" do
    assert list_items(read_plan178(), "### Conflict rules") == @denial_precedence
  end

  test "plan 178 freezes the exact role set" do
    assert list_items(read_plan178(), "### Roles") == @roles
  end

  test "plan 178 freezes the exact beta exclusion set" do
    assert list_items(read_plan178(), "### Beta exclusions") == @beta_exclusions
  end

  test "plan 178 exempts only the quoted old claims and the prohibited list" do
    plan = read_plan178()
    outside_prohibited_list = drop_prohibited_list_paragraph(plan)

    for claim <- @quoted_old_claims do
      assert String.contains?(outside_prohibited_list, "`" <> claim <> "`"),
             "the prohibited-phrase exemption list names a quoted old claim that is no longer " <>
               "in plans/178-treehouse-contract-correction.md: " <> inspect(claim)
    end

    paragraphs =
      plan
      |> String.split("\n\n")
      |> Enum.filter(&String.starts_with?(&1, @prohibited_list_prefix))

    assert length(paragraphs) == 1,
           "expected exactly one authoritative prohibited-phrase paragraph in " <>
             "plans/178-treehouse-contract-correction.md, found #{length(paragraphs)}"
  end

  test "plan 178 makes no prohibited claim outside the exempted quotations" do
    scanned =
      read_plan178() |> drop_exempt_regions() |> normalize_whitespace() |> String.downcase()

    for phrase <- @prohibited_phrases do
      refute String.contains?(scanned, String.downcase(phrase)),
             "plans/178-treehouse-contract-correction.md contains prohibited phrase " <>
               "outside a quoted old claim: " <> inspect(phrase)
    end
  end

  test "the one-pager makes no prohibited claim in text, comments or attributes" do
    forms = read_one_pager() |> scan_forms()

    for phrase <- @prohibited_phrases, {label, form} <- forms do
      refute String.contains?(form, String.downcase(phrase)),
             "plans/treehouse_one_pager.html contains prohibited phrase " <>
               inspect(phrase) <>
               " in its " <> label
    end
  end

  test "the one-pager carries the corrected hosting, founder-loss and invite copy" do
    text = read_one_pager() |> visible_text(" ")

    for sentence <- @required_one_pager_sentences do
      normalized = sentence |> normalize_whitespace() |> String.downcase()

      assert String.contains?(text, normalized),
             "plans/treehouse_one_pager.html is missing required corrected sentence: " <>
               inspect(sentence)
    end
  end

  test "the plan index carries row 178 unchanged" do
    readme = File.read!(@readme_path)

    assert String.contains?(readme, @readme_row),
           "plans/README.md is missing the expected row 178: " <> inspect(@readme_row)

    row_178_lines =
      readme
      |> String.split("\n")
      |> Enum.filter(&String.starts_with?(&1, "| 178 |"))

    assert length(row_178_lines) == 1,
           "expected exactly one line starting with \"| 178 |\" in plans/README.md, found " <>
             "#{length(row_178_lines)}"
  end

  test "plan 158 records the correction" do
    assert File.exists?(@plan158_path),
           "expected plans/158-real-device-beta-poc-program-map.md to exist"

    actual = @plan158_path |> File.read!() |> normalize_whitespace()
    expected = normalize_whitespace(@plan158_addition)

    assert String.contains?(actual, expected),
           "plans/158-real-device-beta-poc-program-map.md is missing the Plan 178 status " <>
             "paragraph"
  end

  # -- reading ----------------------------------------------------------

  defp read_plan178 do
    assert File.exists?(@plan178_path),
           "expected plans/178-treehouse-contract-correction.md to exist"

    File.read!(@plan178_path)
  end

  defp read_one_pager do
    assert File.exists?(@one_pager_path), "expected plans/treehouse_one_pager.html to exist"

    File.read!(@one_pager_path)
  end

  # -- markdown ---------------------------------------------------------

  # The leading code span of every "- `item`" bullet under a heading, in document order.
  defp list_items(markdown, heading) do
    markdown
    |> String.split("\n")
    |> Enum.drop_while(&(&1 != heading))
    |> Enum.drop(1)
    |> Enum.take_while(&(not String.starts_with?(&1, "#")))
    |> Enum.flat_map(fn line ->
      case Regex.run(~r/^- `([^`]+)`/, line) do
        [_, item] -> [item]
        nil -> []
      end
    end)
  end

  defp drop_exempt_regions(markdown) do
    markdown
    |> drop_prohibited_list_paragraph()
    |> drop_quoted_old_claims()
  end

  defp drop_prohibited_list_paragraph(markdown) do
    markdown
    |> String.split("\n\n")
    |> Enum.reject(&String.starts_with?(&1, @prohibited_list_prefix))
    |> Enum.join("\n\n")
  end

  defp drop_quoted_old_claims(text) do
    Enum.reduce(@quoted_old_claims, text, fn claim, acc ->
      String.replace(acc, "`" <> claim <> "`", " ")
    end)
  end

  # -- html -------------------------------------------------------------

  # Every surface a prohibited claim could hide in: visible text with tags removed both
  # without and with a separator, plus comments and attribute values.
  defp scan_forms(html) do
    comments =
      ~r/<!--(.*?)-->/s
      |> Regex.scan(html, capture: :all_but_first)
      |> List.flatten()
      |> Enum.with_index()
      |> Enum.map(fn {body, i} -> {"comment #{i}", scrub(body)} end)

    attributes =
      html
      |> attribute_values()
      |> Enum.with_index()
      |> Enum.map(fn {value, i} -> {"attribute #{i}", scrub(value)} end)

    [
      {"visible text (tags joined)", visible_text(html, "")},
      {"visible text (tags spaced)", visible_text(html, " ")}
    ] ++ comments ++ attributes
  end

  defp visible_text(html, separator) do
    html
    |> String.replace(~r/<[^>]*>/s, separator)
    |> scrub()
  end

  defp scrub(text) do
    text
    |> decode_entities()
    |> normalize_whitespace()
    |> String.downcase()
  end

  defp attribute_values(html) do
    double = Regex.scan(~r/\s[\w:.-]+\s*=\s*"([^"]*)"/, html, capture: :all_but_first)
    single = Regex.scan(~r/\s[\w:.-]+\s*=\s*'([^']*)'/, html, capture: :all_but_first)
    # An unquoted value: HTML ends it at the first whitespace or `>`, and it can never
    # start with a quote, so this cannot re-match a quoted value.
    unquoted = Regex.scan(~r/\s[\w:.-]+\s*=\s*([^\s"'=<>`]+)/, html, capture: :all_but_first)

    List.flatten(double ++ single ++ unquoted)
  end

  defp decode_entities(text) do
    text
    |> decode_numeric_entities()
    |> String.replace("&lt;", "<")
    |> String.replace("&gt;", ">")
    |> String.replace("&quot;", "\"")
    |> String.replace("&apos;", "'")
    |> String.replace("&nbsp;", " ")
    |> String.replace("&amp;", "&")
  end

  defp decode_numeric_entities(text) do
    hex = Regex.replace(~r/&#[xX]([0-9A-Fa-f]{1,6});/, text, &hex_entity/2)

    Regex.replace(~r/&#(\d{1,7});/, hex, &decimal_entity/2)
  end

  defp hex_entity(_full, digits), do: digits |> String.to_integer(16) |> codepoint()

  defp decimal_entity(_full, digits), do: digits |> String.to_integer() |> codepoint()

  defp codepoint(int) when int in 0..0xD7FF or int in 0xE000..0x10FFFF,
    do: List.to_string([int])

  defp codepoint(_int), do: " "

  defp normalize_whitespace(text) do
    text
    |> String.replace(~r/\s+/, " ")
    |> String.trim()
  end
end
