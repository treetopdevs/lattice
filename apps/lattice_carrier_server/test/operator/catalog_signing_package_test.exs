defmodule LatticeCarrierServer.Operator.CatalogSigningPackageTest do
  use ExUnit.Case, async: false
  alias Lattice.{Authority, Log, Sim}
  alias LatticeCarrierServer.Operator.CatalogCeremony.{SignCatalog, SigningLedger}

  alias LatticeCarrierServer.Operator.{
    CatalogBinding,
    CatalogSigningPackage,
    CeremonyFixture,
    Fixture,
    PublicHistory
  }

  setup do
    {:ok, fixture} = Fixture.new(second_member: true)
    space = fixture[:updated_log]
    child = Sim.log(fixture[:child], "creator")
    {:ok, binding} = CatalogBinding.load_log(fixture[:ceremony_dir], space)

    entries =
      for {log, kind, schema, reference, route} <- [
            {space, :space, :treehouse_space_v1, binding.bootstrap_id, fixture[:space_route]},
            {child, :thread, :treehouse_thread_v1, fixture[:reference].id, fixture[:child_route]}
          ] do
        command = if kind == :space, do: :create_space, else: :create_thread
        genesis = Enum.find(Map.values(log.ops), &(&1.kind == :authority and &1.deps == []))
        creation = Enum.find(Map.values(log.ops), &match?(%{body: {^command, [_]}}, &1))

        %{
          product: :treehouse,
          replica: log.replica,
          kind: kind,
          schema: schema,
          root: Authority.root(log),
          genesis: genesis.id,
          creation: creation.id,
          reference: reference,
          route: route,
          service_id: binding.record.service_id,
          service_key: binding.record.service_key
        }
      end

    catalog = %{
      version: 1,
      product: :treehouse,
      space: space.replica,
      bootstrap: binding.bootstrap_id,
      binding: binding.bootstrap_id,
      revision: 0,
      previous: nil,
      entries: Enum.sort_by(entries, & &1.replica)
    }

    {:ok,
     fixture: fixture,
     catalog: catalog,
     histories: %{space.replica => space, child.replica => child}}
  end

  test "initial reference is independently reviewed against the custodian ceremony", f do
    assert {:ok, bytes} = encode(f)
    assert {:ok, package} = CatalogSigningPackage.review(bytes, f.fixture[:ceremony_dir])
    assert package.catalog == f.catalog
    assert package.histories == f.histories
    assert package.observed == f.histories
    assert package.reference == f.fixture[:reference]
    assert package.binding.bootstrap_id == f.catalog.bootstrap
  end

  test "pending reference is hypothetical and does not modify the supplied Space", f do
    reference = f.fixture[:reference]
    space = f.histories[f.catalog.space]

    histories =
      Map.put(
        f.histories,
        space.replica,
        Log.from_ops(space.replica, Map.delete(space.ops, reference.id))
      )

    assert :ok = Log.verify_authenticity(histories[space.replica])
    assert {:ok, bytes} = CatalogSigningPackage.encode(f.catalog, histories, reference, "pending")
    assert {:ok, package} = CatalogSigningPackage.decode(bytes)
    refute Map.has_key?(package.histories[space.replica].ops, reference.id)
    assert package.observed == f.histories

    assert {:error, :invalid_catalog_package} =
             CatalogSigningPackage.encode(f.catalog, f.histories, reference, "pending")
  end

  test "closed canonical package refuses malformed and incomplete public evidence", f do
    {:ok, bytes} = encode(f)
    doc = JSON.decode!(bytes)
    [first | rest] = doc["histories"]
    [frame | frames] = first["frames"]
    bad = %{first | "frames" => [Map.put(frame, "sig", Base.encode64(<<0::512>>)) | frames]}

    for changed <- [
          Map.put(doc, "trusted", true),
          Map.put(doc, "digest", String.duplicate("0", 64)),
          Map.put(doc, "histories", rest),
          Map.put(doc, "histories", [first | doc["histories"]]),
          Map.put(doc, "histories", [bad | rest]),
          Map.put(doc, "reference", Map.put(doc["reference"], "mode", "listed"))
        ] do
      assert {:error, :invalid_catalog_package} =
               changed |> PublicHistory.canonical() |> CatalogSigningPackage.decode()
    end

    for altered <- [
          " " <> bytes,
          <<255>>,
          String.replace(bytes, "{", "{\"trusted\":true,", global: false)
        ] do
      assert {:error, :invalid_catalog_package} = CatalogSigningPackage.decode(altered)
    end
  end

  test "catalog metadata cannot replace the actual creation or independent root", f do
    thread = Enum.find(f.catalog.entries, &(&1.kind == :thread))

    for change <- [
          %{root: Authority.root(f.histories[f.catalog.space])},
          %{creation: thread.genesis}
        ] do
      catalog = %{
        f.catalog
        | entries:
            Enum.map(f.catalog.entries, fn entry ->
              if entry.kind == :thread, do: Map.merge(entry, change), else: entry
            end)
      }

      assert {:error, :invalid_catalog_package} = encode(%{f | catalog: catalog})
    end
  end

  test "a missing custodian ceremony cannot establish the package's binding", f do
    {:ok, bytes} = encode(f)

    assert {:error, _} =
             CatalogSigningPackage.review(bytes, f.fixture[:ceremony_dir] <> "/missing")
  end

  test "a different completed ceremony refuses despite valid public histories", f do
    {:ok, bytes} = encode(f)
    base = Path.join(System.tmp_dir!(), "catalog-other-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf!(base) end)
    other = CeremonyFixture.build(base)
    assert {:error, _} = CatalogSigningPackage.review(bytes, other.ceremony)
  end

  test "duplicate envelope keys and oversized public input refuse", f do
    {:ok, bytes} = encode(f)

    duplicate =
      ~s({"format":"treehouse-catalog-signing-v1",) <>
        binary_part(bytes, 1, byte_size(bytes) - 1)

    assert {:error, :invalid_catalog_package} = CatalogSigningPackage.decode(duplicate)

    assert {:error, :invalid_catalog_package} =
             CatalogSigningPackage.decode(:binary.copy(" ", 64 * 1024 * 1024 + 1))
  end

  test "custodian initializes before signing and replays exact durable bytes without reading the key",
       f do
    {:ok, bytes} = encode(f)
    dir = f.fixture[:ceremony_dir]
    {:ok, package} = CatalogSigningPackage.review(bytes, dir)

    assert {:error, :catalog_confirmation_mismatch} =
             SignCatalog.sign(bytes, dir, "/absent", "wrong")

    refute File.exists?(Path.join(dir, "catalog-signing"))
    assert {:error, :catalog_ledger_uninitialized} = SignCatalog.status(bytes, dir)
    assert {:ok, genesis} = SignCatalog.init(bytes, dir)
    assert genesis.head["revision"] == nil
    signer = CeremonyFixture.signer_template().signer
    assert {:ok, envelope} = SignCatalog.sign(bytes, dir, signer, package.digest)

    assert :ok =
             Treehouse.TransportCatalog.verify_catalog_json(
               envelope,
               package.binding.record.catalog_key
             )

    assert {:ok, ^envelope} = SignCatalog.sign(bytes, dir, "/absent", package.digest)
    assert {:ok, status} = SignCatalog.status(bytes, dir)
    assert status.head["revision"] == 0
    assert length(status.chain) == 1
    assert {:ok, _} = SignCatalog.init(bytes, dir)
  end

  test "a competing valid catalog cannot reuse a signed revision", f do
    {:ok, bytes} = encode(f)
    dir = f.fixture[:ceremony_dir]
    {:ok, package} = CatalogSigningPackage.review(bytes, dir)
    {:ok, _} = SignCatalog.init(bytes, dir)

    assert {:ok, _} =
             SignCatalog.sign(
               bytes,
               dir,
               CeremonyFixture.signer_template().signer,
               package.digest
             )

    changed = %{
      f.catalog
      | entries:
          Enum.map(f.catalog.entries, fn e ->
            if e.kind == :thread,
              do: %{
                e
                | route:
                    "/r/" <>
                      Base.url_encode64(:crypto.hash(:sha256, "different-route"), padding: false)
              },
              else: e
          end)
    }

    {:ok, other} = encode(%{f | catalog: changed})

    assert {:error, :catalog_ledger_fork} =
             SignCatalog.sign(other, dir, "/absent", CatalogSigningPackage.digest(changed))
  end

  test "a pending immutable envelope completes its interrupted first head without a seed", f do
    {:ok, bytes} = encode(f)
    dir = f.fixture[:ceremony_dir]
    {:ok, package} = CatalogSigningPackage.review(bytes, dir)
    {:ok, genesis} = SignCatalog.init(bytes, dir)

    {:ok, envelope} =
      SignCatalog.sign(bytes, dir, CeremonyFixture.signer_template().signer, package.digest)

    # Recreate the durable boundary: envelope published, head still genesis.
    head = Path.join([dir, "catalog-signing", "head.json"])
    File.write!(head, genesis.head_bytes)
    assert {:ok, state} = SigningLedger.status(dir, package.binding)
    assert state.pending.bytes == envelope
    assert {:ok, ^envelope} = SignCatalog.sign(bytes, dir, "/absent", package.digest)
    File.rm!(head)
    assert {:error, :catalog_ledger_corrupt} = SignCatalog.status(bytes, dir)
  end

  test "a concurrent lock holder prevents a second signer from entering", f do
    {:ok, bytes} = encode(f)
    dir = f.fixture[:ceremony_dir]
    {:ok, package} = CatalogSigningPackage.review(bytes, dir)
    {:ok, _} = SignCatalog.init(bytes, dir)
    parent = self()

    task =
      Task.async(fn ->
        SigningLedger.transact(dir, package.binding, "open", fn state ->
          send(parent, :holding_ledger)

          receive do
            :release_ledger -> :ok
          end

          {:ok, state.head_bytes, nil, :released}
        end)
      end)

    assert_receive :holding_ledger, 5000
    assert {:error, :catalog_ledger_busy} = SignCatalog.status(bytes, dir)
    send(task.pid, :release_ledger)
    assert {:ok, :released} = Task.await(task)
    assert {:ok, _} = SignCatalog.status(bytes, dir)
  end

  test "owner death after envelope and head sync recovers exact bytes without a seed", f do
    {:ok, bytes} = encode(f)
    dir = f.fixture[:ceremony_dir]
    {:ok, package} = CatalogSigningPackage.review(bytes, dir)
    {:ok, genesis} = SignCatalog.init(bytes, dir)

    {:ok, envelope} =
      SignCatalog.sign(bytes, dir, CeremonyFixture.signer_template().signer, package.digest)

    {:ok, signed} = SignCatalog.status(bytes, dir)
    ledger = Path.join(dir, "catalog-signing")
    envelope_name = Base.encode16(:crypto.hash(:sha256, envelope), case: :lower) <> ".json"
    helper = Path.expand("../../../../scripts/treehouse_catalog_signing_owner.py", __DIR__)
    python = System.find_executable("python3")

    script = ~S"""
    import importlib.util,io,json,os,signal,sys
    sys.dont_write_bytecode=True
    helper,ceremony,stage,plan,command=sys.argv[1:]
    spec=importlib.util.spec_from_file_location("owner",helper)
    owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)
    original=owner.write
    original_link=owner.os.link
    original_replace=owner.os.replace
    def kill_after_link(*args,**kwargs):
        original_link(*args,**kwargs)
        if stage=="link": os.kill(os.getpid(),signal.SIGKILL)
    def kill_after_replace(*args,**kwargs):
        original_replace(*args,**kwargs)
        if stage=="replace": os.kill(os.getpid(),signal.SIGKILL)
    owner.os.link=kill_after_link
    owner.os.replace=kill_after_replace
    def kill_after_write(root,name,data,replace=False):
        original(root,name,data,replace)
        if (stage=="envelope" and name!="head.json") or (stage=="head" and name=="head.json"):
            os.kill(os.getpid(),signal.SIGKILL)
    owner.write=kill_after_write
    sys.argv=[helper,ceremony]
    sys.stdin=io.TextIOWrapper(io.BytesIO((plan+"\n"+command+"\n").encode()))
    owner.main()
    """

    for stage <- ["envelope", "head", "link", "replace"] do
      File.write!(Path.join(ledger, "head.json"), genesis.head_bytes)
      File.rm!(Path.join(ledger, envelope_name))

      plan =
        Jason.encode!(%{
          action: "open",
          binding: package.binding.bootstrap_id,
          key: Base.encode64(package.binding.record.catalog_key)
        })

      command = Jason.encode!(%{head: signed.head_bytes, envelope: envelope})

      {output, status} =
        System.cmd(python, ["-c", script, helper, dir, stage, plan, command],
          stderr_to_stdout: true
        )

      assert status != 0
      refute String.contains?(output, ~s("ok":true))
      assert File.exists?(Path.join(ledger, envelope_name)), output
      assert File.read!(Path.join(ledger, envelope_name)) == envelope
      assert {:ok, ^envelope} = SignCatalog.sign(bytes, dir, "/absent", package.digest)
      assert {:ok, recovered} = SignCatalog.status(bytes, dir)
      assert recovered.head_bytes == signed.head_bytes
      assert length(recovered.chain) == 1
    end
  end

  test "deleted committed envelope or a hard-linked head refuses without repairing custody", f do
    {:ok, bytes} = encode(f)
    dir = f.fixture[:ceremony_dir]
    {:ok, package} = CatalogSigningPackage.review(bytes, dir)
    {:ok, _} = SignCatalog.init(bytes, dir)

    {:ok, envelope} =
      SignCatalog.sign(bytes, dir, CeremonyFixture.signer_template().signer, package.digest)

    head = Path.join([dir, "catalog-signing", "head.json"])
    alias_path = Path.join(dir, "head-alias")
    File.ln!(head, alias_path)
    assert {:error, :unsafe_catalog_ledger} = SignCatalog.status(bytes, dir)
    File.rm!(alias_path)

    stored =
      Path.join([
        dir,
        "catalog-signing",
        Base.encode16(:crypto.hash(:sha256, envelope), case: :lower) <> ".json"
      ])

    File.rm!(stored)
    assert {:error, :catalog_ledger_corrupt} = SignCatalog.status(bytes, dir)
    assert {:error, :catalog_ledger_corrupt} = SignCatalog.init(bytes, dir)
    refute File.exists?(stored)
  end

  test "a wrong seed never advances the initialized signing head", f do
    {:ok, bytes} = encode(f)
    dir = f.fixture[:ceremony_dir]
    {:ok, package} = CatalogSigningPackage.review(bytes, dir)
    {:ok, genesis} = SignCatalog.init(bytes, dir)
    keys = Path.join(Path.dirname(dir), "wrong-keys")
    File.mkdir!(keys)
    File.chmod!(keys, 0o700)
    wrong = Path.join(keys, "wrong-catalog.seed")
    File.write!(wrong, Base.encode16(:crypto.strong_rand_bytes(32), case: :lower))
    File.chmod!(wrong, 0o600)
    assert {:error, :signer_key_mismatch} = SignCatalog.sign(bytes, dir, wrong, package.digest)
    assert {:ok, state} = SignCatalog.status(bytes, dir)
    assert state.head_bytes == genesis.head_bytes
    assert state.chain == []
  end

  test "the ordinary ceremony CLI reviews, initializes, signs and exports verifiable status", f do
    {:ok, bytes} = encode(f)
    dir = f.fixture[:ceremony_dir]
    path = Path.join(dir, "catalog-package.json")
    File.write!(path, bytes)
    base = ["--ceremony", dir, "--package", path]
    cli = LatticeCarrierServer.Operator.CatalogCeremony.Cli

    review =
      ExUnit.CaptureIO.capture_io(fn -> assert :ok = cli.run(["review-catalog" | base]) end)

    sheet = Jason.decode!(review)
    assert sheet["confirm_catalog"] == CatalogSigningPackage.digest(f.catalog)
    assert length(sheet["inventory"]) == 2

    assert Enum.sort(Enum.map(sheet["snapshots"], & &1["frames"])) ==
             Enum.sort(Enum.map(f.histories, fn {_, log} -> map_size(log.ops) end))

    genesis_path = Path.join(dir, "genesis-status.json")

    ExUnit.CaptureIO.capture_io(fn ->
      assert :ok =
               cli.run([
                 "init-ledger",
                 "--out",
                 genesis_path,
                 "--ceremony",
                 dir,
                 "--space-log",
                 f.fixture[:binding].signed
               ])
    end)

    signed_path = Path.join(dir, "signed-catalog.json")

    args =
      [
        "sign-catalog",
        "--signer",
        CeremonyFixture.signer_template().signer,
        "--confirm-catalog",
        sheet["confirm_catalog"],
        "--out",
        signed_path
      ] ++ base

    ExUnit.CaptureIO.capture_io(fn -> assert :ok = cli.run(args) end)
    envelope = File.read!(signed_path)
    {:ok, package} = CatalogSigningPackage.review(bytes, dir)

    assert :ok =
             Treehouse.TransportCatalog.verify_catalog_json(
               envelope,
               package.binding.record.catalog_key
             )

    status_path = Path.join(dir, "signed-status.json")

    ExUnit.CaptureIO.capture_io(fn ->
      assert :ok = cli.run(["catalog-status", "--out", status_path] ++ base)
    end)

    assert {:ok, status} = SigningLedger.verify_status(File.read!(status_path), package.binding)
    assert length(status.chain) == 1
    assert {:ok, genesis} = SigningLedger.verify_status(File.read!(genesis_path), package.binding)
    assert genesis.chain == []

    assert {:error, :catalog_ledger_corrupt} =
             SigningLedger.verify_status(" " <> File.read!(status_path), package.binding)

    File.write!(signed_path, "conflict")

    ExUnit.CaptureIO.capture_io(:stderr, fn ->
      assert {:error, :catalog_output_conflict} = cli.run(args)
    end)

    assert File.read!(signed_path) == "conflict"
  end

  test "a deleted lock cannot be recreated over an existing ledger", f do
    {:ok, bytes} = encode(f)
    dir = f.fixture[:ceremony_dir]
    {:ok, package} = CatalogSigningPackage.review(bytes, dir)
    {:ok, genesis} = SignCatalog.init(bytes, dir)
    parent = self()

    task =
      Task.async(fn ->
        SigningLedger.transact(dir, package.binding, "open", fn state ->
          send(parent, :locked_before_delete)

          receive do
            :continue_after_delete -> :ok
          end

          {:ok, state.head_bytes, nil, :must_not_escape}
        end)
      end)

    assert_receive :locked_before_delete, 5000
    lock = Path.join([dir, "catalog-signing", "lock"])
    File.rm!(lock)
    assert {:error, :catalog_ledger_corrupt} = SignCatalog.init(bytes, dir)
    refute File.exists?(lock)
    send(task.pid, :continue_after_delete)
    assert {:error, _} = Task.await(task)
    assert File.read!(Path.join([dir, "catalog-signing", "head.json"])) == genesis.head_bytes
  end

  test "BEAM caller death releases the helper without committing a callback result", f do
    {:ok, bytes} = encode(f)
    dir = f.fixture[:ceremony_dir]
    {:ok, package} = CatalogSigningPackage.review(bytes, dir)
    {:ok, genesis} = SignCatalog.init(bytes, dir)
    parent = self()

    {pid, monitor} =
      spawn_monitor(fn ->
        result =
          SigningLedger.transact(dir, package.binding, "open", fn _state ->
            send(parent, :callback_holding)

            receive do
              :never_sent -> :ok
            end
          end)

        send(parent, {:unexpected_callback_result, result})
      end)

    assert_receive :callback_holding, 5000
    Process.exit(pid, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^pid, :killed}, 5000
    state = await_unlocked(fn -> SigningLedger.status(dir, package.binding) end, 100)
    assert state.head_bytes == genesis.head_bytes
    assert state.chain == []
    refute_receive {:unexpected_callback_result, _}
  end

  defp await_unlocked(fun, retries) do
    case fun.() do
      {:ok, state} ->
        state

      {:error, :catalog_ledger_busy} when retries > 0 ->
        Process.sleep(20)
        await_unlocked(fun, retries - 1)

      other ->
        flunk("ledger did not release after caller death: #{inspect(other)}")
    end
  end

  defp encode(f),
    do:
      CatalogSigningPackage.encode(
        f.catalog,
        f.histories,
        f.fixture[:reference],
        "initial_existing"
      )
end
