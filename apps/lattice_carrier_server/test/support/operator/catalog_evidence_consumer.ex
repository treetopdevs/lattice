defmodule LatticeCarrierServer.Operator.CatalogEvidenceConsumer do
  @moduledoc false

  def consume(path) do
    root = Path.expand("../../../../..", __DIR__)

    System.cmd(
      "node",
      ["--import", "tsx", "test/support/consume_catalog_evidence.ts", path],
      cd: Path.join(root, "clients/lattice-client"),
      stderr_to_stdout: true
    )
  end
end
