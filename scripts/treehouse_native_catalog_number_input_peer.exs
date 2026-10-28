# Fresh BEAM-authored numeric observation inputs; no saved verdict is supplied.
Code.require_file("support/native_peer_output.exs", __DIR__)
Code.require_file("support/catalog_resolver_json.exs", __DIR__)
alias Treehouse.{CatalogTrust, CatalogTrustVectors}
alias Lattice.Carrier.Wire
f = CatalogTrustVectors.fixture(1)
expected = %{trust_revision: 0, history_generation: 0}
empty = %{catalogs: [], rotations: [], histories: [], cutoff_proofs: []}

%{kind: :propose, next: prepared} =
  CatalogTrust.prepare_installation(%{
    review: f.review,
    history: hd(f.histories),
    store: %{kind: :verified_fresh, expected: expected}
  })

%{kind: :propose, next: accepted} =
  CatalogTrust.evaluate(%{
    installed: prepared,
    expected: expected,
    incoming: %{empty | catalogs: [f.catalog_json], histories: f.histories}
  })

[history | rest] = accepted.histories
[frame | frames] = history.frames
alias_frame = Map.put(frame, "v", 1.0)
{:ok, _} = Wire.decode_op(frame)
{:error, :malformed_op} = Wire.decode_op(alias_frame)
saved = %{accepted | histories: [%{history | frames: [alias_frame | frames]} | rest]}

inputs = [
  {"beam-saved-version", %{installed: saved, expected: expected, incoming: empty}},
  {"beam-incoming-version",
   %{
     installed: accepted,
     expected: expected,
     incoming: %{empty | histories: [%{history | frames: [alias_frame]}]}
   }}
]

cases =
  for {name, input} <- inputs, reverse <- [false, true] do
    input =
      if reverse do
        update_in(input.installed.histories, fn rows ->
          rows |> Enum.reverse() |> Enum.map(&%{&1 | frames: Enum.reverse(&1.frames)})
        end)
      else
        input
      end

    %{name: "#{name}:#{reverse}", input: input}
  end

Lattice.NativePeerOutput.puts(Jason.encode!(NativeCatalogResolverPeer.output(%{cases: cases})))
