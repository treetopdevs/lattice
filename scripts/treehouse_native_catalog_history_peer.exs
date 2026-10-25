# Real BEAM DAG/signature peer. A DAG result carries no authority judgment.
alias Lattice.{Log, Op}
alias Lattice.Carrier.Wire
alias Treehouse.CatalogTrustVectors
Code.ensure_loaded!(CatalogTrustVectors)
_ = [:post]

graph = fn log ->
  %{
    replica: log.replica,
    frames: log.ops |> Map.values() |> Enum.sort_by(& &1.id) |> Enum.map(&Wire.encode_op/1),
    order: Enum.map(Log.topo_ops(log), & &1.id),
    frontier: Enum.sort(Log.frontier(log))
  }
end

case System.argv() do
  ["produce"] ->
    fixture = CatalogTrustVectors.fixture(2)
    logs = [fixture.space_log | Enum.map(fixture.threads, & &1.log)]
    IO.puts(Jason.encode!(%{histories: Enum.map(logs, graph)}))

  ["consume"] ->
    input = IO.read(:stdio, :eof) |> Jason.decode!()

    Enum.each(input["histories"], fn history ->
      ops =
        Enum.map(history["frames"], fn frame ->
          {:ok, %Op{} = op} = Wire.decode_op(frame)
          true = Op.valid?(op)
          op
        end)

      log = Log.from_ops(history["replica"], Map.new(ops, &{&1.id, &1}))
      :ok = Log.verify_authenticity(log)
      true = map_size(log.ops) == length(ops)
      actual = graph.(log)
      true = actual.order == history["order"]
      true = actual.frontier == history["frontier"]
    end)

    IO.puts(Jason.encode!(%{histories: length(input["histories"])}))
end
