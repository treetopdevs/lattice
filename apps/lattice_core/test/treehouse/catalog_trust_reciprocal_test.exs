defmodule Treehouse.CatalogTrustReciprocalTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Log, Op, Sync}
  alias Lattice.Carrier.Wire
  alias Treehouse.{CatalogCutoff, CatalogTrust, CatalogTrustVectors, TransportCatalog}

  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @exporter "test/support/export_treehouse_catalog_trust.ts"
  @expected %{trust_revision: 0, history_generation: 0}
  @fixture_sha "64688429c8306d83c4d3236743dceffb6348278ccdca51bbaaa0644af8e88036"

  @tag :tmp_dir
  test "fresh BEAM catalog and rotation evidence verifies through actual TS trust", %{
    tmp_dir: tmp_dir
  } do
    path = Path.join(tmp_dir, "beam_trust.json")
    vector = CatalogTrustVectors.write_public_fixture!(path)
    assert File.exists?(path)
    assert Jason.decode!(File.read!(path))["expected"]["catalogId"] == vector.expected.catalogId
    refute File.read!(path) =~ "private"
    refute File.read!(path) =~ "seed"
    assert run_ts!(["--verify-beam", path]) =~ "PASS BEAM→TS public prepare/catalog/rotation"
  end

  @tag :tmp_dir
  test "fresh TS catalog evidence matches BEAM bytes, cutoffs and decisions in both orders", %{
    tmp_dir: tmp_dir
  } do
    path =
      System.get_env("TREEHOUSE_TS_TRUST_VECTOR") ||
        Path.expand(
          "../../../../clients/lattice-client/test/vectors/catalog/ts_trust.json",
          __DIR__
        )

    assert File.regular?(path), "integrated TS trust fixture is required"
    sha = :crypto.hash(:sha256, File.read!(path)) |> Base.encode16(case: :lower)
    assert sha == @fixture_sha
    generated = Path.join(tmp_dir, "ts_trust.json")
    run_ts!(["--out", generated])

    assert File.read!(generated) == File.read!(path),
           "fresh TS producer differs from pinned signed fixture"

    fixture = CatalogTrustVectors.read_ts_fixture!(generated)
    {:ok, catalog_envelope} = decode_artifact(fixture.catalog_json)
    {:ok, rotation_envelope} = decode_artifact(fixture.rotation_json)
    {:ok, rotated_envelope} = decode_artifact(fixture.rotated_catalog_json)

    assert TransportCatalog.catalog_id(catalog_envelope.catalog) == fixture.expected["catalogId"]
    assert TransportCatalog.rotation_id(rotation_envelope) == fixture.expected["rotationId"]

    assert TransportCatalog.catalog_id(rotated_envelope.catalog) ==
             fixture.expected["rotationObservation"]["accepted"]["catalog"]

    assert Base.encode64(TransportCatalog.catalog_bytes(catalog_envelope.catalog)) ==
             fixture.expected["catalogBytes"]

    assert Base.encode64(TransportCatalog.rotation_bytes(rotation_envelope.rotation)) ==
             fixture.expected["rotationBytes"]

    assert Base.encode64(TransportCatalog.rotation_possession_bytes(rotation_envelope.rotation)) ==
             fixture.expected["possessionBytes"]

    for reverse <- [false, true] do
      histories = if reverse, do: reverse_histories(fixture.histories), else: fixture.histories
      space_history = Enum.find(histories, &(&1.replica == fixture.review.space))

      assert %{kind: :propose, next: prepared} =
               CatalogTrust.prepare_installation(%{
                 review: fixture.review,
                 history: space_history,
                 store: %{kind: :verified_fresh, expected: @expected}
               })

      assert %{kind: :propose, reason: nil, next: initial, routes: initial_routes} =
               evaluate(prepared, catalogs: [fixture.catalog_json], histories: histories)

      assert initial.accepted.catalog == fixture.expected["catalogId"]

      assert route_projection(initial_routes) ==
               entry_projection(catalog_envelope.catalog.entries)

      assert %{kind: :propose, reason: nil, next: rotated, routes: rotated_routes} =
               evaluate(initial,
                 catalogs: [fixture.rotated_catalog_json],
                 rotations: [fixture.rotation_json],
                 cutoff_proofs: fixture.cutoff_proofs
               )

      assert rotated.accepted.catalog ==
               fixture.expected["rotationObservation"]["accepted"]["catalog"]

      assert route_projection(rotated_routes) ==
               entry_projection(rotated_envelope.catalog.entries)

      if fixture.fork_catalog_json do
        assert %{kind: :retain_blocked, reason: :catalog_fork, routes: []} =
                 evaluate(rotated, catalogs: [fixture.fork_catalog_json])
      end
    end
  end

  @tag :tmp_dir
  test "new BEAM continuity evidence verifies exact cutoff and catalog reopen in TS", %{
    tmp_dir: dir
  } do
    path = Path.join(dir, "beam-continuity-catalog.json")
    vector = CatalogTrustVectors.write_public_fixture!(path)
    fixture = CatalogTrustVectors.fixture(1)

    names =
      @client
      |> Path.join("test/vectors/catalog/cutoff_atoms_with_member_continuity_v1.json")
      |> File.read!()
      |> Jason.decode!()

    atoms = Enum.map(names, &String.to_existing_atom/1)

    op =
      Op.new(
        fixture.space.root,
        fixture.space.replica,
        Log.frontier(fixture.space_log),
        :command,
        {:attest_member_key_v1, [atoms]}
      )

    assert {:quarantined, rejected, :bad_signature} =
             Log.accept(fixture.space_log, %{op | sig: <<>>})

    log = Log.append!(rejected, op)

    histories = [
      CatalogTrustVectors.raw_history(log)
      | Enum.reject(fixture.histories, &(&1.replica == log.replica))
    ]

    cutoffs = Enum.map(histories, &history_cutoff/1)

    vector = %{
      vector
      | histories: histories,
        cutoffProofs: [],
        expected: Map.put(vector.expected, :cutoffs, cutoffs)
    }

    File.write!(path, Jason.encode!(vector, pretty: true) <> "\n")
    verify_extension(path)

    assert run_extension!(["--verify-beam", path]) =~
             "PASS BEAM→TS continuity catalog install/reopen"
  end

  @tag :tmp_dir
  test "new independently TS-signed continuity history remains portable and ordinarily unknown in BEAM",
       %{tmp_dir: dir} do
    path = Path.join(dir, "ts-continuity-catalog.json")
    assert run_extension!(["--out", path]) =~ "Exported independently TS-signed"
    verify_extension(path)
  end

  defp verify_extension(path) do
    fixture = CatalogTrustVectors.read_ts_fixture!(path)
    expected_cutoffs = fixture.expected["cutoffs"]

    for {history, cutoff} <- Enum.zip(fixture.histories, expected_cutoffs) do
      assert history_cutoff(history) == cutoff

      assert history_cutoff(%{
               history
               | frames: Enum.reverse(history.frames),
                 rejected: Enum.reverse(history.rejected)
             }) == cutoff
    end

    states =
      for reverse <- [false, true] do
        histories = if reverse, do: reverse_histories(fixture.histories), else: fixture.histories
        space = Enum.find(histories, &(&1.replica == fixture.review.space))

        assert %{kind: :propose, next: prepared} =
                 CatalogTrust.prepare_installation(%{
                   review: fixture.review,
                   history: space,
                   store: %{kind: :verified_fresh, expected: @expected}
                 })

        assert %{kind: :propose, next: installed, routes: routes} =
                 evaluate(prepared, catalogs: [fixture.catalog_json], histories: histories)

        assert installed.accepted.catalog == fixture.expected["catalogId"]
        assert length(routes) == 2
        assert %{kind: :unchanged, next: ^installed} = evaluate(installed, [])
        log = history_log(space)

        [command] =
          Enum.filter(Log.topo_ops(log), fn op -> match?({:attest_member_key_v1, _}, op.body) end)

        assert Authority.analyze(Treehouse.Space, log).reasons[command.id] == :unknown_command

        baseline =
          Log.topo_ops(log)
          |> Enum.reject(&(&1.id == command.id))
          |> Enum.reduce(Log.new(log.replica), &Log.append!(&2, &1))

        assert Lattice.state(Treehouse.Space, log) == Lattice.state(Treehouse.Space, baseline)
        installed
      end

    assert Enum.at(states, 0) == Enum.at(states, 1)
  end

  defp history_cutoff(history) do
    assert {:ok, value} = history |> history_log() |> CatalogCutoff.derive()

    %{
      "ok" => true,
      "cutoff" => %{
        "replica" => value.cutoff.replica,
        "frontier" => value.cutoff.frontier,
        "logDigest" => value.cutoff.log_digest
      },
      "canonicalBytes" => Base.encode64(value.canonical_bytes),
      "ops" => Enum.map(value.ops, &cutoff_record/1),
      "rejected" =>
        Enum.map(value.rejected, &Map.put(cutoff_record(&1), "reason", "bad_signature"))
    }
  end

  defp history_log(history) do
    log =
      Enum.reduce(history.rejected, Log.new(history.replica), fn evidence, log ->
        assert {:ok, op} = Wire.decode_op(evidence.frame)
        assert {:quarantined, log, :bad_signature} = Log.accept(log, op)
        log
      end)

    assert {:ok, ops} = Wire.decode_ops(history.frames)
    assert Enum.all?(ops, &Op.valid?/1)
    {log, %{pending: []}} = Sync.deliver(log, ops)
    assert :ok = Log.verify_authenticity(log)
    log
  end

  defp cutoff_record(record),
    do: %{
      "id" => record.id,
      "bytes" => Base.encode64(record.bytes),
      "sig" => Base.encode64(record.sig)
    }

  defp run_extension!(arguments) do
    {output, status} =
      System.cmd(
        Path.join(@client, "node_modules/.bin/tsx"),
        ["test/support/export_member_continuity_catalog.ts" | arguments],
        cd: @client,
        stderr_to_stdout: true
      )

    assert status == 0, output
    output
  end

  defp run_ts!(arguments) do
    {output, status} =
      System.cmd(Path.join(@client, "node_modules/.bin/tsx"), [@exporter | arguments],
        cd: @client,
        stderr_to_stdout: true
      )

    assert status == 0, output
    output
  end

  defp evaluate(installed, incoming) do
    incoming = Map.new(incoming)

    CatalogTrust.evaluate(%{
      installed: installed,
      expected: @expected,
      incoming: %{
        catalogs: Map.get(incoming, :catalogs, []),
        rotations: Map.get(incoming, :rotations, []),
        histories: Map.get(incoming, :histories, []),
        cutoff_proofs: Map.get(incoming, :cutoff_proofs, [])
      }
    })
  end

  defp decode_artifact(json) do
    with {:ok, raw} <- Jason.decode(json), do: Wire.decode_value(raw)
  end

  defp reverse_histories(histories) do
    histories
    |> Enum.reverse()
    |> Enum.map(&%{&1 | frames: Enum.reverse(&1.frames), rejected: Enum.reverse(&1.rejected)})
  end

  defp route_projection(routes) do
    routes
    |> Enum.map(
      &Map.take(&1, [
        :replica,
        :root,
        :genesis,
        :creation,
        :reference,
        :service_id,
        :service_key,
        :path,
        :schema,
        :kind
      ])
    )
    |> Enum.sort_by(& &1.replica)
  end

  defp entry_projection(entries) do
    entries
    |> Enum.map(fn entry ->
      entry
      |> Map.take([
        :replica,
        :root,
        :genesis,
        :creation,
        :reference,
        :service_id,
        :service_key,
        :schema,
        :kind
      ])
      |> Map.put(:path, entry.route)
    end)
    |> Enum.sort_by(& &1.replica)
  end
end
