#!/usr/bin/env sh
set -eu

mix test apps/lattice_core/test
mix lattice.research.demo
mix lattice.graph.snapshot --format json >/tmp/lattice_graph_snapshot.json
mix lattice.graph.snapshot --format dot >/tmp/lattice_graph_snapshot.dot
mix lattice.graph.snapshot --format mermaid >/tmp/lattice_graph_snapshot.mmd

echo "research demo complete"
echo "json: /tmp/lattice_graph_snapshot.json"
echo "dot: /tmp/lattice_graph_snapshot.dot"
echo "mermaid: /tmp/lattice_graph_snapshot.mmd"
