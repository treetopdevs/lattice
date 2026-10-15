defmodule Lattice.FaultScenario.Report do
  @moduledoc """
  Renders fault-scenario evidence as one self-contained, read-only HTML page
  (plan 203, step 4).

  Every card is driven by `Lattice.FaultScenario.Evidence.verify/2` run at report
  time. A check is **replayed** when `verify` re-derived it from the logs,
  **recorded** when it is a process-level check `verify` can only copy from the
  evidence (the test run's own claim), and **failed** when it did not hold. A card
  reads "verified" only when every check is replayed and its replay succeeded.
  Every value taken from an evidence file is HTML-escaped.
  """

  alias Lattice.FaultScenario.Evidence

  @type entry :: %{
          dir: Path.t(),
          result: {:ok, Evidence.verified()} | {:error, [String.t()]},
          evidence: map() | nil
        }

  @doc "Verify each scenario directory under `out` and render the page to `out/index.html`."
  @spec write(Path.t(), keyword()) :: {:ok, Path.t(), [entry()]}
  def write(out, opts \\ []) do
    entries =
      out
      |> File.ls!()
      |> Enum.sort()
      |> Enum.map(&Path.join(out, &1))
      |> Enum.filter(&File.regular?(Path.join(&1, "evidence.json")))
      |> Enum.map(&entry(&1, opts))

    path = Path.join(out, "index.html")
    File.write!(path, render(entries))
    {:ok, path, entries}
  end

  @doc "Verify one evidence directory and pair the result with its raw evidence."
  @spec entry(Path.t(), keyword()) :: entry()
  def entry(dir, opts \\ []) do
    raw =
      with {:ok, bytes} <- File.read(Path.join(dir, "evidence.json")),
           {:ok, %{} = evidence} <- Jason.decode(bytes),
           do: evidence,
           else: (_ -> nil)

    %{dir: dir, result: Evidence.verify(dir, opts), evidence: raw}
  end

  @doc "Render `entries` as a complete HTML document."
  @spec render([entry()]) :: String.t()
  def render(entries) do
    """
    <!doctype html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Lattice fault evidence</title>
    <style>#{css()}</style>
    </head>
    <body>
    <main>
    <h1>Lattice fault evidence</h1>
    <p class="lede">Each card is one scripted fault with one invariant. The verifier re-derives every
    <span class="badge replayed">replayed</span> check from the authenticated logs and, for seeded
    scenarios, re-runs the script and requires byte-identical output.
    <span class="badge recorded">recorded</span> checks are the test run's own claim and are not
    outsider-checkable.</p>
    #{Enum.map_join(entries, "\n", &card/1)}
    </main>
    </body>
    </html>
    """
  end

  # --- Cards -----------------------------------------------------------------

  defp card(%{dir: dir, result: result, evidence: evidence}) do
    ev = evidence || %{}
    {status, status_class} = status(result)

    """
    <section class="card">
    <header>
    <h2>#{esc(ev["scenario"] || Path.basename(dir))}</h2>
    <span class="status #{status_class}">#{esc(status)}</span>
    <span class="verdict #{verdict_class(ev["verdict"])}">#{esc(ev["verdict"] || "unknown")}</span>
    </header>
    <dl>
    <dt>Fault</dt><dd>#{esc(ev["fault"])}</dd>
    <dt>Invariant</dt><dd><code>#{esc(ev["invariant"])}</code></dd>
    <dt>Seed</dt><dd><code>#{esc(ev["seed"])}</code></dd>
    </dl>
    #{errors(result)}
    <h3>Checks</h3>
    <ul class="checks">#{checks(result, ev)}</ul>
    <h3>Replicas</h3>
    #{replicas(ev["replicas"])}
    <h3>Quarantine</h3>
    #{quarantine(ev["quarantine"])}
    </section>
    """
  end

  defp status({:error, _}), do: {"unverified", "bad"}

  defp status({:ok, %{checks: checks}}) do
    if Enum.all?(checks, &(&1.source == :replay)),
      do: {"verified", "good"},
      else: {"replay verified, process checks recorded", "partial"}
  end

  defp verdict_class("held"), do: "good"
  defp verdict_class(_), do: "bad"

  defp errors({:error, reasons}),
    do: ~s(<ul class="errors">) <> Enum.map_join(reasons, "", &"<li>#{esc(&1)}</li>") <> "</ul>"

  defp errors(_), do: ""

  defp checks({:ok, %{checks: checks}}, _ev),
    do: Enum.map_join(checks, "", fn c -> check_item(c.name, badge(c.source, c.ok)) end)

  defp checks({:error, _}, ev) do
    ev
    |> Map.get("checks")
    |> List.wrap()
    |> Enum.map_join("", fn
      %{} = c -> check_item(c["name"], "unverified")
      _ -> ""
    end)
  end

  defp badge(_source, false), do: "failed"
  defp badge(:process, true), do: "recorded"
  defp badge(_replay, true), do: "replayed"

  defp check_item(name, badge),
    do: ~s(<li><span class="badge #{badge}">#{badge}</span> <code>#{esc(name)}</code></li>)

  defp replicas(%{} = replicas) do
    rows =
      replicas
      |> Enum.sort()
      |> Enum.map_join("", fn {log, hashes} ->
        h = if is_map(hashes), do: hashes, else: %{}

        "<tr><td><code>#{esc(log)}</code></td><td><code>#{esc(short(h["frontier"]))}</code></td>" <>
          "<td><code>#{esc(short(h["state"]))}</code></td></tr>"
      end)

    ~s(<table><thead><tr><th>Log</th><th>Frontier</th><th>State</th></tr></thead><tbody>#{rows}</tbody></table>)
  end

  defp replicas(_), do: "<p>None recorded.</p>"

  defp quarantine([_ | _] = entries) do
    logs =
      entries
      |> Enum.flat_map(fn
        %{"reasons" => %{} = r} -> Map.keys(r)
        _ -> []
      end)
      |> Enum.uniq()
      |> Enum.sort()

    head = Enum.map_join(logs, "", &"<th><code>#{esc(&1)}</code></th>")

    rows =
      Enum.map_join(entries, "", fn entry ->
        reasons = if is_map(entry["reasons"]), do: entry["reasons"], else: %{}
        cells = Enum.map_join(logs, "", &"<td>#{esc(Map.get(reasons, &1, ""))}</td>")
        "<tr><td><code>#{esc(short(entry["op"]))}</code></td>#{cells}</tr>"
      end)

    ~s(<div class="scroll"><table><thead><tr><th>Op</th>#{head}</tr></thead><tbody>#{rows}</tbody></table></div>)
  end

  defp quarantine(_), do: "<p>Nothing quarantined.</p>"

  defp short(value) when is_binary(value) and byte_size(value) > 16,
    do: binary_part(value, 0, 16) <> "…"

  defp short(value), do: value

  @doc false
  @spec esc(term()) :: String.t()
  def esc(nil), do: ""

  def esc(value) when is_binary(value) do
    value
    |> String.replace("&", "&amp;")
    |> String.replace("<", "&lt;")
    |> String.replace(">", "&gt;")
    |> String.replace("\"", "&quot;")
    |> String.replace("'", "&#39;")
  end

  def esc(value), do: value |> inspect() |> esc()

  defp css do
    """
    :root{--bg:#fafaf7;--fg:#1d1d1b;--muted:#5f5e58;--card:#fff;--line:#e3e1d9;
    --good:#1f7a3a;--good-bg:#e6f4ea;--bad:#a12622;--bad-bg:#fbe9e7;--part:#8a5a00;--part-bg:#fff4dc;
    --rec:#3d4f9a;--rec-bg:#e9ecf8}
    @media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a8a69e;--card:#1e1e1c;
    --line:#34332f;--good:#7fd19a;--good-bg:#173323;--bad:#f2948f;--bad-bg:#3a1b19;--part:#f0c36a;
    --part-bg:#352a12;--rec:#a9b6ef;--rec-bg:#1f2540}}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
    font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
    main{max-width:960px;margin:0 auto;padding:32px 16px}h1{font-size:1.6rem;margin:0 0 8px}
    .lede{color:var(--muted);max-width:70ch}h2{font-size:1.2rem;margin:0}h3{font-size:.95rem;margin:20px 0 8px}
    .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:20px 0}
    header{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .status,.verdict,.badge{font-size:.78rem;font-weight:600;padding:2px 9px;border-radius:999px}
    .good{color:var(--good);background:var(--good-bg)}.bad{color:var(--bad);background:var(--bad-bg)}
    .partial{color:var(--part);background:var(--part-bg)}.replayed{color:var(--good);background:var(--good-bg)}
    .recorded{color:var(--rec);background:var(--rec-bg)}.failed,.unverified{color:var(--bad);background:var(--bad-bg)}
    dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:14px 0 0}dt{color:var(--muted)}dd{margin:0}
    .checks{list-style:none;padding:0;margin:0;display:grid;gap:6px}
    .errors{color:var(--bad);background:var(--bad-bg);border-radius:8px;padding:10px 10px 10px 28px}
    .scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.85rem}
    th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;white-space:nowrap}
    code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em}
    """
  end
end
