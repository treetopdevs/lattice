#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

FLAGSHIP_OUT="${LATTICE_FLAGSHIP_OUT:-output/flagship}"
PLAYWRIGHT_OUT="output/playwright"

mkdir -p "$FLAGSHIP_OUT" "$PLAYWRIGHT_OUT"

if [[ "${LATTICE_SKIP_DEPS:-0}" != "1" ]]; then
  mix deps.get
  npm ci
  npm --prefix clients/lattice-client ci
  npm --prefix clients/township-tauri-shell ci
fi

if [[ "${LATTICE_SKIP_PLAYWRIGHT_INSTALL:-0}" != "1" ]]; then
  npx playwright install chromium
fi

mix format --check-formatted
mix test apps/lattice_core/test/lattice_flagship_test.exs apps/lattice_server/test/flagship_http_test.exs apps/lattice_server/test/federated_workers_http_test.exs
mix compile
npm run browser:worker:e2e
npm run flagship:e2e
npm run township:action-handoff:e2e

mix run -e '
out = System.get_env("LATTICE_FLAGSHIP_OUT") || "output/flagship"
File.mkdir_p!(out)
{:ok, snapshot} = Lattice.Flagship.run_all()
graph = snapshot.graph
claims = Lattice.Flagship.claims()

File.write!(Path.join(out, "flagship-snapshot.json"), Jason.encode!(snapshot, pretty: true))
File.write!(Path.join(out, "flagship-graph.json"), Jason.encode!(graph, pretty: true))
File.write!(Path.join(out, "flagship-graph.mmd"), Lattice.Graph.Export.export(graph, :mermaid))
File.write!(Path.join(out, "flagship-graph.dot"), Lattice.Graph.Export.export(graph, :dot))
File.write!(Path.join(out, "claims.json"), Jason.encode!(claims, pretty: true))
Lattice.Flagship.Claims.validate!(File.cwd!(), generated_artifacts?: true)
'

printf "\nFlagship verification artifacts:\n"
printf "  video: %s\n" "$(find "$PLAYWRIGHT_OUT/test-results" -name 'video.webm' -type f | sort | tail -n 1)"
printf "  screenshot: %s/flagship-demo.png\n" "$PLAYWRIGHT_OUT"
printf "  browser Worker proof: %s/browser-worker-demo.json\n" "$PLAYWRIGHT_OUT"
printf "  video evaluation: %s/flagship-video-evaluation.json\n" "$PLAYWRIGHT_OUT"
printf "  snapshot JSON: %s/flagship-snapshot.json\n" "$FLAGSHIP_OUT"
printf "  graph JSON: %s/flagship-graph.json\n" "$FLAGSHIP_OUT"
printf "  graph Mermaid: %s/flagship-graph.mmd\n" "$FLAGSHIP_OUT"
printf "  graph DOT: %s/flagship-graph.dot\n" "$FLAGSHIP_OUT"
printf "  claims JSON: %s/claims.json\n" "$FLAGSHIP_OUT"
