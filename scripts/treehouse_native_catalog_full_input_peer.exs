# Fresh independent BEAM inputs and complete actual public-owner decisions.
Code.require_file("support/native_peer_output.exs", __DIR__)
Code.require_file("support/catalog_resolver_json.exs", __DIR__)
alias Treehouse.{CatalogTrust, CatalogTrustVectors, TransportCatalog}
Code.ensure_loaded!(CatalogTrustVectors)
f = CatalogTrustVectors.fixture(1)
expected = %{trust_revision: 0, history_generation: 0}
empty = %{catalogs: [], rotations: [], histories: [], cutoff_proofs: []}

%{kind: :propose, next: initial} =
  CatalogTrust.prepare_installation(%{
    review: f.review,
    history: hd(f.histories),
    store: %{kind: :verified_fresh, expected: expected}
  })

accepted_input = %{
  installed: initial,
  expected: expected,
  incoming: %{empty | catalogs: [f.catalog_json], histories: f.histories}
}

%{kind: :propose, next: accepted} = CatalogTrust.evaluate(accepted_input)
rotation_id = TransportCatalog.rotation_id(f.rotation_envelope)

rotated_json =
  %{f.catalog | binding: rotation_id}
  |> CatalogTrustVectors.sign_catalog(f.next_catalog)
  |> CatalogTrustVectors.artifact_json()

rotation_input = %{
  installed: accepted,
  expected: expected,
  incoming: %{
    empty
    | catalogs: [rotated_json],
      rotations: [f.rotation_json],
      cutoff_proofs: f.cutoff_proofs
  }
}

%{kind: :propose, next: rotated} = CatalogTrust.evaluate(rotation_input)

late_json =
  %{f.catalog | revision: 1, previous: TransportCatalog.catalog_id(f.catalog)}
  |> CatalogTrustVectors.sign_catalog(f.space.catalog)
  |> CatalogTrustVectors.artifact_json()

fork_input = %{installed: rotated, expected: expected, incoming: %{empty | catalogs: [late_json]}}
%{kind: :retain_blocked, reason: :catalog_fork, next: frozen} = CatalogTrust.evaluate(fork_input)
[first | rest] = accepted.histories
[frame | frames] = first.frames

corrupt = %{
  accepted
  | histories: [
      %{first | frames: [Map.put(frame, "sig", Base.encode64(<<0::512>>)) | frames]} | rest
    ]
}

items = [
  {"beam-empty-installed", %{installed: initial, expected: expected, incoming: empty}},
  {"beam-complete-acceptance", accepted_input},
  {"beam-pending-entry",
   %{installed: initial, expected: expected, incoming: %{empty | catalogs: [f.catalog_json]}}},
  {"beam-rotation-pending-proof",
   %{rotation_input | incoming: %{rotation_input.incoming | cutoff_proofs: []}}},
  {"beam-complete-rotation", rotation_input},
  {"beam-original-corruption-before-repair", %{accepted_input | installed: corrupt}},
  {"beam-historical-catalog-fork", fork_input},
  {"beam-frozen-reopen", %{installed: frozen, expected: expected, incoming: empty}}
]

cases =
  Enum.map(items, fn {name, input} ->
    orders =
      Enum.map([false, true], fn reverse ->
        input =
          if reverse do
            page = input.incoming

            histories =
              Enum.map(Enum.reverse(page.histories), fn history ->
                %{
                  history
                  | frames: Enum.reverse(history.frames),
                    rejected: Enum.reverse(history.rejected)
                }
              end)

            %{
              input
              | incoming: %{
                  page
                  | catalogs: Enum.reverse(page.catalogs),
                    rotations: Enum.reverse(page.rotations),
                    histories: histories,
                    cutoff_proofs: Enum.reverse(page.cutoff_proofs)
                }
            }
          else
            input
          end

        %{input: input, decision: CatalogTrust.evaluate(input)}
      end)

    %{name: name, orders: orders}
  end)

Lattice.NativePeerOutput.puts(Jason.encode!(NativeCatalogResolverPeer.output(%{cases: cases})))
