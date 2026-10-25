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
      assert File.stat!(Path.join(ledger, envelope_name)).links == 1
      refute Enum.any?(File.ls!(ledger), &String.starts_with?(&1, ".tmp-"))
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

  test "a revision beyond the bounded inventory refuses before ledger or seed access", f do
    space = f.histories[f.catalog.space]
    reference = f.fixture[:reference]
    pending = Lattice.Log.from_ops(space.replica, Map.delete(space.ops, reference.id))
    histories = Map.put(f.histories, space.replica, pending)
    catalog = %{f.catalog | revision: 12, previous: f.catalog.bootstrap}
    assert {:ok, bytes} = CatalogSigningPackage.encode(catalog, histories, reference, "pending")

    assert {:error, :catalog_ledger_capacity} =
             SignCatalog.sign(
               bytes,
               f.fixture[:ceremony_dir],
               "/absent",
               CatalogSigningPackage.digest(catalog)
             )

    refute File.exists?(Path.join(f.fixture[:ceremony_dir], "catalog-signing"))
  end

  test "initialization kills before and after the genesis link remain retryable", f do
    {:ok, bytes} = encode(f)
    dir = f.fixture[:ceremony_dir]
    {:ok, package} = CatalogSigningPackage.review(bytes, dir)

    for scenario <- ["init_before_link", "init_after_link"] do
      # Each crash gets a new public ceremony copy and a new ledger, all disposable.
      fresh = Path.join(Path.dirname(dir), scenario)
      File.cp_r!(dir, fresh)
      File.chmod!(fresh, 0o700)

      plan = %{
        action: "init",
        binding: package.binding.bootstrap_id,
        key: Base.encode64(package.binding.record.catalog_key)
      }

      {output, status} = owner_fault(fresh, scenario, plan, %{})
      assert status != 0
      refute String.contains?(output, ~s("ok":true))
      assert {:ok, state} = SignCatalog.init(bytes, fresh)
      assert state.chain == []
      assert state.head["revision"] == nil
      assert Enum.sort(File.ls!(Path.join(fresh, "catalog-signing"))) == ["head.json", "lock"]
    end
  end

  test "callback expiry refuses, but disarmed writes may finish after that deadline", f do
    {bytes, package, genesis, signed, envelope} = signing_boundary!(f)
    dir = f.fixture[:ceremony_dir]

    plan = %{
      action: "open",
      binding: package.binding.bootstrap_id,
      key: Base.encode64(package.binding.record.catalog_key)
    }

    command = %{head: signed.head_bytes, envelope: envelope}
    reset_boundary!(dir, genesis, envelope)
    {output, status} = owner_fault(dir, "alarm", plan, command)
    assert status != 0
    assert String.contains?(output, "catalog_ledger_timeout")
    assert {:ok, unchanged} = SignCatalog.status(bytes, dir)
    assert unchanged.head_bytes == genesis.head_bytes
    assert unchanged.chain == []
    {output, 0} = owner_fault(dir, "delayed_write", plan, command)
    assert String.contains?(output, ~s("ok":true))
    assert {:ok, after_write} = SignCatalog.status(bytes, dir)
    assert after_write.head_bytes == signed.head_bytes
  end

  test "output loss during writes does not imply that a signature was not persisted", f do
    {bytes, package, genesis, signed, envelope} = signing_boundary!(f)
    dir = f.fixture[:ceremony_dir]
    reset_boundary!(dir, genesis, envelope)

    plan = %{
      action: "open",
      binding: package.binding.bootstrap_id,
      key: Base.encode64(package.binding.record.catalog_key)
    }

    {output, status} =
      owner_fault(dir, "stdout_loss", plan, %{head: signed.head_bytes, envelope: envelope})

    assert status != 0
    refute String.contains?(output, ~s("ok":true))
    assert {:ok, after_loss} = SignCatalog.status(bytes, dir)
    assert after_loss.head_bytes == signed.head_bytes
    assert {:ok, ^envelope} = SignCatalog.sign(bytes, dir, "/absent", package.digest)
  end

  test "envelope directory sync precedes head replacement and Darwin requests full flushes", f do
    {bytes, package, genesis, signed, envelope} = signing_boundary!(f)
    dir = f.fixture[:ceremony_dir]

    plan = %{
      action: "open",
      binding: package.binding.bootstrap_id,
      key: Base.encode64(package.binding.record.catalog_key)
    }

    for scenario <- ["ordering", "darwin_dispatch"] do
      reset_boundary!(dir, genesis, envelope)

      {output, 0} =
        owner_fault(dir, scenario, plan, %{head: signed.head_bytes, envelope: envelope})

      events =
        output
        |> String.split("\n")
        |> Enum.find(&String.starts_with?(&1, "TEST_EVENTS="))
        |> String.replace_prefix("TEST_EVENTS=", "")
        |> Jason.decode!()

      linked =
        Enum.find_index(events, fn [kind, name] -> kind == "link" and name != "head.json" end)

      replaced = Enum.find_index(events, &(&1 == ["replace", "head.json"]))
      assert is_integer(linked) and is_integer(replaced) and linked < replaced

      assert events
             |> Enum.slice((linked + 1)..(replaced - 1))
             |> Enum.any?(fn [kind, _] -> kind == "directory_done" end)

      if scenario == "darwin_dispatch" do
        assert ["fullfsync", "file"] in events
        assert ["fullfsync", "dir"] in events
      end

      assert {:ok, ^envelope} = SignCatalog.sign(bytes, dir, "/absent", package.digest)
    end
  end

  test "simultaneous identical signing converges on one immutable envelope", f do
    {:ok, bytes} = encode(f)
    dir = f.fixture[:ceremony_dir]
    {:ok, package} = CatalogSigningPackage.review(bytes, dir)
    {:ok, _} = SignCatalog.init(bytes, dir)
    signer = CeremonyFixture.signer_template().signer
    results = simultaneous(fn _ -> SignCatalog.sign(bytes, dir, signer, package.digest) end)
    envelopes = for {:ok, envelope} <- results, do: envelope
    assert length(envelopes) >= 1
    assert length(Enum.uniq(envelopes)) == 1
    assert Enum.all?(results, &(match?({:ok, _}, &1) or &1 == {:error, :catalog_ledger_busy}))
    [envelope | _] = envelopes
    assert {:ok, ^envelope} = SignCatalog.sign(bytes, dir, "/absent", package.digest)
    assert {:ok, state} = SignCatalog.status(bytes, dir)
    assert length(state.chain) == 1
  end

  test "simultaneous competing catalogs have exactly one signed winner", f do
    {:ok, bytes} = encode(f)
    dir = f.fixture[:ceremony_dir]
    {:ok, package} = CatalogSigningPackage.review(bytes, dir)
    {:ok, _} = SignCatalog.init(bytes, dir)

    changed = %{
      f.catalog
      | entries:
          Enum.map(f.catalog.entries, fn entry ->
            if entry.kind == :thread,
              do: %{
                entry
                | route:
                    "/r/" <>
                      Base.url_encode64(:crypto.hash(:sha256, "racing-route"), padding: false)
              },
              else: entry
          end)
    }

    {:ok, other} = encode(%{f | catalog: changed})
    candidates = [{bytes, package.digest}, {other, CatalogSigningPackage.digest(changed)}]
    signer = CeremonyFixture.signer_template().signer

    results =
      simultaneous(fn index ->
        {candidate, digest} = Enum.at(candidates, index)
        SignCatalog.sign(candidate, dir, signer, digest)
      end)

    assert Enum.count(results, &match?({:ok, _}, &1)) == 1

    assert Enum.any?(
             results,
             &(&1 in [{:error, :catalog_ledger_busy}, {:error, :catalog_ledger_fork}])
           )

    assert {:ok, state} = SignCatalog.status(bytes, dir)
    assert length(state.chain) == 1

    for {candidate, digest} <- candidates do
      case CatalogSigningPackage.review(candidate, dir) do
        {:ok, %{catalog: catalog}} ->
          if catalog == hd(state.chain).catalog do
            assert {:ok, _} = SignCatalog.sign(candidate, dir, "/absent", digest)
          else
            assert {:error, :catalog_ledger_fork} =
                     SignCatalog.sign(candidate, dir, "/absent", digest)
          end
      end
    end
  end

  defp simultaneous(fun) do
    tasks =
      for index <- 0..1,
          do:
            Task.async(fn ->
              receive do
                :sign_now -> fun.(index)
              end
            end)

    Enum.each(tasks, &send(&1.pid, :sign_now))
    Enum.map(tasks, &Task.await(&1, 10_000))
  end

  test "helper death before ACK cannot release the BEAM callback value", f do
    {:ok, bytes} = encode(f)
    dir = f.fixture[:ceremony_dir]
    {:ok, package} = CatalogSigningPackage.review(bytes, dir)
    {:ok, genesis} = SignCatalog.init(bytes, dir)
    parent = self()

    task =
      Task.async(fn ->
        SigningLedger.transact(dir, package.binding, "open", fn state ->
          send(parent, :waiting_for_helper_ack)

          receive do
            :finish_callback -> :ok
          end

          {:ok, state.head_bytes, nil, :must_not_escape_without_ack}
        end)
      end)

    assert_receive :waiting_for_helper_ack, 5000
    {:links, links} = Process.info(task.pid, :links)
    [port] = Enum.filter(links, &is_port/1)
    assert Port.info(port, :connected) == {:connected, task.pid}
    {:os_pid, pid} = Port.info(port, :os_pid)
    assert is_integer(pid) and pid > 0
    {_, 0} = System.cmd("kill", ["-KILL", Integer.to_string(pid)])
    send(task.pid, :finish_callback)
    assert {:error, _} = Task.await(task, 10_000)
    assert {:ok, state} = SignCatalog.status(bytes, dir)
    assert state.head_bytes == genesis.head_bytes
    assert state.chain == []
  end

  defp signing_boundary!(f) do
    {:ok, bytes} = encode(f)
    dir = f.fixture[:ceremony_dir]
    {:ok, package} = CatalogSigningPackage.review(bytes, dir)
    {:ok, genesis} = SignCatalog.init(bytes, dir)

    {:ok, envelope} =
      SignCatalog.sign(bytes, dir, CeremonyFixture.signer_template().signer, package.digest)

    {:ok, signed} = SignCatalog.status(bytes, dir)
    {bytes, package, genesis, signed, envelope}
  end

  defp reset_boundary!(dir, genesis, envelope) do
    ledger = Path.join(dir, "catalog-signing")
    File.write!(Path.join(ledger, "head.json"), genesis.head_bytes)

    File.rm!(
      Path.join(ledger, Base.encode16(:crypto.hash(:sha256, envelope), case: :lower) <> ".json")
    )
  end

  defp owner_fault(dir, scenario, plan, command) do
    helper = Path.expand("../../../../scripts/treehouse_catalog_signing_owner.py", __DIR__)
    runner = Path.expand("../support/operator/signing_fault_runner.py", __DIR__)

    System.cmd(
      System.find_executable("python3"),
      [runner, helper, dir, scenario, Jason.encode!(plan), Jason.encode!(command)],
      stderr_to_stdout: true
    )
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
