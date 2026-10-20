defmodule LatticeCarrierServer.Operator.CatalogBindingTest do
  use ExUnit.Case, async: false

  alias Lattice.{Canonical, Log, Op}
  alias LatticeCarrierServer.Operator.CatalogBinding
  alias LatticeCarrierServer.Operator.CatalogCeremony.{Binding, DryRun, Store}
  alias LatticeCarrierServer.Operator.CeremonyFixture, as: Fixture

  @files ~w(binding-payload.json binding-review.txt binding.json signer.json verification-report.json)

  # One real ceremony is built once; each test works on a private copy of its directory.
  setup_all do
    base = Path.join(System.tmp_dir!(), "catalog-binding-#{System.unique_integer([:positive])}")
    fixture = Fixture.build(base)
    on_exit(fn -> File.rm_rf(base) end)
    {:ok, fixture: fixture}
  end

  setup %{fixture: fx} do
    dir = Path.join(fx.base, "copy-#{System.unique_integer([:positive])}")
    File.cp_r!(fx.ceremony, dir)
    File.chmod!(dir, 0o700)
    {:ok, dir: dir, fx: fx, log: fx.signed}
  end

  defp edit_json!(dir, name, fun) do
    path = Path.join(dir, name)

    File.write!(
      path,
      path |> File.read!() |> Jason.decode!() |> fun.() |> Jason.encode!(pretty: true)
    )
  end

  defp edit_text!(dir, name, fun) do
    path = Path.join(dir, name)
    File.write!(path, path |> File.read!() |> fun.())
  end

  defp restore!(path) do
    {:ok, %{log: log}} = Log.restore_verified(path)
    log
  end

  test "a finished ceremony and its served log load", %{dir: dir, fx: fx, log: log} do
    assert {:ok, loaded} = CatalogBinding.load(dir, log)
    assert loaded.bootstrap_id == fx.op.id
    assert loaded.record == fx.record
    assert loaded.realm == "treehouse-service:" <> fx.record.service_id

    assert loaded.attested == %{
             custody: %{
               "custodian" => "Ada",
               "passphrase_holder" => "Grace",
               "rotation_owner" => "Linus"
             },
             separate_host: true,
             backup_sha256: fx.backup |> File.read!() |> Store.sha256(),
             origin: Fixture.origin()
           }
  end

  test "a missing or unsafe ceremony directory is refused", %{dir: dir, log: log} do
    assert {:error, :ceremony_required} = CatalogBinding.load(nil, log)
    assert {:error, :ceremony_required} = CatalogBinding.load("", log)
    assert {:error, :ceremony_directory_invalid} = CatalogBinding.load(dir <> "-absent", log)

    File.chmod!(dir, 0o750)
    assert {:error, :ceremony_directory_invalid} = CatalogBinding.load(dir, log)
  end

  test "a dry-run marker is refused", %{dir: dir, log: log} do
    File.write!(Path.join(dir, Store.marker()), "x")
    assert {:error, :dry_run_ceremony_dir} = CatalogBinding.load(dir, log)
  end

  test "each missing artifact is named", %{dir: dir, log: log} do
    for name <- @files do
      path = Path.join(dir, name)
      saved = File.read!(path)
      File.rm!(path)
      assert {:error, :ceremony_artifact_missing} = CatalogBinding.load(dir, log), name
      File.write!(path, saved)
    end

    assert {:ok, _} = CatalogBinding.load(dir, log)
  end

  describe "malformed artifacts" do
    test "an oversized file", %{dir: dir, log: log} do
      path = Path.join(dir, "binding-payload.json")
      File.write!(path, File.read!(path) <> String.duplicate(" ", Store.max_artifact_bytes() + 1))
      assert {:error, :ceremony_artifact_malformed} = CatalogBinding.load(dir, log)
    end

    test "an oversized review sheet", %{dir: dir, log: log} do
      path = Path.join(dir, "binding-review.txt")
      File.write!(path, File.read!(path) <> String.duplicate("x", 17 * 1024))
      assert {:error, :ceremony_artifact_malformed} = CatalogBinding.load(dir, log)
    end

    test "a repeated JSON key, even nested", %{dir: dir, log: log} do
      edit_text!(dir, "binding.json", &String.replace_prefix(&1, "{", ~s({"format":"dup",)))
      assert {:error, :ceremony_artifact_malformed} = CatalogBinding.load(dir, log)
    end

    test "a repeated key nested in the payload record", %{dir: dir, log: log} do
      edit_text!(
        dir,
        "binding-payload.json",
        &String.replace(&1, ~s("version": 1), ~s("version": 1, "version": 1))
      )

      assert {:error, :ceremony_artifact_malformed} = CatalogBinding.load(dir, log)
    end

    test "an extra key in the report", %{dir: dir, log: log} do
      edit_json!(dir, "verification-report.json", &Map.put(&1, "extra", "x"))
      assert {:error, :ceremony_artifact_malformed} = CatalogBinding.load(dir, log)
    end

    test "an extra nested key in the report", %{dir: dir, log: log} do
      edit_json!(dir, "verification-report.json", &put_in(&1, ["custody", "extra"], "x"))
      assert {:error, :ceremony_artifact_malformed} = CatalogBinding.load(dir, log)
    end

    test "a wrongly typed report value", %{dir: dir, log: log} do
      edit_json!(
        dir,
        "verification-report.json",
        &put_in(&1, ["restore", "separate_host"], "yes")
      )

      assert {:error, :ceremony_artifact_malformed} = CatalogBinding.load(dir, log)
    end

    test "a review sheet that differs from the payload by one field line", %{dir: dir, log: log} do
      edit_text!(
        dir,
        "binding-review.txt",
        &String.replace(&1, "relay.example.test", "relay.example.evil")
      )

      assert {:error, :ceremony_artifact_malformed} = CatalogBinding.load(dir, log)
    end

    test "a binding.json with an extra key", %{dir: dir, log: log} do
      edit_json!(dir, "binding.json", &Map.put(&1, "extra", "x"))
      assert {:error, :ceremony_artifact_malformed} = CatalogBinding.load(dir, log)
    end

    test "a symlinked artifact", %{dir: dir, log: log, fx: fx} do
      target = Path.join(fx.base, "elsewhere-#{System.unique_integer([:positive])}.json")
      path = Path.join(dir, "binding.json")
      File.cp!(path, target)
      File.rm!(path)
      File.ln_s!(target, path)
      assert {:error, :ceremony_artifact_malformed} = CatalogBinding.load(dir, log)
    end

    test "a second hard link", %{dir: dir, log: log, fx: fx} do
      File.ln!(
        Path.join(dir, "binding.json"),
        Path.join(fx.base, "link-#{System.unique_integer([:positive])}")
      )

      assert {:error, :ceremony_artifact_malformed} = CatalogBinding.load(dir, log)
    end
  end

  test "disposable dry-run keys are refused under a real label", %{fx: fx, log: log} do
    dry = Path.join(fx.base, "dry-#{System.unique_integer([:positive])}")
    assert {:ok, _} = DryRun.run(ceremony: dry)
    File.rm!(Path.join(dry, Store.marker()))
    edit_json!(dry, "signer.json", &Map.put(&1, "mode", "real"))
    assert {:error, :disposable_test_key} = CatalogBinding.load(dry, log)
  end

  test "the served log is required and must verify", %{dir: dir, fx: fx} do
    assert {:error, :space_log_required} = CatalogBinding.load(dir, nil)
    assert {:error, :space_log_required} = CatalogBinding.load(dir, "")

    garbage = Path.join(fx.space_dir, "garbage.log")
    File.write!(garbage, "not a log")
    assert {:error, :invalid_space_log} = CatalogBinding.load(dir, garbage)
    assert {:error, :invalid_space_log} = CatalogBinding.load(dir, garbage <> ".absent")
  end

  test "another Space's log is a changed profile", %{dir: dir, fx: fx} do
    other = Fixture.space(fx.space_dir, "other-space")
    assert {:error, :binding_profile_changed} = CatalogBinding.load(dir, other.pre)
  end

  test "the bootstrap must be in the served log", %{dir: dir, fx: fx} do
    assert {:error, :binding_not_in_served_log} = CatalogBinding.load(dir, fx.space.pre)

    {different, _} =
      Fixture.sign_bootstraps(
        fx.space,
        [%{fx.record | nonce: Fixture.id("other-nonce")}],
        "different"
      )

    assert {:error, :binding_not_in_served_log} = CatalogBinding.load(dir, different)
  end

  test "two honored bootstraps with equal records are a fork", %{dir: dir, fx: fx} do
    second =
      Op.new(
        fx.space.root,
        fx.space.replica,
        [fx.op.id],
        :command,
        {:catalog_bootstrap_v1, [fx.record]},
        cap: fx.space.delegation.id
      )

    forked = Log.append!(restore!(fx.signed), second)
    path = Path.join(fx.space_dir, "fork.log")
    :ok = Log.dump(forked, path)
    assert {:error, :binding_fork} = CatalogBinding.load(dir, path)
  end

  describe "inconsistent artifacts" do
    test "binding.json names another bootstrap id", %{dir: dir, log: log} do
      edit_json!(dir, "binding.json", &Map.put(&1, "bootstrap_id", Fixture.id("elsewhere")))
      assert {:error, :ceremony_inconsistent} = CatalogBinding.load(dir, log)
    end

    test "signer.json holds a different key than the payload", %{dir: dir, log: log} do
      pub = Fixture.random_pub()

      edit_json!(dir, "signer.json", fn signer ->
        Map.merge(signer, Store.public_info(pub))
      end)

      assert {:error, :ceremony_inconsistent} = CatalogBinding.load(dir, log)
    end
  end

  test "a service key equal to the Space root is refused", %{dir: dir, fx: fx} do
    record = %{fx.record | service_key: fx.record.space_root}
    canonical = Canonical.term(record)
    sha = Store.sha256(canonical)

    edit_json!(dir, "binding-payload.json", fn payload ->
      %{
        payload
        | "record" => Binding.to_json(record),
          "canonical_base64" => Base.encode64(canonical),
          "sha256" => sha
      }
    end)

    old_service = Base.encode64(fx.record.service_key)
    old_sha = fx.payload["sha256"]

    edit_text!(dir, "binding-review.txt", fn text ->
      text
      |> String.replace(old_service, Base.encode64(record.service_key))
      |> String.replace(old_sha, sha)
    end)

    {signed, [op]} = Fixture.sign_bootstraps(fx.space, [record], "reuse")

    edit_json!(dir, "binding.json", fn binding ->
      %{binding | "bootstrap_id" => op.id, "record_sha256" => sha}
    end)

    assert {:error, :binding_key_reuse} = CatalogBinding.load(dir, signed)
  end

  describe "the report is only cross-checked" do
    test "an edited report is a mismatch", %{dir: dir, log: log} do
      edits = [
        &put_in(&1, ["binding", "bootstrap_id"], Fixture.id("report-id")),
        &put_in(&1, ["binding", "record_sha256"], String.duplicate("0", 64)),
        &put_in(&1, ["binding", "space"], "replica:other"),
        &put_in(&1, ["signer", "public_key_base64"], Base.encode64(Fixture.random_pub())),
        &put_in(&1, ["signer", "fingerprint_sha256"], String.duplicate("1", 64)),
        &Map.put(&1, "mode", "dry_run"),
        &put_in(&1, ["binding", "status"], "pending_root_signature")
      ]

      path = Path.join(dir, "verification-report.json")
      saved = File.read!(path)

      for edit <- edits do
        edit_json!(dir, "verification-report.json", edit)
        assert {:error, :catalog_report_mismatch} = CatalogBinding.load(dir, log)
        File.write!(path, saved)
      end

      assert {:ok, _} = CatalogBinding.load(dir, log)
    end

    test "attested custody text is carried, not verified", %{dir: dir, log: log} do
      edit_json!(dir, "verification-report.json", fn report ->
        report
        |> put_in(["custody", "custodian"], "Mallory")
        |> put_in(["restore", "separate_host"], false)
      end)

      assert {:ok, %{attested: attested}} = CatalogBinding.load(dir, log)
      assert attested.custody["custodian"] == "Mallory"
      assert attested.separate_host == false
    end
  end

  test "any raise becomes an atom", %{dir: dir, log: log} do
    for bad <- [123, :atom, <<0>>, [1, 2], %{}] do
      assert {:error, reason} = CatalogBinding.load(bad, log)
      assert is_atom(reason)
    end

    for bad <- [123, :atom, <<0, 1>>, %{}] do
      assert {:error, reason} = CatalogBinding.load(dir, bad)
      assert is_atom(reason)
    end

    assert {:error, :space_log_required} = CatalogBinding.load(dir, 123)
  end

  test "the ceremony stays read-only", %{dir: dir, log: log} do
    snapshot = fn ->
      for name <- File.ls!(dir), into: %{}, do: {name, File.read!(Path.join(dir, name))}
    end

    before = snapshot.()
    assert {:ok, _} = CatalogBinding.load(dir, log)
    assert snapshot.() == before
  end
end
