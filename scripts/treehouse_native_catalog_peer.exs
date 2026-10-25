# Executable independent BEAM peer for native codec vectors. No trust installation.
alias Lattice.{Canonical, Op}
alias Lattice.Carrier.Wire
alias Treehouse.{CatalogTrustVectors, CatalogVectors, TransportCatalog}
Code.ensure_loaded!(TransportCatalog)
# Compile-time test vocabulary only; never create atoms from incoming text.
_ = [:kind, :post, :author_edit, :genesis, :admin, :moderator, :"Unicode:雪"]

case System.argv() do
  ["produce"] ->
    vector = CatalogVectors.codec_vector()
    histories = CatalogTrustVectors.fixture().histories
    frames = Enum.flat_map(histories, & &1.frames)
    IO.puts(Jason.encode!(Map.put(vector, :frames, frames)))

  ["consume"] ->
    vector = IO.read(:stdio, :eof) |> Jason.decode!()

    Enum.each(Enum.with_index(vector["terms"]), fn {item, index} ->
      {:ok, value} =
        case Wire.decode_value(item["term"]) do
          {:ok, _} = decoded -> decoded
          other -> raise "term #{index} refused: #{inspect(other)}"
        end

      true = Base.encode64(Canonical.term(value)) == item["bytes"]
    end)

    {:ok, frame} = Wire.decode_op(vector["frame"])
    true = Op.valid?(frame)
    {:ok, envelope} = Wire.decode_value(vector["catalog_envelope_term"])

    :ok =
      TransportCatalog.verify_catalog(envelope, Base.decode64!(vector["expected_catalog_key"]))

    true = TransportCatalog.catalog_id(envelope.catalog) == vector["catalog_id"]

    true =
      Base.encode64(TransportCatalog.catalog_bytes(envelope.catalog)) == vector["catalog_bytes"]

    IO.puts(
      Jason.encode!(%{
        terms: length(vector["terms"]),
        frame: frame.id,
        catalog: vector["catalog_id"]
      })
    )
end
