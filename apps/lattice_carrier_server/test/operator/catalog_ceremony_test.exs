defmodule LatticeCarrierServer.Operator.CatalogCeremonyTest do
  use ExUnit.Case, async: false

  import Bitwise
  import ExUnit.CaptureIO

  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Authority.{ContinuationCertificate, Delegation}
  alias LatticeCarrierServer.Manifest
  alias LatticeCarrierServer.Operator.CatalogCeremony, as: Ceremony

  alias LatticeCarrierServer.Operator.CatalogCeremony.{
    Backup,
    Binding,
    Cli,
    DryRun,
    Passphrase,
    Paths,
    Store
  }

  @passphrase "correct horse battery staple 42"
  @origin "wss://relay.example.test"
  @dry_label "lattice-catalog-ceremony-dry-run-NOT-A-REAL-KEY"

  setup do
    base = Path.join(System.tmp_dir!(), "catalog-ceremony-#{System.unique_integer([:positive])}")

    dirs =
      for name <- ~w(ceremony keys backups restore space), into: %{} do
        dir = Path.join(base, name)
        File.mkdir_p!(dir)
        File.chmod!(dir, 0o700)
        {String.to_atom(name), dir}
      end

    File.chmod!(base, 0o700)
    on_exit(fn -> File.rm_rf(base) end)

    {:ok,
     Map.merge(dirs, %{
       base: base,
       signer: Path.join(dirs.keys, "signer.seed"),
       backup: Path.join(dirs.backups, "signer.backup"),
       restored: Path.join(dirs.restore, "signer.seed")
     })}
  end

  # ---------------------------------------------------------------- helpers

  defp reader(lines) do
    {:ok, agent} = Agent.start_link(fn -> lines end)

    fn ->
      Agent.get_and_update(agent, fn
        [line | rest] -> {{:ok, line}, rest}
        [] -> {:error, []}
      end)
    end
  end

  defp passphrase_reader(count \\ 2), do: reader(List.duplicate(@passphrase, count))

  defp seed_hex(path), do: path |> File.read!() |> String.trim()

  defp random_pub, do: elem(:crypto.generate_key(:eddsa, :ed25519), 0)

  defp id(label),
    do: :crypto.hash(:sha256, "ceremony-test-" <> label) |> Base.url_encode64(padding: false)

  # A disposable bounded Space with RANDOM keys; the test, never the tool, signs.
  defp space(f, name \\ "pre", extra_ops \\ []) do
    root = Identity.generate("root")
    nominee = Identity.generate("nominee")
    witnesses = for n <- 1..3, do: Identity.generate("w#{n}")

    replica =
      Authority.bind_replica(
        "replica:treehouse:space:" <>
          id("space-#{System.unique_integer()}") <>
          "#authority:bounded-continuation-v1",
        root.pub
      )

    delegation =
      Delegation.genesis(root, replica,
        ops:
          [:create_space, :create_thread, :catalog_bootstrap_v1, :replace_catalog_v1] ++ extra_ops,
        roles: [:admin, :moderator]
      )

    genesis = Op.new(root, replica, [], :authority, {:genesis, delegation, %{}})

    creation =
      Op.new(root, replica, [genesis.id], :command, {:create_space, ["Canopy"]},
        cap: delegation.id
      )

    profile = %{
      mode: :bounded_continuation,
      version: 1,
      product: :treehouse,
      kind: :space,
      role: :admin,
      nominee: nominee.pub,
      witnesses: Enum.sort(Enum.map(witnesses, & &1.pub)),
      threshold: 2,
      max_lease_epochs: 7
    }

    empty = Delegation.genesis(root, replica, ops: [], roles: [], live: false)

    pin =
      Op.new(
        root,
        replica,
        [creation.id],
        :authority,
        {:genesis, empty, %{__continuation__: profile}}
      )

    {:ok, _} = ContinuationCertificate.profile_id(profile)
    before = Enum.reduce([genesis, creation, pin], Log.new(replica), &Log.append!(&2, &1))
    path = Path.join(f.space, name <> ".log")
    :ok = Log.dump(before, path)
    %{root: root, replica: replica, delegation: delegation, pin: pin, before: before, pre: path}
  end

  defp legacy_space(f) do
    root = Identity.generate("root")
    replica = Authority.bind_replica("replica:treehouse:space:" <> id("legacy"), root.pub)
    delegation = Delegation.genesis(root, replica, ops: [:create_space], roles: [:admin])
    genesis = Op.new(root, replica, [], :authority, {:genesis, delegation, %{}})

    creation =
      Op.new(root, replica, [genesis.id], :command, {:create_space, ["Legacy"]},
        cap: delegation.id
      )

    log = Enum.reduce([genesis, creation], Log.new(replica), &Log.append!(&2, &1))
    path = Path.join(f.space, "legacy.log")
    :ok = Log.dump(log, path)
    path
  end

  defp sign_bootstraps(space, records, name) do
    ops =
      for record <- records do
        Op.new(
          space.root,
          space.replica,
          [space.pin.id],
          :command,
          {:catalog_bootstrap_v1, [record]},
          cap: space.delegation.id
        )
      end

    log = Enum.reduce(ops, space.before, &Log.append!(&2, &1))
    path = Path.join(Path.dirname(space.pre), name <> ".log")
    :ok = Log.dump(log, path)
    {path, ops}
  end

  defp service_b64, do: Base.encode64(random_pub())

  defp generate!(f) do
    assert {:ok, public} = Ceremony.generate(signer: f.signer, ceremony: f.ceremony)
    public
  end

  defp backup!(f) do
    assert {:ok, _} =
             Ceremony.backup(
               signer: f.signer,
               ceremony: f.ceremony,
               out: f.backup,
               passphrase_reader: passphrase_reader()
             )
  end

  defp verify_backup!(f, extra \\ []) do
    Ceremony.verify_backup(
      Keyword.merge(
        [backup: f.backup, ceremony: f.ceremony, passphrase_reader: passphrase_reader(1)],
        extra
      )
    )
  end

  defp payload!(f, space, extra \\ []) do
    assert {:ok, payload} =
             Ceremony.binding_payload(
               [
                 ceremony: f.ceremony,
                 space_log: space.pre,
                 service_public_key: service_b64(),
                 origin: @origin
               ] ++ extra
             )

    {:ok, record} = Binding.from_json(payload["record"])
    {payload, record}
  end

  defp cli(argv, lines \\ []) do
    {:ok, out} = Agent.start_link(fn -> {nil, ""} end)

    stderr =
      capture_io(:stderr, fn ->
        stdout =
          capture_io(fn ->
            result = Cli.run(argv, passphrase_reader: reader(lines))
            Agent.update(out, fn {_, text} -> {result, text} end)
          end)

        Agent.update(out, fn {result, _} -> {result, stdout} end)
      end)

    {result, stdout} = Agent.get(out, & &1)
    {result, stdout, stderr}
  end

  defp ceremony_files(dir) do
    dir |> Path.join("**") |> Path.wildcard(match_dot: true) |> Enum.filter(&File.regular?/1)
  end

  # ------------------------------------------------------------ full flows

  test "the dry run writes every artifact and verifies a disposable binding", f do
    dir = Path.join(f.base, "dry")
    assert {:ok, summary} = Ceremony.dry_run(ceremony: dir)

    for name <-
          ~w(DRY-RUN-NOT-REAL signer.json backup.json restore.json binding-payload.json
             binding-review.txt binding.json verification-report.json
             disposable-space-pre.log disposable-space.log) do
      assert File.regular?(Path.join(dir, name)), name
    end

    report = dir |> Path.join("verification-report.json") |> File.read!() |> Jason.decode!()
    assert report["mode"] == "dry_run"
    assert report["format"] == "lattice-catalog-ceremony-report-v1"
    assert report["binding"]["status"] == "verified"
    assert report["binding"]["bootstrap_id"] == summary.bootstrap_id
    assert report["backup"]["kdf_iterations"] == 600_000
    assert %{"ok" => true} = dir |> Path.join("restore.json") |> File.read!() |> Jason.decode!()
    assert report["claim"] =~ "not catalog publication"
    assert report["restore"]["separate_host"] == false
    assert (File.stat!(dir).mode &&& 0o777) == 0o700
  end

  test "a dry run needs a new or empty directory", f do
    File.write!(Path.join(f.ceremony, "stray"), "x")
    assert {:error, :ceremony_not_empty} = Ceremony.dry_run(ceremony: f.ceremony)
    assert {:error, :ceremony_required} = Ceremony.dry_run([])
  end

  test "a real ceremony generates, backs up, restores, binds and reports", f do
    public = generate!(f)
    assert public["mode"] == "real"
    assert (File.stat!(f.signer).mode &&& 0o777) == 0o600
    assert {:ok, _, pub} = Manifest.read_identity_file(f.signer, "x")
    assert Base.encode64(pub) == public["public_key_base64"]

    assert public["fingerprint_sha256"] ==
             :crypto.hash(:sha256, pub) |> Base.encode16(case: :lower)

    backup!(f)
    assert (File.stat!(f.backup).mode &&& 0o777) == 0o600

    # Possession is proven without the signer file.
    File.rm!(f.signer)
    assert {:ok, proof} = verify_backup!(f, restore_to: f.restored)
    assert proof["ok"] and proof["seed_restored"]
    assert {:ok, _, ^pub} = Manifest.read_identity_file(f.restored, "x")

    space = space(f)
    {payload, record} = payload!(f, space)
    assert record.catalog_key == pub
    assert record.space == space.replica and record.space_root == space.root.pub
    assert payload["canonical_base64"] == Base.encode64(Lattice.Canonical.term(record))

    review = File.read!(Path.join(f.ceremony, "binding-review.txt"))
    assert review =~ payload["sha256"] and review =~ @origin

    # Before the root signs, the report is honest about the pending binding.
    assert {:error, :binding_not_found} =
             Ceremony.verify_binding(ceremony: f.ceremony, space_log: space.pre)

    # A real ceremony needs the restore drill on another host.
    assert {:error, :restore_not_separate_host} = report!(f)
    separate_host!(f)

    assert {:ok, pending} = report!(f)
    assert pending.sha256 =~ ~r/^[0-9a-f]{64}$/
    pending_report = pending.path |> File.read!() |> Jason.decode!()
    assert pending_report["binding"]["status"] == "pending_root_signature"
    assert pending_report["binding"]["payload_sha256"] == payload["sha256"]
    assert pending_report["binding"]["blocker"] == "row 232"
    assert pending_report["mode"] == "real"

    {signed, [op]} = sign_bootstraps(space, [record], "signed")
    assert {:ok, binding} = Ceremony.verify_binding(ceremony: f.ceremony, space_log: signed)
    assert binding["bootstrap_id"] == op.id and binding["record_sha256"] == payload["sha256"]

    assert {:ok, done} = report!(f)
    final = done.path |> File.read!() |> Jason.decode!()
    assert final["binding"]["status"] == "verified"
    assert final["binding"]["bootstrap_id"] == op.id

    assert final["custody"] == %{
             "custodian" => "Ada",
             "passphrase_holder" => "Grace",
             "rotation_owner" => "Linus"
           }

    assert final["restore"]["separate_host"] == true
  end

  # Separateness is hostname-based; a one-host test run flips it as an operator would attest.
  defp separate_host!(f) do
    path = Path.join(f.ceremony, "restore.json")

    record =
      path
      |> File.read!()
      |> Jason.decode!()
      |> Map.merge(%{"host" => "second-machine.invalid", "separate_host" => true})

    File.write!(path, Jason.encode!(record))
  end

  defp report!(f, extra \\ []) do
    Ceremony.report(
      Keyword.merge(
        [
          ceremony: f.ceremony,
          custodian: "Ada",
          passphrase_holder: "Grace",
          rotation_owner: "Linus"
        ],
        extra
      )
    )
  end

  test "import adopts an existing seed and records it as imported", f do
    public = generate!(f)
    File.rm!(Path.join(f.ceremony, "signer.json"))
    assert {:ok, imported} = Ceremony.import_signer(signer: f.signer, ceremony: f.ceremony)
    assert imported["imported"] == true and imported["mode"] == "real"
    assert imported["public_key_base64"] == public["public_key_base64"]
  end

  # ------------------------------------------------------- signer + paths

  test "generate refuses an existing seed, an existing record and a missing path", f do
    generate!(f)

    assert {:error, :signer_record_exists} =
             Ceremony.generate(signer: f.signer, ceremony: f.ceremony)

    other = Path.join(f.base, "other-ceremony")
    assert {:error, :signer_exists} = Ceremony.generate(signer: f.signer, ceremony: other)
    assert {:error, :signer_path_required} = Ceremony.generate(ceremony: other)
    assert {:error, :ceremony_required} = Ceremony.generate(signer: Path.join(f.keys, "n.seed"))
  end

  test "a signer directory must be private to the operator", f do
    shared = Path.join(f.base, "shared")
    File.mkdir_p!(shared)
    File.chmod!(shared, 0o755)

    assert {:error, :unsafe_signer_directory} =
             Ceremony.generate(signer: Path.join(shared, "s.seed"), ceremony: f.ceremony)

    assert {:error, :unsafe_signer_directory} =
             Ceremony.generate(signer: Path.join(f.base, "missing/s.seed"), ceremony: f.ceremony)

    refute File.exists?(Path.join(shared, "s.seed"))
  end

  test "a signer is never created inside a git work tree", f do
    repo = Path.join(f.base, "repo")
    keys = Path.join(repo, "keys")
    File.mkdir_p!(Path.join(repo, ".git"))
    File.mkdir_p!(keys)
    File.chmod!(keys, 0o700)

    assert {:error, :signer_in_git_checkout} =
             Ceremony.generate(signer: Path.join(keys, "s.seed"), ceremony: f.ceremony)

    refute File.exists?(Path.join(keys, "s.seed"))
  end

  test "the signer and the public ceremony directory never overlap", f do
    inside = Path.join(f.ceremony, "keys")
    File.mkdir_p!(inside)
    File.chmod!(inside, 0o700)

    assert {:error, :signer_ceremony_overlap} =
             Ceremony.generate(signer: Path.join(inside, "s.seed"), ceremony: f.ceremony)

    # The ceremony directory may not live beside the seed either.
    assert {:error, :signer_ceremony_overlap} =
             Ceremony.generate(
               signer: Path.join(f.keys, "s.seed"),
               ceremony: Path.join(f.keys, "pub")
             )

    assert {:error, :signer_ceremony_overlap} =
             Ceremony.generate(signer: Path.join(f.keys, "s.seed"), ceremony: f.keys)
  end

  test "a symlinked signer is refused, also through a symlinked ceremony path", f do
    target = Path.join(f.keys, "real.seed")
    File.write!(target, String.duplicate("ab", 32) <> "\n")
    File.chmod!(target, 0o600)
    link = Path.join(f.keys, "link.seed")
    File.ln_s!(target, link)

    assert {:error, :signer_symlink} = Ceremony.generate(signer: link, ceremony: f.ceremony)
    assert {:error, :signer_symlink} = Ceremony.import_signer(signer: link, ceremony: f.ceremony)

    pub_link = Path.join(f.base, "ceremony-link")
    File.ln_s!(f.ceremony, pub_link)

    assert {:error, :ceremony_directory_invalid} =
             Ceremony.generate(signer: Path.join(f.keys, "x"), ceremony: pub_link)
  end

  test "import validates the seed file by the manifest identity policy", f do
    assert {:error, :signer_unreadable} =
             Ceremony.import_signer(signer: f.signer, ceremony: f.ceremony)

    File.write!(f.signer, "not a seed\n")
    File.chmod!(f.signer, 0o600)

    assert {:error, :signer_unreadable} =
             Ceremony.import_signer(signer: f.signer, ceremony: f.ceremony)

    File.write!(f.signer, String.duplicate("cd", 32) <> "\n")
    File.chmod!(f.signer, 0o640)

    assert {:error, :signer_unreadable} =
             Ceremony.import_signer(signer: f.signer, ceremony: f.ceremony)

    File.chmod!(f.signer, 0o600)

    assert {:ok, %{"imported" => true}} =
             Ceremony.import_signer(signer: f.signer, ceremony: f.ceremony)
  end

  # ------------------------------------------------------------- backups

  test "backup refuses weak, mismatched or unreadable passphrases", f do
    generate!(f)
    opts = [signer: f.signer, ceremony: f.ceremony, out: f.backup]

    assert {:error, :passphrase_mismatch} =
             Ceremony.backup(
               opts ++ [passphrase_reader: reader([@passphrase, @passphrase <> "x"])]
             )

    assert {:error, :passphrase_too_short} =
             Ceremony.backup(opts ++ [passphrase_reader: reader(["short", "short"])])

    assert {:error, :passphrase_unreadable} =
             Ceremony.backup(opts ++ [passphrase_reader: reader([@passphrase])])

    refute File.exists?(f.backup)
  end

  test "backup path policy", f do
    generate!(f)
    opts = [signer: f.signer, ceremony: f.ceremony, passphrase_reader: passphrase_reader()]

    assert {:error, :backup_path_required} = Ceremony.backup(opts)

    assert {:error, :backup_beside_signer} =
             Ceremony.backup(opts ++ [out: Path.join(f.keys, "signer.backup")])

    assert {:error, :backup_directory_unavailable} =
             Ceremony.backup(opts ++ [out: Path.join(f.base, "absent/signer.backup")])

    repo = Path.join(f.base, "repo")
    File.mkdir_p!(Path.join(repo, ".git"))

    assert {:error, :backup_in_git_checkout} =
             Ceremony.backup(opts ++ [out: Path.join(repo, "signer.backup")])

    File.write!(f.backup, "occupied")
    assert {:error, :backup_exists} = Ceremony.backup(opts ++ [out: f.backup])
    assert File.read!(f.backup) == "occupied"

    link = Path.join(f.backups, "link.backup")
    File.ln_s!(f.backup, link)
    assert {:error, :backup_symlink} = Ceremony.backup(opts ++ [out: link])
  end

  test "a backup that does not decrypt right after writing is deleted", f do
    generate!(f)

    assert {:error, :backup_self_check_failed} =
             Ceremony.backup(
               signer: f.signer,
               ceremony: f.ceremony,
               out: f.backup,
               passphrase_reader: passphrase_reader(),
               after_write: fn path -> File.write(path, "{}") end
             )

    refute File.exists?(f.backup)
    refute File.exists?(Path.join(f.ceremony, "backup.json"))
  end

  test "backup refuses a signer file that no longer matches the ceremony record", f do
    generate!(f)
    File.rm!(f.signer)
    File.write!(f.signer, String.duplicate("ef", 32) <> "\n")
    File.chmod!(f.signer, 0o600)

    assert {:error, :signer_key_mismatch} =
             Ceremony.backup(
               signer: f.signer,
               ceremony: f.ceremony,
               out: f.backup,
               passphrase_reader: passphrase_reader()
             )

    refute File.exists?(f.backup)
  end

  test "the backup format is the documented recipe, reproducible with :crypto alone", f do
    generate!(f)
    backup!(f)
    seed = f.signer |> seed_hex() |> Base.decode16!(case: :mixed)

    file = f.backup |> File.read!() |> Jason.decode!()

    assert Enum.sort(Map.keys(file)) ==
             ~w(cipher ciphertext_base64 format kdf public_key_base64 tag_base64)

    assert file["format"] == "lattice-catalog-signer-backup-v1"
    assert file["kdf"]["name"] == "pbkdf2-hmac-sha256" and file["kdf"]["iterations"] == 600_000
    assert file["cipher"]["name"] == "aes-256-gcm"

    # AAD: the header object, keys sorted at every level, compact JSON.
    aad =
      ~s({"cipher":{"name":"aes-256-gcm","nonce_base64":"#{file["cipher"]["nonce_base64"]}"},) <>
        ~s("format":"lattice-catalog-signer-backup-v1",) <>
        ~s("kdf":{"iterations":600000,"name":"pbkdf2-hmac-sha256","salt_base64":"#{file["kdf"]["salt_base64"]}"},) <>
        ~s("public_key_base64":"#{file["public_key_base64"]}"})

    key =
      :crypto.pbkdf2_hmac(
        :sha256,
        @passphrase,
        Base.decode64!(file["kdf"]["salt_base64"]),
        600_000,
        32
      )

    assert ^seed =
             :crypto.crypto_one_time_aead(
               :aes_256_gcm,
               key,
               Base.decode64!(file["cipher"]["nonce_base64"]),
               Base.decode64!(file["ciphertext_base64"]),
               aad,
               Base.decode64!(file["tag_base64"]),
               false
             )

    assert Backup.aad(Map.drop(file, ~w(ciphertext_base64 tag_base64))) == aad
  end

  defp tamper_backup!(f, fun) do
    updated = f.backup |> File.read!() |> Jason.decode!() |> fun.() |> Jason.encode!(pretty: true)
    File.write!(f.backup, updated <> "\n")
    rerecord!(f)
  end

  # Make backup.json describe whatever bytes the backup file now holds.
  defp rerecord!(f) do
    record_path = Path.join(f.ceremony, "backup.json")
    record = record_path |> File.read!() |> Jason.decode!()
    sha = :crypto.hash(:sha256, File.read!(f.backup)) |> Base.encode16(case: :lower)
    File.write!(record_path, Jason.encode!(Map.put(record, "sha256", sha)))
  end

  test "a tampered backup never restores", f do
    generate!(f)
    backup!(f)
    pristine = File.read!(f.backup)

    flip = fn text ->
      <<first, rest::binary>> = Base.decode64!(text)
      Base.encode64(<<Bitwise.bxor(first, 1), rest::binary>>)
    end

    # Digest guard first: any byte change against backup.json.
    File.write!(f.backup, String.replace(pristine, "aes-256-gcm", "aes-256-gcn"))
    assert {:error, :backup_digest_mismatch} = verify_backup!(f)
    File.write!(f.backup, pristine)

    tamper_backup!(f, fn file -> Map.update!(file, "ciphertext_base64", flip) end)
    assert {:error, :backup_decrypt_failed} = verify_backup!(f)

    File.write!(f.backup, pristine)
    tamper_backup!(f, fn file -> Map.update!(file, "tag_base64", flip) end)
    assert {:error, :backup_decrypt_failed} = verify_backup!(f)

    # Header fields are authenticated data.
    File.write!(f.backup, pristine)

    tamper_backup!(f, fn file ->
      put_in(file, ["kdf", "salt_base64"], flip.(file["kdf"]["salt_base64"]))
    end)

    assert {:error, :backup_decrypt_failed} = verify_backup!(f)

    File.write!(f.backup, pristine)

    tamper_backup!(f, fn file ->
      Map.put(file, "public_key_base64", Base.encode64(random_pub()))
    end)

    assert {:error, :backup_decrypt_failed} = verify_backup!(f)

    for {label, mutate} <- [
          iterations: fn file -> put_in(file, ["kdf", "iterations"], 1) end,
          kdf: fn file -> put_in(file, ["kdf", "name"], "scrypt") end,
          cipher: fn file -> put_in(file, ["cipher", "name"], "chacha20-poly1305") end,
          format: fn file -> Map.put(file, "format", "lattice-catalog-signer-backup-v2") end,
          extra: fn file -> Map.put(file, "note", "x") end,
          nonce: fn file -> put_in(file, ["cipher", "nonce_base64"], "AAAA") end
        ] do
      File.write!(f.backup, pristine)
      tamper_backup!(f, mutate)
      assert {:error, :malformed_backup} = verify_backup!(f), "#{label}"
    end

    File.write!(f.backup, "not json")
    rerecord!(f)
    assert {:error, :malformed_backup} = verify_backup!(f)
  end

  test "verify-backup restores without the signer file and refuses a wrong passphrase", f do
    public = generate!(f)
    backup!(f)
    File.rm!(f.signer)

    assert {:error, :backup_decrypt_failed} =
             Ceremony.verify_backup(
               backup: f.backup,
               ceremony: f.ceremony,
               passphrase_reader: reader(["not the right passphrase 000"])
             )

    refute File.exists?(Path.join(f.ceremony, "restore.json"))

    assert {:ok, proof} = verify_backup!(f, restore_to: f.restored)
    assert proof["public_key_base64"] == public["public_key_base64"]
    assert {:ok, _, pub} = Manifest.read_identity_file(f.restored, "x")
    assert Base.encode64(pub) == public["public_key_base64"]
    assert (File.stat!(f.restored).mode &&& 0o777) == 0o600
    assert proof["generation_host"] == public["host"]
    assert is_boolean(proof["separate_host"])

    # The restore target follows the signer path policy and is never replaced.
    assert {:error, :signer_exists} = verify_backup!(f, restore_to: f.restored)

    assert {:error, :signer_in_git_checkout} =
             verify_backup!(f, restore_to: Path.join(git_dir(f), "s.seed"))

    assert {:error, :backup_unreadable} =
             Ceremony.verify_backup(backup: Path.join(f.backups, "none"), ceremony: f.ceremony)
  end

  defp git_dir(f) do
    keys = Path.join([f.base, "gitrepo", "keys"])
    File.mkdir_p!(Path.join(f.base, "gitrepo/.git"))
    File.mkdir_p!(keys)
    File.chmod!(keys, 0o700)
    keys
  end

  test "verify-backup refuses a backup of another key", f do
    generate!(f)
    other_ceremony = Path.join(f.base, "other")
    other_signer = Path.join(f.keys, "other.seed")
    other_backup = Path.join(f.backups, "other.backup")
    {:ok, _} = Ceremony.generate(signer: other_signer, ceremony: other_ceremony)

    {:ok, _} =
      Ceremony.backup(
        signer: other_signer,
        ceremony: other_ceremony,
        out: other_backup,
        passphrase_reader: passphrase_reader()
      )

    File.cp!(Path.join(other_ceremony, "backup.json"), Path.join(f.ceremony, "backup.json"))

    assert {:error, :backup_key_mismatch} =
             Ceremony.verify_backup(
               backup: other_backup,
               ceremony: f.ceremony,
               passphrase_reader: passphrase_reader(1)
             )
  end

  # ------------------------------------------------------------- binding

  test "binding payload refuses malformed inputs and key reuse", f do
    public = generate!(f)
    space = space(f)

    base = [
      ceremony: f.ceremony,
      space_log: space.pre,
      service_public_key: service_b64(),
      origin: @origin
    ]

    assert {:error, :malformed_binding} =
             Ceremony.binding_payload(Keyword.put(base, :origin, "ws://insecure.test"))

    assert {:error, :malformed_binding} =
             Ceremony.binding_payload(Keyword.put(base, :origin, "wss://1.2.3.4"))

    assert {:error, :malformed_binding} =
             Ceremony.binding_payload(Keyword.put(base, :service_public_key, "AAAA"))

    assert {:error, :malformed_binding} =
             Ceremony.binding_payload(Keyword.put(base, :service_id, "short"))

    assert {:error, :malformed_binding} =
             Ceremony.binding_payload(Keyword.put(base, :origin, nil))

    assert {:error, :binding_key_reuse} =
             Ceremony.binding_payload(
               Keyword.put(base, :service_public_key, public["public_key_base64"])
             )

    assert {:error, :binding_key_reuse} =
             Ceremony.binding_payload(
               Keyword.put(base, :service_public_key, Base.encode64(space.root.pub))
             )

    assert {:error, :space_log_required} =
             Ceremony.binding_payload(Keyword.delete(base, :space_log))

    bad = Path.join(f.space, "bad.log")
    File.write!(bad, "garbage")

    assert {:error, :invalid_space_log} =
             Ceremony.binding_payload(Keyword.put(base, :space_log, bad))

    assert {:error, :invalid_space_log} =
             Ceremony.binding_payload(Keyword.put(base, :space_log, Path.join(f.space, "none")))

    refute File.exists?(Path.join(f.ceremony, "binding-payload.json"))
  end

  test "a legacy-family Space cannot carry the binding", f do
    generate!(f)

    assert {:error, :space_not_bounded_profile} =
             Ceremony.binding_payload(
               ceremony: f.ceremony,
               space_log: legacy_space(f),
               service_public_key: service_b64(),
               origin: @origin
             )

    # The report is still possible with the binding pending (inputs 1 and 3).
    backup!(f)
    {:ok, _} = verify_backup!(f)
    separate_host!(f)
    assert {:ok, done} = report!(f)

    assert %{"binding" => %{"status" => "pending_root_signature", "payload_sha256" => nil}} =
             done.path |> File.read!() |> Jason.decode!()
  end

  test "an explicit service id is kept and a fresh nonce is never reused", f do
    generate!(f)
    space = space(f)
    service_id = id("service")
    {_, first} = payload!(f, space, service_id: service_id)
    {_, second} = payload!(f, space, service_id: service_id)
    assert first.service_id == service_id and second.service_id == service_id
    refute first.nonce == second.nonce
    {_, generated} = payload!(f, space)
    assert ContinuationCertificate.id?(generated.service_id)
  end

  test "verify-binding finds exactly one honored record authored by the root", f do
    generate!(f)
    space = space(f)
    {payload, record} = payload!(f, space)

    {other_signed, _} =
      sign_bootstraps(space, [%{record | nonce: id("different-nonce")}], "other")

    assert {:error, :binding_not_found} =
             Ceremony.verify_binding(ceremony: f.ceremony, space_log: other_signed)

    {fork, ops} = sign_bootstraps(space, [record, %{record | nonce: id("fork-nonce")}], "fork")

    assert {:error, :binding_fork} =
             Ceremony.verify_binding(ceremony: f.ceremony, space_log: fork),
           inspect(length(ops))

    refute File.exists?(Path.join(f.ceremony, "binding.json"))

    {again, _} = sign_bootstraps(space, [record], "again")

    assert {:ok, %{"record_sha256" => sha}} =
             Ceremony.verify_binding(ceremony: f.ceremony, space_log: again)

    assert sha == payload["sha256"]
  end

  test "verify-binding rejects a corrupt or foreign payload artifact", f do
    generate!(f)
    space = space(f)
    {_payload, record} = payload!(f, space)
    {signed, _} = sign_bootstraps(space, [record], "signed")
    path = Path.join(f.ceremony, "binding-payload.json")
    pristine = File.read!(path)

    File.write!(path, String.replace(pristine, @origin, "wss://evil.example.test"))

    assert {:error, :ceremony_artifact_malformed} =
             Ceremony.verify_binding(ceremony: f.ceremony, space_log: signed)

    File.write!(path, "{")

    assert {:error, :ceremony_artifact_malformed} =
             Ceremony.verify_binding(ceremony: f.ceremony, space_log: signed)

    File.rm!(path)

    assert {:error, :ceremony_artifact_missing} =
             Ceremony.verify_binding(ceremony: f.ceremony, space_log: signed)
  end

  # ------------------------------------------------ review findings (round 2)

  test "the report requires the complete binding record", f do
    generate!(f)
    backup!(f)
    {:ok, _} = verify_backup!(f)
    separate_host!(f)
    space = space(f)
    {_payload, record} = payload!(f, space)
    {signed, _} = sign_bootstraps(space, [record], "signed")
    {:ok, binding} = Ceremony.verify_binding(ceremony: f.ceremony, space_log: signed)
    path = Path.join(f.ceremony, "binding.json")
    assert {:ok, _} = report!(f)

    for {label, mutate} <- [
          thin: fn b -> Map.take(b, ["bootstrap_id", "record_sha256"]) end,
          extra: fn b -> Map.put(b, "note", "x") end,
          format: fn b -> Map.put(b, "format", "other") end,
          id: fn b -> Map.put(b, "bootstrap_id", "x") end,
          sha: fn b -> Map.put(b, "record_sha256", String.duplicate("a", 64)) end,
          space: fn b -> Map.put(b, "space", "replica:other") end,
          time: fn b -> Map.put(b, "verified_at", "yesterday") end
        ] do
      File.write!(path, Jason.encode!(mutate.(binding)))
      assert {:error, :ceremony_inconsistent} = report!(f), "#{label}"
    end

    File.write!(path, Jason.encode!(binding))
    assert {:ok, _} = report!(f)
  end

  test "a backup record that cannot be written removes the backup it just made", f do
    generate!(f)

    assert {:error, :ceremony_write_failed} =
             Ceremony.backup(
               signer: f.signer,
               ceremony: f.ceremony,
               out: f.backup,
               passphrase_reader: passphrase_reader(),
               before_record: fn _dir ->
                 assert File.regular?(f.backup)
                 File.chmod!(f.ceremony, 0o500)
                 :ok
               end
             )

    File.chmod!(f.ceremony, 0o700)
    refute File.exists?(f.backup)
    refute File.exists?(Path.join(f.ceremony, "backup.json"))
    backup!(f)
  end

  defp edit_json!(dir, name, fun) do
    path = Path.join(dir, name)
    File.write!(path, path |> File.read!() |> Jason.decode!() |> fun.() |> Jason.encode!())
  end

  test "signer.json must be the complete public record", f do
    public = generate!(f)
    backup!(f)

    pristine = Path.join(f.ceremony, "signer.json") |> File.read!()

    for {label, mutate} <- [
          missing_host: fn r -> Map.delete(r, "host") end,
          empty_host: fn r -> Map.put(r, "host", "") end,
          control_host: fn r -> Map.put(r, "host", "a\nb") end,
          long_host: fn r -> Map.put(r, "host", String.duplicate("h", 256)) end,
          number_host: fn r -> Map.put(r, "host", 7) end,
          extra: fn r -> Map.put(r, "note", "x") end,
          hex: fn r -> Map.put(r, "public_key_hex", String.duplicate("a", 64)) end,
          fingerprint: fn r -> Map.put(r, "fingerprint_sha256", String.duplicate("a", 64)) end,
          time: fn r -> Map.put(r, "created_at", 5) end,
          imported: fn r -> Map.put(r, "imported", false) end,
          mode: fn r -> Map.put(r, "mode", "dry_run") end
        ] do
      File.write!(Path.join(f.ceremony, "signer.json"), pristine)
      edit_json!(f.ceremony, "signer.json", mutate)

      assert {:error, :ceremony_artifact_malformed} = verify_backup!(f), "verify #{label}"

      assert {:error, :ceremony_artifact_malformed} =
               Ceremony.backup(
                 signer: f.signer,
                 ceremony: f.ceremony,
                 out: Path.join(f.backups, "again.backup"),
                 passphrase_reader: passphrase_reader()
               ),
             "backup #{label}"
    end

    File.write!(Path.join(f.ceremony, "signer.json"), pristine)
    assert {:ok, %{"generation_host" => host}} = verify_backup!(f)
    assert host == public["host"]
  end

  test "the report refuses a hand-edited or malformed restore record", f do
    generate!(f)
    backup!(f)
    {:ok, _} = verify_backup!(f)
    path = Path.join(f.ceremony, "restore.json")
    pristine = File.read!(path)

    # Same host, hand-edited to claim a second machine.
    edit_json!(f.ceremony, "restore.json", &Map.put(&1, "separate_host", true))
    assert {:error, :ceremony_artifact_malformed} = report!(f)

    for {label, mutate} <- [
          empty_host: fn r -> Map.put(r, "host", "") end,
          missing_generation: fn r -> Map.delete(r, "generation_host") end,
          control: fn r -> Map.put(r, "host", "a\u0000b") end,
          non_boolean: fn r -> Map.put(r, "separate_host", "false") end
        ] do
      File.write!(path, pristine)
      edit_json!(f.ceremony, "restore.json", mutate)
      assert {:error, :ceremony_artifact_malformed} = report!(f), "#{label}"
    end

    # A different generation host than signer.json records is inconsistent.
    File.write!(path, pristine)

    edit_json!(
      f.ceremony,
      "restore.json",
      &Map.merge(&1, %{"generation_host" => "elsewhere.invalid", "separate_host" => true})
    )

    assert {:error, :ceremony_inconsistent} = report!(f)
    File.write!(path, pristine)
    separate_host!(f)
    assert {:ok, _} = report!(f)
  end

  test "verify-backup applies the secret-path policy to an existing backup", f do
    generate!(f)
    backup!(f)
    File.rm!(f.signer)

    File.chmod!(f.backup, 0o640)
    assert {:error, :backup_unreadable} = verify_backup!(f)
    File.chmod!(f.backup, 0o604)
    assert {:error, :backup_unreadable} = verify_backup!(f)
    File.chmod!(f.backup, 0o600)

    # A second link to the file.
    File.ln!(f.backup, Path.join(f.backups, "second-link"))
    assert {:error, :backup_unreadable} = verify_backup!(f)
    File.rm!(Path.join(f.backups, "second-link"))

    # A group-writable directory (not sticky) can have the file swapped.
    File.chmod!(f.backups, 0o770)
    assert {:error, :backup_directory_unavailable} = verify_backup!(f)
    File.chmod!(f.backups, 0o700)

    # A symlink at the leaf, or a symlinked parent that resolves to an unsafe chain.
    link = Path.join(f.base, "backup-link")
    File.ln_s!(f.backup, link)
    assert {:error, :backup_unreadable} = verify_backup!(f, backup: link)

    # A copy inside a git work tree.
    repo = Path.join(f.base, "repo")
    File.mkdir_p!(Path.join(repo, ".git"))
    File.chmod!(repo, 0o700)
    copy = Path.join(repo, "signer.backup")
    File.cp!(f.backup, copy)
    File.chmod!(copy, 0o600)
    assert {:error, :backup_in_git_checkout} = verify_backup!(f, backup: copy)

    assert {:ok, %{"ok" => true}} = verify_backup!(f)
  end

  test "verify-binding refuses a Space whose bounded profile changed after review", f do
    generate!(f)
    space = space(f)
    {_payload, record} = payload!(f, space)

    other = Identity.generate("other-nominee")
    witnesses = for n <- 1..3, do: Identity.generate("x#{n}")

    profile2 = %{
      mode: :bounded_continuation,
      version: 1,
      product: :treehouse,
      kind: :space,
      role: :admin,
      nominee: other.pub,
      witnesses: Enum.sort(Enum.map(witnesses, & &1.pub)),
      threshold: 2,
      max_lease_epochs: 7
    }

    empty = Delegation.genesis(space.root, space.replica, ops: [], roles: [], live: false)

    pin2 =
      Op.new(
        space.root,
        space.replica,
        [space.pin.id],
        :authority,
        {:genesis, empty, %{__continuation__: profile2}}
      )

    signed =
      Op.new(
        space.root,
        space.replica,
        [pin2.id],
        :command,
        {:catalog_bootstrap_v1, [record]},
        cap: space.delegation.id
      )

    log = Enum.reduce([pin2, signed], space.before, &Log.append!(&2, &1))
    path = Path.join(f.space, "repinned.log")
    :ok = Log.dump(log, path)

    assert {:error, :binding_profile_changed} =
             Ceremony.verify_binding(ceremony: f.ceremony, space_log: path)

    refute File.exists?(Path.join(f.ceremony, "binding.json"))
  end

  # -------------------------------------------------------------- report

  test "the report refuses an unverified restore, unsplit custody and bad names", f do
    generate!(f)
    backup!(f)
    assert {:error, :restore_not_verified} = report!(f)
    {:ok, _} = verify_backup!(f)
    separate_host!(f)

    assert {:error, :custody_not_split} = report!(f, passphrase_holder: " ada ")
    assert {:error, :malformed_custody_name} = report!(f, custodian: "")

    assert {:error, :malformed_custody_name} =
             report!(f, rotation_owner: String.duplicate("x", 81))

    assert {:error, :malformed_custody_name} = report!(f, custodian: "bad\nname")
    assert {:error, :malformed_custody_name} = Ceremony.report(ceremony: f.ceremony)
    assert {:ok, _} = report!(f, rotation_owner: String.duplicate("x", 80))
  end

  test "the report refuses artifacts that disagree", f do
    generate!(f)
    backup!(f)
    {:ok, _} = verify_backup!(f)
    separate_host!(f)
    path = Path.join(f.ceremony, "backup.json")
    record = path |> File.read!() |> Jason.decode!()

    File.write!(
      path,
      Jason.encode!(Map.put(record, "public_key_base64", Base.encode64(random_pub())))
    )

    assert {:error, :ceremony_inconsistent} = report!(f)

    File.write!(path, Jason.encode!(record))
    assert {:ok, _} = report!(f)

    File.write!(
      Path.join(f.ceremony, "binding.json"),
      Jason.encode!(%{"bootstrap_id" => "x", "record_sha256" => "y"})
    )

    assert {:error, :ceremony_inconsistent} = report!(f)
  end

  test "artifacts must exist and parse", f do
    generate!(f)
    File.rm!(Path.join(f.ceremony, "signer.json"))
    assert {:error, :ceremony_artifact_missing} = report!(f)
    File.write!(Path.join(f.ceremony, "signer.json"), "[]")
    assert {:error, :ceremony_artifact_malformed} = report!(f)

    assert {:error, :ceremony_directory_invalid} =
             report!(f, ceremony: Path.join(f.base, "nowhere"))
  end

  # --------------------------------------------------- dry-run separation

  test "real mode refuses every dry-run key", f do
    seed = :crypto.hash(:sha256, @dry_label <> ":signer")
    File.write!(f.signer, Base.encode16(seed, case: :lower) <> "\n")
    File.chmod!(f.signer, 0o600)

    assert {:error, :disposable_test_key} =
             Ceremony.import_signer(signer: f.signer, ceremony: f.ceremony)

    refute File.exists?(Path.join(f.ceremony, "signer.json"))

    # A disposable Space root or service key is refused when binding.
    File.rm!(f.signer)
    generate!(f)
    disposable = DryRun.history()
    pre = Path.join(f.space, "disposable.log")
    :ok = Log.dump(disposable.before, pre)

    assert {:error, :disposable_test_key} =
             Ceremony.binding_payload(
               ceremony: f.ceremony,
               space_log: pre,
               service_public_key: service_b64(),
               origin: @origin
             )

    {service, _} =
      :crypto.generate_key(:eddsa, :ed25519, :crypto.hash(:sha256, @dry_label <> ":service"))

    assert {:error, :disposable_test_key} =
             Ceremony.binding_payload(
               ceremony: f.ceremony,
               space_log: space(f).pre,
               service_public_key: Base.encode64(service),
               origin: @origin
             )

    assert Enum.all?(DryRun.public_keys(), &(byte_size(&1) == 32))
    assert length(Enum.uniq(DryRun.public_keys())) == 7
  end

  test "real mode refuses a dry-run ceremony directory", f do
    dir = Path.join(f.base, "dry")
    {:ok, _} = Ceremony.dry_run(ceremony: dir)
    fresh = Path.join(f.keys, "fresh.seed")

    assert {:error, :dry_run_ceremony_dir} = Ceremony.generate(signer: fresh, ceremony: dir)
    assert {:error, :dry_run_ceremony_dir} = Ceremony.import_signer(signer: fresh, ceremony: dir)
    assert {:error, :dry_run_ceremony_dir} = report!(f, ceremony: dir)

    assert {:error, :dry_run_ceremony_dir} =
             Ceremony.verify_backup(
               backup: Path.join(dir, "disposable-backup/signer.backup"),
               ceremony: dir,
               passphrase_reader: passphrase_reader(1)
             )

    assert {:error, :dry_run_ceremony_dir} =
             Ceremony.verify_binding(
               ceremony: dir,
               space_log: Path.join(dir, "disposable-space.log")
             )

    refute File.exists?(fresh)
  end

  # --------------------------------------------------- refusals are atoms

  test "any raise becomes an atom-only refusal", _f do
    assert {:error, :catalog_ceremony_refused} = Ceremony.generate(:not_options)

    assert {:error, :catalog_ceremony_refused} = Ceremony.report(:not_options)
    assert {:error, :catalog_ceremony_refused} = Ceremony.import_signer("x")
  end

  test "the command line refuses unknown input without echoing it", f do
    secret = "deadbeef" <> String.duplicate("ab", 28)
    {result, out, err} = cli(["generate", "--seed", secret, "--ceremony", f.ceremony])
    assert result == {:error, :invalid_options}
    assert out == "" and err == "refused: invalid_options\n"
    refute err =~ secret

    assert {{:error, :unknown_command}, "", "refused: unknown_command\n"} = cli(["sign"])
    assert {{:error, :unknown_command}, "", _} = cli([])
    assert {{:error, :unknown_command}, "", _} = cli(["generate", "extra"])

    assert {{:error, :option_required}, "", "refused: option_required\n"} =
             cli(["generate", "--ceremony", f.ceremony])

    assert {{:error, :invalid_options}, "", _} =
             cli(["report", "--signer", f.signer, "--ceremony", f.ceremony])

    assert Cli.commands() ==
             ~w(backup binding-payload dry-run generate import report verify-backup verify-binding)
  end

  test "every command's output and artifacts hold no seed or passphrase", f do
    {:ok, space} = {:ok, space(f)}
    ceremony = ["--ceremony", f.ceremony]

    {:ok, out, err} =
      collect([
        {["generate", "--signer", f.signer] ++ ceremony, []},
        {["backup", "--signer", f.signer, "--out", f.backup] ++ ceremony,
         [@passphrase, @passphrase]},
        {["verify-backup", "--backup", f.backup, "--restore-to", f.restored] ++ ceremony,
         [@passphrase]},
        fn -> separate_host!(f) end,
        {[
           "binding-payload",
           "--space-log",
           space.pre,
           "--service-public-key",
           service_b64(),
           "--origin",
           @origin
         ] ++ ceremony, []},
        {[
           "report",
           "--custodian",
           "Ada",
           "--passphrase-holder",
           "Grace",
           "--rotation-owner",
           "Linus"
         ] ++ ceremony, []}
      ])

    seed_hex = seed_hex(f.signer)
    seed = Base.decode16!(seed_hex, case: :mixed)

    secrets = [
      seed_hex,
      String.upcase(seed_hex),
      Base.encode64(seed),
      Base.url_encode64(seed, padding: false),
      Base.encode64(seed, padding: false),
      @passphrase,
      Base.encode64(@passphrase)
    ]

    for text <- [out, err], secret <- secrets, do: refute(text =~ secret)
    assert err == ""

    for path <- ceremony_files(f.ceremony), secret <- secrets do
      refute File.read!(path) =~ secret, path
    end

    # Refusals print an atom and nothing else.
    {result, out, err} =
      cli(["backup", "--signer", f.signer, "--out", f.backup] ++ ceremony, [
        @passphrase,
        @passphrase
      ])

    assert result == {:error, :backup_exists}
    assert out == "" and err == "refused: backup_exists\n"

    {_, out, err} =
      cli(["verify-backup", "--backup", f.backup] ++ ceremony, [
        "wrong passphrase wrong passphrase"
      ])

    refute out <> err =~ "wrong passphrase"
    assert err == "refused: backup_decrypt_failed\n"
  end

  defp collect(commands) do
    Enum.reduce(commands, {:ok, "", ""}, fn
      step, acc when is_function(step, 0) ->
        step.()
        acc

      {argv, lines}, {:ok, out, err} ->
        {result, o, e} = cli(argv, lines)
        assert result == :ok, inspect({argv |> hd(), result, e})
        {:ok, out <> o, err <> e}
    end)
  end

  test "the dry-run command prints only public values and exits clean", f do
    dir = Path.join(f.base, "cli-dry")
    {result, out, err} = cli(["dry-run", "--ceremony", dir])
    assert result == :ok and err == ""
    assert out =~ "bootstrap_id: " and out =~ "report_sha256: "
    refute out =~ Base.encode16(:crypto.hash(:sha256, @dry_label <> ":signer"), case: :lower)
  end

  # ------------------------------------------------ review-round hardening

  test "the passphrase gate refuses a terminal before any read", f do
    stat = fn type -> fn "/dev/fd/0" -> {:ok, %File.Stat{type: type}} end end

    assert :ok = Passphrase.stdin_gate(stat.(:regular))
    assert :ok = Passphrase.stdin_gate(stat.(:other))
    assert {:error, :passphrase_stdin_is_terminal} = Passphrase.stdin_gate(stat.(:device))
    assert {:error, :passphrase_unreadable} = Passphrase.stdin_gate(stat.(:directory))
    assert {:error, :passphrase_unreadable} = Passphrase.stdin_gate(fn _ -> {:error, :enoent} end)

    generate!(f)

    refusing = fn type ->
      Ceremony.backup(
        signer: f.signer,
        ceremony: f.ceremony,
        out: f.backup,
        stdin_stat: stat.(type)
      )
    end

    assert {:error, :passphrase_stdin_is_terminal} = refusing.(:device)
    refute File.exists?(f.backup)

    assert {:error, :passphrase_unreadable} =
             Ceremony.backup(
               signer: f.signer,
               ceremony: f.ceremony,
               out: f.backup,
               stdin_stat: fn _ -> {:error, :eacces} end
             )

    backup!(f)

    assert {:error, :passphrase_stdin_is_terminal} =
             Ceremony.verify_backup(
               backup: f.backup,
               ceremony: f.ceremony,
               stdin_stat: stat.(:device)
             )
  end

  test "a passphrase is printable ASCII, 20 to 1024 characters", f do
    generate!(f)
    opts = [signer: f.signer, ceremony: f.ceremony, out: f.backup]

    for bad <- [
          "correct horse battery staple \u00F1 42",
          "correct horse battery\tstaple 42 xx",
          "correct horse battery staple 42\r",
          String.duplicate("\u00E9", 24)
        ] do
      assert {:error, :passphrase_not_ascii} =
               Ceremony.backup(opts ++ [passphrase_reader: reader([bad, bad])])
    end

    long = String.duplicate("a", 1025)

    assert {:error, :passphrase_too_long} =
             Ceremony.backup(opts ++ [passphrase_reader: reader([long, long])])

    edge = String.duplicate("a", 19)

    assert {:error, :passphrase_too_short} =
             Ceremony.backup(opts ++ [passphrase_reader: reader([edge, edge])])

    refute File.exists?(f.backup)

    ok = String.duplicate("~ ", 10)
    assert {:ok, _} = Ceremony.backup(opts ++ [passphrase_reader: reader([ok, ok])])

    assert {:error, :passphrase_not_ascii} =
             Ceremony.verify_backup(
               backup: f.backup,
               ceremony: f.ceremony,
               passphrase_reader: reader(["caf\u00E9 caf\u00E9 caf\u00E9 caf\u00E9"])
             )
  end

  defp open_directory!(f, name, mode) do
    dir = Path.join(f.base, name)
    File.mkdir_p!(dir)
    # File.chmod drops the sticky bit, so use chmod(1) for the octal string.
    {_, 0} = System.cmd("chmod", [Integer.to_string(mode, 8), dir])
    inner = Path.join(dir, "inner")
    File.mkdir_p!(inner)
    File.chmod!(inner, 0o700)
    inner
  end

  test "every ancestor of a secret path must be unwritable by others unless sticky", f do
    inner = open_directory!(f, "open", 0o777)

    assert {:error, :unsafe_signer_directory} =
             Ceremony.generate(signer: Path.join(inner, "s.seed"), ceremony: f.ceremony)

    refute File.exists?(Path.join(inner, "s.seed"))

    generate!(f)
    opts = [signer: f.signer, ceremony: f.ceremony, passphrase_reader: passphrase_reader()]

    # Neither the backup directory nor its ancestors may be swappable by others.
    open_backups = Path.join(inner, "backups")
    File.mkdir_p!(open_backups)

    assert {:error, :backup_directory_unavailable} =
             Ceremony.backup(opts ++ [out: Path.join(open_backups, "b")])

    shared_backups = Path.join(f.base, "shared-backups")
    File.mkdir_p!(shared_backups)
    File.chmod!(shared_backups, 0o770)

    assert {:error, :backup_directory_unavailable} =
             Ceremony.backup(opts ++ [out: Path.join(shared_backups, "b")])

    refute File.exists?(Path.join(shared_backups, "b"))

    assert {:error, :ceremony_directory_invalid} =
             Ceremony.generate(
               signer: Path.join(f.keys, "other.seed"),
               ceremony: Path.join(inner, "ceremony")
             )

    sticky = open_directory!(f, "sticky", 0o1777)

    assert {:ok, _} =
             Ceremony.generate(signer: Path.join(sticky, "s.seed"), ceremony: sticky <> "-c")
  end

  test "a secret path through a symlinked parent is canonicalized before any check or write", f do
    link = Path.join(f.base, "keys-link")
    File.ln_s!(f.keys, link)
    assert {:ok, canonical} = Paths.signer(Path.join(link, "c.seed"), f.ceremony, :real)
    assert canonical == Path.join(Paths.real(f.keys), "c.seed")
  end

  test "a secret file is created exclusively, bound to its inode, and removed on failure", f do
    path = Path.join(f.keys, "made.seed")
    assert {:ok, inode} = Paths.create_private(path, fn -> "abc" end, :exists, :failed)
    assert %File.Stat{inode: ^inode, links: 1, type: :regular} = File.lstat!(path)
    assert (File.stat!(path).mode &&& 0o7777) == 0o600
    assert File.read!(path) == "abc"
    assert {:error, :exists} = Paths.create_private(path, fn -> "x" end, :exists, :failed)
    assert File.read!(path) == "abc"

    raising = Path.join(f.keys, "raising.seed")

    assert {:error, :failed} =
             Paths.create_private(raising, fn -> raise "boom" end, :exists, :failed)

    refute File.exists?(raising)

    # Only the file this call made is ever removed.
    File.write!(path, "other")
    assert :ok = Paths.remove_created(path, inode + 1)
    assert File.exists?(path)

    link = Path.join(f.keys, "link.seed")
    File.ln_s!(Path.join(f.keys, "elsewhere"), link)
    assert {:error, :exists} = Paths.create_private(link, fn -> "x" end, :exists, :failed)
    refute File.exists?(Path.join(f.keys, "elsewhere"))
  end

  test "an existing ceremony directory must be private to the operator", f do
    loose = Path.join(f.base, "loose")
    File.mkdir_p!(loose)
    File.chmod!(loose, 0o755)

    assert {:error, :ceremony_directory_invalid} =
             Ceremony.generate(signer: f.signer, ceremony: loose)

    File.chmod!(loose, 0o710)

    assert {:error, :ceremony_directory_invalid} =
             Ceremony.generate(signer: f.signer, ceremony: loose)

    refute File.exists?(f.signer)
  end

  test "artifact temporary files are exclusive and never follow a planted link", f do
    victim = Path.join(f.base, "victim.txt")
    File.write!(victim, "untouched")
    File.ln_s!(victim, Path.join(f.ceremony, ".signer.json.tmp"))

    public = generate!(f)
    assert File.read!(victim) == "untouched"
    record = Path.join(f.ceremony, "signer.json")
    assert %File.Stat{type: :regular} = File.lstat!(record)

    assert record |> File.read!() |> Jason.decode!() |> Map.get("fingerprint_sha256") ==
             public["fingerprint_sha256"]
  end

  test "generate removes the seed it just made when the public record cannot be written", f do
    assert {:error, :ceremony_write_failed} =
             Ceremony.generate(
               signer: f.signer,
               ceremony: f.ceremony,
               after_seed: fn path ->
                 assert File.regular?(path)
                 File.chmod!(f.ceremony, 0o500)
               end
             )

    File.chmod!(f.ceremony, 0o700)
    refute File.exists?(f.signer)
    refute File.exists?(Path.join(f.ceremony, "signer.json"))
    assert {:ok, _} = Ceremony.generate(signer: f.signer, ceremony: f.ceremony)
  end

  test "real mode refuses a signer record that carries a dry-run key", f do
    generate!(f)
    space = space(f)
    {_payload, record} = payload!(f, space)
    {signed, _} = sign_bootstraps(space, [record], "signed")
    path = Path.join(f.ceremony, "signer.json")
    disposable = DryRun.public_keys() |> hd()

    forged =
      path
      |> File.read!()
      |> Jason.decode!()
      |> Map.merge(Store.public_info(disposable))

    File.write!(path, Jason.encode!(forged))

    assert {:error, :disposable_test_key} =
             Ceremony.verify_binding(ceremony: f.ceremony, space_log: signed)

    assert {:error, :disposable_test_key} = report!(f)

    assert {:error, :disposable_test_key} =
             Ceremony.backup(
               signer: f.signer,
               ceremony: f.ceremony,
               out: f.backup,
               passphrase_reader: passphrase_reader()
             )
  end

  # ------------------------------------------- fresh-process (real stdin)

  # The app directory, not the umbrella root: a root-level `mix` would compile every
  # umbrella app (some need a Rust toolchain) before running the task.
  defp app_dir, do: Path.expand("../..", __DIR__)

  defp mix_task(args, stdin_script \\ nil) do
    mix = System.find_executable("mix")
    quoted = Enum.map_join(["treehouse.catalog_ceremony" | args], " ", &shell_quote/1)

    command =
      (stdin_script && stdin_script <> " | ")
      |> Kernel.||("")
      |> Kernel.<>("#{shell_quote(mix)} #{quoted}")

    System.cmd("sh", ["-c", command],
      cd: app_dir(),
      env: [{"MIX_ENV", "test"}],
      stderr_to_stdout: true
    )
  end

  defp shell_quote(text), do: "'" <> String.replace(text, "'", "'\\''") <> "'"

  @tag :fresh_process
  @tag timeout: 300_000
  test "binding-payload decodes a Space log in a fresh mix process", f do
    if System.find_executable("mix") == nil do
      IO.puts("skipped: mix is not on PATH")
    else
      generate!(f)
      # Atoms only Treehouse.Space declares: a fresh VM has not interned them yet.
      space = space(f, "fresh", [:issue_invitation, :attest_member_key_v1])

      {output, status} =
        mix_task([
          "binding-payload",
          "--ceremony",
          f.ceremony,
          "--space-log",
          space.pre,
          "--service-public-key",
          service_b64(),
          "--origin",
          @origin
        ])

      refute output =~ "invalid_space_log", output
      assert status == 0, output
      assert output =~ "binding_payload_sha256: "
      assert File.regular?(Path.join(f.ceremony, "binding-payload.json"))
    end
  end

  @tag :fresh_process
  @tag timeout: 300_000
  test "backup and verify-backup read the passphrase from a piped stdin", f do
    if System.find_executable("mix") == nil do
      IO.puts("skipped: mix is not on PATH")
    else
      generate!(f)
      pipe = "printf '%s\\n%s\\n' #{shell_quote(@passphrase)} #{shell_quote(@passphrase)}"
      once = "printf '%s\\n' #{shell_quote(@passphrase)}"

      {output, status} =
        mix_task(
          ["backup", "--signer", f.signer, "--ceremony", f.ceremony, "--out", f.backup],
          pipe
        )

      assert status == 0, output
      refute output =~ @passphrase

      {output, status} =
        mix_task(
          ["verify-backup", "--backup", f.backup, "--ceremony", f.ceremony],
          once
        )

      assert status == 0, output
      assert output =~ "ok: true"
    end
  end
end
