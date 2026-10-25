# Executable independent BEAM peer for native codec vectors. No trust installation.
# Boundary crypto re-derivation is a test-local command oracle; actual wire
# admission is independently observed through Wire.decode_op/1.
alias Lattice.{Canonical, Op}
alias Lattice.Carrier.Wire
alias Treehouse.{CatalogTrustVectors, CatalogVectors, TransportCatalog}
Code.ensure_loaded!(TransportCatalog)
# Compile-time test vocabulary only; never create atoms from incoming text.
_ = [
  :kind,
  :post,
  :author_edit,
  :genesis,
  :admin,
  :moderator,
  :"Unicode:雪",
  :native_unadmitted_probe
]

case System.argv() do
  ["produce"] ->
    vector = CatalogVectors.codec_vector()
    histories = CatalogTrustVectors.fixture().histories
    frames = Enum.flat_map(histories, & &1.frames)
    IO.puts(Jason.encode!(Map.put(vector, :frames, frames)))

  ["boundaries"] ->
    input = IO.read(:stdio, :eof) |> Jason.decode!()

    terms =
      Enum.map(input["terms"], fn item ->
        case Wire.decode_value(item["term"]) do
          {:ok, value} -> %{accepted: true, bytes: Base.encode64(Canonical.term(value))}
          _ -> %{accepted: false}
        end
      end)

    frames =
      Enum.map(input["frames"], fn item ->
        raw = item["frame"]

        admitted =
          case Wire.decode_op(raw) do
            {:ok, op} -> Op.valid?(op)
            _ -> false
          end

        authentic =
          with {:ok, body} <- Wire.decode_value(raw["body"]),
               {:ok, cap} <- Wire.decode_value(raw["cap"]) do
            key = Base.decode64!(raw["author"])

            payload =
              Canonical.term([
                "lattice-op-v2",
                raw["replica"],
                key,
                Enum.sort(Enum.uniq(raw["deps"])),
                :command,
                body,
                cap
              ])

            Base.url_encode64(:crypto.hash(:sha256, payload), padding: false) == raw["id"] and
              Lattice.Identity.verify(key, payload, Base.decode64!(raw["sig"]))
          else
            _ -> false
          end

        %{admitted: admitted, authentic: authentic}
      end)

    IO.puts(Jason.encode!(%{terms: terms, frames: frames}))

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
