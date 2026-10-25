defmodule LatticeCarrierServer.Operator.CatalogEvidence.ExportTest do
  use ExUnit.Case, async: false
  if :os.type() != {:unix, :linux}, do: @moduletag(skip: "Requires actual Linux operator owner")

  alias LatticeCarrierServer.Operator.{
    CatalogEvidence,
    CatalogEvidence.Packet,
    CatalogEvidenceConsumer,
    CatalogStore,
    Journal,
    PublicationFixture,
    ReleaseListing
  }

  alias Lattice.{Log, Op, Sim}
  alias LatticeCarrierServer.Durability
  alias Treehouse.TransportCatalog

  setup context do
    context =
      if context[:standalone],
        do: Map.put(context, :listener_ports, listener_ports()),
        else: context

    {:ok, fixture} = PublicationFixture.catalogued(context)

    unless context[:unlisted] do
      assert {:ok, _} =
               ReleaseListing.publish(
                 fixture.root,
                 fixture.catalogued,
                 fixture.ceremony_dir,
                 fixture.probe
               )
    end

    output =
      Path.join(
        Path.dirname(fixture.root),
        "catalog-evidence-#{System.unique_integer([:positive])}.json"
      )

    on_exit(fn -> File.rm(output) end)
    Map.put(fixture, :output, output)
  end

  test "actual listed host snapshot exports and existing output is preserved", f do
    before = inputs(f)
    assert {:ok, _} = CatalogEvidence.export(f.root, f.ceremony_dir, f.manifest, f.output)
    bytes = File.read!(f.output)
    assert {:ok, packet} = Packet.decode(bytes)
    assert packet.head == TransportCatalog.catalog_id(f.catalog)
    {consumed, status} = CatalogEvidenceConsumer.consume(f.output)
    assert status == 0, consumed
    assert JSON.decode!(consumed)["snapshotBytes"] == packet.snapshot_bytes

    assert {:error, :evidence_output_exists} =
             CatalogEvidence.export(f.root, f.ceremony_dir, f.manifest, f.output)

    assert File.read!(f.output) == bytes
    assert inputs(f) == before
  end

  @tag :initial
  test "initial existing reference exports without rewriting source inputs", f do
    before = inputs(f)
    assert {:ok, _} = CatalogEvidence.export(f.root, f.ceremony_dir, f.manifest, f.output)
    assert {:ok, _} = Packet.decode(File.read!(f.output))
    assert inputs(f) == before
  end

  test "closed command refuses duplicate options and forbidden output paths", f do
    args = [
      "--root",
      f.root,
      "--ceremony",
      f.ceremony_dir,
      "--manifest",
      f.manifest,
      "--out",
      f.output
    ]

    assert {:error, :invalid_evidence_options} =
             Mix.Tasks.Treehouse.CatalogEvidence.execute(args ++ ["--root", f.root])

    assert {:error, :unsafe_export_location} =
             CatalogEvidence.export(
               f.root,
               f.ceremony_dir,
               f.manifest,
               Path.join(f.root, "new.json")
             )

    assert {:ok, _} = Mix.Tasks.Treehouse.CatalogEvidence.execute(args)
  end

  @tag :unlisted
  test "a catalogued but unlisted record cannot be exported", f do
    assert {:error, :catalog_not_listed} =
             CatalogEvidence.export(f.root, f.ceremony_dir, f.manifest, f.output)

    refute File.exists?(f.output)
  end

  test "existing links and a symlinked output directory refuse without replacing bytes", f do
    target = f.output <> ".target"
    File.write!(target, "preserved")
    on_exit(fn -> File.rm(target) end)
    File.ln_s!(target, f.output)

    assert {:error, :evidence_output_exists} =
             CatalogEvidence.export(f.root, f.ceremony_dir, f.manifest, f.output)

    assert File.read!(target) == "preserved"
    File.rm!(f.output)
    File.ln!(target, f.output)

    assert {:error, :evidence_output_exists} =
             CatalogEvidence.export(f.root, f.ceremony_dir, f.manifest, f.output)

    assert File.read!(target) == "preserved"
    link = f.output <> ".dir"
    File.ln_s!(Path.dirname(f.output), link)
    on_exit(fn -> File.rm(link) end)

    assert {:error, :unsafe_export_location} =
             CatalogEvidence.export(
               f.root,
               f.ceremony_dir,
               f.manifest,
               Path.join(link, "new.json")
             )
  end

  test "authentic source drift refuses and preserves the new signed history", f do
    previous = Application.get_env(:lattice_carrier_server, :catalog_evidence_hook)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:lattice_carrier_server, :catalog_evidence_hook, previous),
        else: Application.delete_env(:lattice_carrier_server, :catalog_evidence_hook)
    end)

    Application.put_env(:lattice_carrier_server, :catalog_evidence_hook, fn ->
      Durability.with_target_lock(f.active_log, fn ->
        {:ok, %{log: log}} = Log.restore_verified(f.active_log)

        op =
          Op.new(
            Sim.identity(f.space, "creator"),
            log.replica,
            Log.frontier(log),
            :command,
            {:set_title, ["Concurrent authentic change"]},
            cap: f.reference.cap
          )

        Log.dump(Log.append!(log, op), f.active_log)
      end)
    end)

    assert {:error, :evidence_source_changed} =
             CatalogEvidence.export(f.root, f.ceremony_dir, f.manifest, f.output)

    refute File.exists?(f.output)
    assert {:ok, %{log: log}} = Log.restore_verified(f.active_log)

    assert Enum.any?(
             Log.topo_ops(log),
             &(&1.body == {:set_title, ["Concurrent authentic change"]})
           )
  end

  test "journal, manifest and committed catalog drift each refuse without deleting new bytes",
       f do
    key = :catalog_evidence_hook
    previous = Application.get_env(:lattice_carrier_server, key)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:lattice_carrier_server, key, previous),
        else: Application.delete_env(:lattice_carrier_server, key)
    end)

    [catalog] = Path.wildcard(Path.join(CatalogStore.path(f.root), "*.json"))

    for path <- [Journal.path(f.root), f.manifest, catalog] do
      original = File.read!(path)
      changed = original <> " "
      Application.put_env(:lattice_carrier_server, key, fn -> File.write!(path, changed) end)

      assert {:error, reason} =
               CatalogEvidence.export(f.root, f.ceremony_dir, f.manifest, f.output)

      assert is_atom(reason)
      refute File.exists?(f.output)
      assert File.read!(path) == changed
      File.write!(path, original)
    end
  end

  test "failed write removes only its created inode, preserving a replacement", f do
    key = :catalog_evidence_writer_hook
    previous = Application.get_env(:lattice_carrier_server, key)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:lattice_carrier_server, key, previous),
        else: Application.delete_env(:lattice_carrier_server, key)
    end)

    before = inputs(f)

    Application.put_env(:lattice_carrier_server, key, fn file, _path ->
      File.close(file)
      :ok
    end)

    assert {:error, :evidence_export_failed} =
             CatalogEvidence.export(f.root, f.ceremony_dir, f.manifest, f.output)

    refute File.exists?(f.output)
    assert inputs(f) == before

    Application.put_env(:lattice_carrier_server, key, fn file, path ->
      # Keep the original inode open until its replacement exists, so this also
      # proves cleanup uses descriptor identity rather than the current pathname.
      File.rm!(path)
      File.write!(path, "another process owns this file")
      File.close(file)
      :ok
    end)

    assert {:error, :evidence_export_failed} =
             CatalogEvidence.export(f.root, f.ceremony_dir, f.manifest, f.output)

    assert File.read!(f.output) == "another process owns this file"
    assert inputs(f) == before
  end

  test "compressed source allocation is bounded before decoding", f do
    bytes = <<131, 80, 67_108_864::unsigned-big-32, 0>>
    File.write!(f.active_log, bytes)

    assert {:error, :evidence_page_too_large} =
             CatalogEvidence.export(f.root, f.ceremony_dir, f.manifest, f.output)

    assert File.read!(f.active_log) == bytes
    refute File.exists?(f.output)
  end

  @tag :standalone
  test "the real standalone Mix command exports while the configured relay is already bound", f do
    before = inputs(f)
    supervisor = Process.whereis(LatticeCarrierServer.ApplicationSupervisor)
    shim = Path.expand("~/.asdf/shims/mix")
    mix = if File.regular?(shim), do: shim, else: System.find_executable("mix")
    root = Path.expand("../../../../..", __DIR__)

    {output, status} =
      System.cmd(
        mix,
        [
          "treehouse.catalog_evidence",
          "--root",
          f.root,
          "--ceremony",
          f.ceremony_dir,
          "--manifest",
          f.manifest,
          "--out",
          f.output
        ],
        cd: Path.join(root, "apps/lattice_carrier_server"),
        stderr_to_stdout: true,
        env: [
          {"MIX_ENV", "test"},
          {"LATTICE_CARRIER_MANIFEST", f.manifest},
          {"LATTICE_CARRIER_OPERATOR_ROOT", f.root}
        ]
      )

    assert status == 0, output
    assert String.contains?(output, f.output)
    assert {:ok, _} = Packet.decode(File.read!(f.output))
    assert Process.whereis(LatticeCarrierServer.ApplicationSupervisor) == supervisor
    assert inputs(f) == before
  end

  defp listener_ports do
    sockets =
      Enum.map(1..2, fn _ ->
        {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
        socket
      end)

    ports =
      Enum.map(sockets, fn socket ->
        {:ok, {_, port}} = :inet.sockname(socket)
        port
      end)

    Enum.each(sockets, &:gen_tcp.close/1)
    ports
  end

  defp inputs(f),
    do:
      {File.read!(f.active_log), elem(Journal.read(f.root), 1), File.read!(f.manifest),
       File.read!(Journal.history_path(f.root))}
end
