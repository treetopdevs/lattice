defmodule Lattice.Treehouse.R13LiteContractTest do
  @moduledoc """
  Pins the R13-lite claim language (Plan 181, Slice 6).

  The permitted completion sentence is pinned whole, so its qualifications (test variant, not
  Keychain custody, fixture relay, pre-seeded admission, directory-sync approximation) cannot be
  quoted away. The scans cover the surfaces that carry claim language: the plan's Completion claim
  section, every ledger line that mentions R13-lite, the evidence record, the README row, the
  CLAUDE.md note and the enrollment-build shell copy.
  """
  use ExUnit.Case, async: true

  @moduletag :treehouse_contract

  @repo_root Path.expand("../../../..", __DIR__)

  @plan_path Path.join(@repo_root, "plans/181-r13-lite-treehouse-enrollment-sync.md")
  @readme_path Path.join(@repo_root, "plans/README.md")
  @roadmap_path Path.join(@repo_root, "plans/roadmaps/treehouse-unified-2026-09-06.md")
  @plan158_path Path.join(@repo_root, "plans/158-real-device-beta-poc-program-map.md")
  @evidence_path Path.join(
                   @repo_root,
                   "docs/research/evidence/treehouse-roadmap-integration-20260907.md"
                 )
  @claude_path Path.join(@repo_root, "CLAUDE.md")
  @shell_src Path.join(@repo_root, "clients/treehouse-tauri-shell/src")

  @carve_out_heading "## R13-lite carve-out (2026-10-07)"

  @permitted_sentence "Two instances of one dev-trace test-variant macOS Treehouse bundle, each " <>
                        "with a directory-isolated store and a seeded in-memory test key (not " <>
                        "Keychain custody), complete invite, join, post, converge, restart, " <>
                        "converge against one CI-launched pilot_node.exs fixture relay " <>
                        "(loopback, macOS directory-sync approximation) whose Space and Thread " <>
                        "routes were configured by hand in a manifest; only semantic " <>
                        "membership and Thread grants are enrolled in the log, and transport " <>
                        "admission of both instances was pre-seeded in that manifest; the " <>
                        "final op ids, frame bytes, state and verdicts equal Lattice.Sim. The " <>
                        "relay operator and anyone with its host, backups or admitted " <>
                        "transport peers can read the plaintext log, and the host can " <>
                        "withhold availability; the relay cannot decide semantic authority or " <>
                        "erase device-held history. The routes are not catalog-signed, " <>
                        "provisioned, staged, sealed, admitted-service-bound or replaceable. " <>
                        "Desktop macOS CI only."

  # The quoted negation inside the permitted sentence; the one place "provisioned" may appear.
  @quoted_negation "The routes are not catalog-signed, provisioned, staged, sealed, " <>
                     "admitted-service-bound or replaceable."

  @gax_fallback_sentence "artifact transfer and button actions between the instances were " <>
                           "driven through a dev-trace loopback mailbox, not accessibility or " <>
                           "paste input"

  @required_non_claims [
    "no catalog replacement and no R11b or R11c",
    "no relay replacement or reseed",
    "routes are not staged, sealed or admitted-service-bound",
    "joiner transport admission was pre-seeded in the hand-written manifest, with no " <>
      "enrollment-driven or dynamic transport admission",
    "no durable-ack claim on macOS, durability evidence is the Linux gate only",
    "the harness stop and kill paths are test-only and claim no controlled-stop semantics",
    "no Keychain custody",
    "enrollment UI exists only in the test-variant build",
    "R13, R14, R15 and R16 remain open",
    "no QR, camera or deep link",
    "no physical device, no Android, no iOS",
    "no protected witness or custody (R36, R17)",
    "no founder-loss survival (AF-2 stays qualified, Plan 178 pinned sentence)",
    "no production or WSS deployment, no pilot, no Phase G or G1 completion, no " <>
      "receipt-free W4, no availability guarantee, no background delivery, no E2EE"
  ]

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
    "cannot be deleted, paywalled",
    "decentralized",
    "centerless",
    "host mode",
    "self-hosted by members"
  ]

  @prohibited_wording [
    "two devices",
    "two packaged apps",
    "separately packaged",
    "native-custody identity",
    "operator-run relay",
    "provisioned"
  ]

  @operator_direction "R13-lite first (recommended). Build enrollment and sync for the " <>
                        "Treehouse shell against one hand-configured relay route, the way the " <>
                        "Township shell already does it, and defer catalog replacement to R11c."

  @status_vocabulary ["PLANNED", "IN PROGRESS", "LOCAL VERIFIED", "DONE"]

  test "the plan's Completion claim carries the permitted sentence verbatim" do
    section = plan() |> section("## Completion claim") |> normalize()

    assert String.contains?(section, normalize(@permitted_sentence)),
           "plans/181 Completion claim lost the permitted sentence (or a qualification in it)"

    assert String.contains?(section, normalize(@gax_fallback_sentence)),
           "plans/181 Completion claim lost the G-AX fallback sentence"
  end

  test "the evidence record carries the permitted sentence whole" do
    assert String.contains?(normalize(carve_out()), normalize(@permitted_sentence))
  end

  test "the ledger claims row carries the permitted sentence whole" do
    assert String.contains?(normalize(claims_row()), normalize(@permitted_sentence))
  end

  test "every required non-claim is stated verbatim in the plan and the evidence record" do
    plan_claim = plan() |> section("## Completion claim") |> normalize()
    carve_out = carve_out() |> normalize()

    for non_claim <- @required_non_claims do
      needle = normalize(non_claim)

      assert String.contains?(plan_claim, needle),
             "plans/181 Completion claim is missing non-claim: " <> inspect(non_claim)

      assert String.contains?(carve_out, needle),
             "the evidence record is missing non-claim: " <> inspect(non_claim)
    end
  end

  test "the evidence record quotes the operator direction verbatim" do
    assert String.contains?(normalize(carve_out()), normalize(@operator_direction))
    assert String.contains?(normalize(plan158_note()), normalize(@operator_direction))
  end

  test "no claim surface uses a prohibited phrase" do
    for {label, text} <- claim_surfaces(), phrase <- @prohibited_phrases do
      refute String.contains?(scrub(text), phrase),
             "#{label} contains prohibited phrase: " <> inspect(phrase)
    end
  end

  test "no claim surface uses prohibited wording outside the quoted negation" do
    negation = scrub(@quoted_negation)

    for {label, text} <- claim_surfaces(), wording <- @prohibited_wording do
      stripped = text |> scrub() |> String.replace(negation, " ")

      refute String.contains?(stripped, wording),
             "#{label} contains prohibited wording: " <> inspect(wording)
    end
  end

  test "the claim surfaces say two instances and operator hand-configured route" do
    for {label, text} <- [
          {"completion claim", plan() |> section("## Completion claim")},
          {"evidence carve-out", carve_out()}
        ] do
      assert String.contains?(scrub(text), "two instances"), "#{label} must say two instances"
    end

    assert String.contains?(scrub(carve_out()), "operator hand-configured route"),
           "the carve-out must call the route an operator hand-configured route"
  end

  test "the plan and the new surfaces contain no em dash" do
    for {label, text} <- [
          {"plans/181", plan()},
          {"carve-out", carve_out()},
          {"README row 181", readme_row()},
          {"R13-lite ledger lines", Enum.join(ledger_lines(), "\n")},
          {"plan 158 note", plan158_note()},
          {"CLAUDE.md note", claude_note()}
        ] do
      refute String.contains?(text, "—"), "#{label} contains an em dash"
    end
  end

  test "the ledger adds a R13-lite sub-row beside R13 and leaves R13 open and unchanged" do
    lines = File.read!(@roadmap_path) |> String.split("\n")
    r13_index = Enum.find_index(lines, &String.starts_with?(&1, "| R13 |"))

    assert r13_index, "the R13 row is missing"

    r13 = Enum.at(lines, r13_index)
    sub = Enum.at(lines, r13_index + 1)

    assert String.starts_with?(sub, "| R13-lite |"),
           "the R13-lite sub-row must sit directly after the R13 row"

    assert r13 =~ "| R01b, R08, R11c, R12 |", "the R13 Requires column changed"
    assert String.ends_with?(r13, "| PLANNED |"), "R13 must stay PLANNED"
    assert r13 =~ "R13-lite evidence does not close this row"

    cells = sub |> String.split("|", trim: true) |> Enum.map(&String.trim/1)
    [id, _packet, size, risk, requires, exit_evidence, status] = cells

    assert id == "R13-lite"
    assert size == "L" and risk == "High"
    assert requires == "R01b, R08, R10, R12 (not R11)"

    assert exit_evidence =~
             "Packaged two-instance invite, join, post, converge, restart, converge"

    assert status in @status_vocabulary
  end

  test "later rows keep requiring full R13 or R11c" do
    rows = File.read!(@roadmap_path) |> String.split("\n")

    assert Enum.any?(rows, &(String.starts_with?(&1, "| R14 |") and &1 =~ "| R13, R04, R36 |"))
    assert Enum.any?(rows, &(String.starts_with?(&1, "| R27 |") and &1 =~ "| R13, R25, R26 |"))
    assert Enum.any?(rows, &(String.starts_with?(&1, "| R16 |") and &1 =~ "| R06, R11c, R15 |"))

    assert Enum.any?(
             rows,
             &(String.starts_with?(&1, "| R21a |") and &1 =~ "| R05, R06, R08, R09, R11c |")
           )

    assert Enum.any?(rows, &(String.starts_with?(&1, "| R15 |") and &1 =~ "| R14 |"))
  end

  test "R13-lite cannot read LOCAL VERIFIED or DONE without hosted evidence" do
    status = r13_lite_status()
    evidence = execution_row()

    assert status in @status_vocabulary

    if status in ["LOCAL VERIFIED", "DONE"] do
      # Round 6 rule 2: the exact-tip run is the gate; the merge SHA lets a reader check the tree match.
      assert length(Regex.scan(~r/\b[0-9a-f]{40}\b/, evidence)) >= 2,
             "a closed R13-lite row needs the exact tip and the merge SHA"

      assert Regex.match?(~r/\bexact-tip run \d{8,}\b/i, evidence),
             "a closed R13-lite row needs the exact-tip run"
    end

    # An open row must still name its remaining gate; a closed row is free to drop that wording.
    unless status in ["LOCAL VERIFIED", "DONE"] do
      assert String.contains?(evidence, "Remaining gate"),
             "an open R13-lite row must name its remaining gate"
    end
  end

  test "the roadmap carries the plan 181 allocation note and the execution row" do
    roadmap = File.read!(@roadmap_path) |> normalize()

    assert roadmap =~
             "plan number 181 is now allocated to `plans/181-r13-lite-treehouse-enrollment-sync.md`"

    assert String.contains?(execution_row(), "R13-lite")
    assert String.contains?(execution_row(), "Packaged macOS")
  end

  test "the plan index appends exactly one row 181 and leaves row 178 alone" do
    readme = File.read!(@readme_path)
    lines = String.split(readme, "\n")

    assert length(Enum.filter(lines, &String.starts_with?(&1, "| 181 |"))) == 1
    assert length(Enum.filter(lines, &String.starts_with?(&1, "| 178 |"))) == 1

    row = readme_row()
    assert row =~ "R13-lite"
    assert row =~ "plans/181-r13-lite-treehouse-enrollment-sync.md"

    cells = row |> String.split("|", trim: true) |> Enum.map(&String.trim/1)
    assert length(cells) == 6, "README row 181 must have the table's six columns"

    # Appended after the last numbered plan row, before the status legend.
    index_181 = Enum.find_index(lines, &String.starts_with?(&1, "| 181 |"))
    index_180 = Enum.find_index(lines, &String.starts_with?(&1, "| 180 |"))
    assert index_181 == index_180 + 1
  end

  test "plan 158 carries a scoped R13-lite note under the R01a amendment only" do
    note = plan158_note() |> normalize()

    assert note =~ "R13-lite"
    assert note =~ "waives the whole R11 (a, b and c) edge"
    assert note =~ "one hand-configured, unreplaceable route set only"

    plan158 = File.read!(@plan158_path) |> normalize()

    assert plan158 =~ "R13 cannot enable multi-app enrollment until R11 completes",
           "item 3 of the R01a amendment must stay as written"
  end

  test "CLAUDE.md carries a narrow non-claim note for plan 181" do
    note = claude_note() |> normalize()

    assert note =~ "Plan 181"
    assert note =~ "test variant"
    assert note =~ "does not complete R13"
    assert note =~ "no catalog"
  end

  test "the plan Status section and the ledger sub-row carry the same status word" do
    status_section = plan() |> section("## Status") |> normalize()
    plan_status = Enum.find(@status_vocabulary, &String.starts_with?(status_section, &1))

    assert plan_status, "the plan Status section must start with a status word"
    assert plan_status == r13_lite_status()
  end

  # -- surfaces ----------------------------------------------------------

  defp claim_surfaces do
    [
      {"plans/181 Completion claim", plan() |> section("## Completion claim")},
      {"R13-lite ledger lines", Enum.join(ledger_lines(), "\n")},
      {"evidence carve-out", carve_out()},
      {"README row 181", readme_row()},
      {"CLAUDE.md note", claude_note()},
      {"plan 158 note", plan158_note()}
    ] ++ shell_copy()
  end

  defp shell_copy do
    for file <- ["App.vue", "EnrollmentPanel.vue", "treehouse_panel_sync.ts"] do
      {"shell copy " <> file, File.read!(Path.join(@shell_src, file))}
    end
  end

  defp plan, do: File.read!(@plan_path)

  defp ledger_lines do
    lines =
      @roadmap_path
      |> File.read!()
      |> String.split("\n")
      |> Enum.filter(&String.contains?(&1, "R13-lite"))

    assert lines != [], "the roadmap ledger has no R13-lite lines"
    lines
  end

  defp r13_lite_status do
    sub = Enum.find(ledger_lines(), &String.starts_with?(&1, "| R13-lite |"))
    assert sub, "the R13-lite sub-row is missing"
    sub |> String.split("|", trim: true) |> List.last() |> String.trim()
  end

  defp execution_row do
    row =
      Enum.find(ledger_lines(), fn line ->
        String.starts_with?(line, "| R13-lite | Local implementation tip")
      end)

    assert row, "the R13-lite execution evidence row is missing"
    row
  end

  defp claims_row do
    row =
      Enum.find(ledger_lines(), fn line ->
        String.starts_with?(line, "| R13-lite |") and
          String.contains?(line, "Two instances of one dev-trace")
      end)

    assert row, "the R13-lite claims row is missing"
    row
  end

  defp carve_out do
    @evidence_path |> File.read!() |> section(@carve_out_heading)
  end

  defp readme_row do
    row =
      @readme_path
      |> File.read!()
      |> String.split("\n")
      |> Enum.find(&String.starts_with?(&1, "| 181 |"))

    assert row, "plans/README.md has no row 181"
    row
  end

  defp plan158_note do
    text = File.read!(@plan158_path)
    heading = "### Execution amendment 2026-09-06 (unified Treehouse R01a)"
    section = section(text, heading)

    note =
      section
      |> String.split("\n\n")
      |> Enum.filter(&String.contains?(&1, "R13-lite"))

    assert note != [], "plan 158 has no R13-lite note under the R01a amendment"
    Enum.join(note, "\n\n")
  end

  defp claude_note do
    note =
      @claude_path
      |> File.read!()
      |> String.split("\n\n")
      |> Enum.filter(&String.contains?(&1, "Plan 181"))

    assert note != [], "CLAUDE.md has no Plan 181 note"
    Enum.join(note, "\n\n")
  end

  # -- text --------------------------------------------------------------

  # From a heading line to the next heading of the same or a shallower level.
  defp section(markdown, heading) do
    level = heading |> String.split(" ", parts: 2) |> hd() |> String.length()
    lines = String.split(markdown, "\n")

    assert Enum.any?(lines, &(&1 == heading)), "missing heading: " <> heading

    lines
    |> Enum.drop_while(&(&1 != heading))
    |> Enum.drop(1)
    |> Enum.take_while(fn line ->
      case Regex.run(~r/^(#+) /, line) do
        [_, hashes] -> String.length(hashes) > level
        nil -> true
      end
    end)
    |> Enum.join("\n")
  end

  defp normalize(text), do: text |> String.replace(~r/\s+/, " ") |> String.trim()

  defp scrub(text), do: text |> normalize() |> String.downcase()
end
