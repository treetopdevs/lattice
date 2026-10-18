defmodule LatticeCarrierServer.Operator.CatalogCeremony.DryRun do
  @moduledoc false
  # A complete rehearsal with labelled disposable keys: every key is the
  # SHA-256 of a public label, so nothing here is, or can become, a real key.
  # The directory carries a marker that every real-mode command refuses.

  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Authority.Delegation

  alias LatticeCarrierServer.Operator.CatalogCeremony.{
    Backup,
    Binding,
    Report,
    Signer,
    Store
  }

  alias LatticeCarrierServer.Secret

  @label "lattice-catalog-ceremony-dry-run-NOT-A-REAL-KEY"
  @passphrase "dry-run-passphrase-NOT-REAL-0000"
  @origin "wss://dry-run-relay.invalid"
  @names ~w(signer root service nominee w1 w2 w3)

  @doc "Every public key a dry run can derive; real mode refuses all of them."
  @spec public_keys() :: [binary()]
  def public_keys, do: Enum.map(@names, &(&1 |> identity() |> Map.fetch!(:pub)))

  @spec run(keyword()) :: {:ok, map()} | {:error, atom()}
  def run(opts) do
    with {:ok, dir} <- fresh_directory(opts[:ceremony]),
         {:ok, _} <- Store.write_text(dir, Store.marker(), marker_text()),
         {:ok, paths} <- layout(dir),
         {:ok, _} <-
           Signer.generate(step(dir, paths, seed: Secret.wrap(seed("signer"))), :dry_run),
         {:ok, _} <- Backup.create(step(dir, paths, passphrase_reader: reader()), :dry_run),
         {:ok, _} <- Backup.verify(step(dir, paths, passphrase_reader: reader()), :dry_run),
         {:ok, history} <- start_space(paths),
         {:ok, payload} <- Binding.payload(step(dir, paths, binding_opts(paths)), :dry_run),
         :ok <- sign_bootstrap(history, paths, payload),
         {:ok, binding} <- Binding.verify(step(dir, paths, space_log: paths.final), :dry_run),
         {:ok, report} <- Report.build(step(dir, paths, custody()), :dry_run) do
      {:ok,
       %{
         ceremony: dir,
         marker: Path.join(dir, Store.marker()),
         binding_payload_sha256: payload["sha256"],
         bootstrap_id: binding["bootstrap_id"],
         report: report.path,
         report_sha256: report.sha256
       }}
    end
  end

  defp fresh_directory(dir) when is_binary(dir) and dir != "" do
    path = Path.expand(dir)

    with :ok <- empty(path),
         :ok <- File.mkdir_p(path),
         :ok <- File.chmod(path, 0o700) do
      {:ok, path}
    else
      {:error, :ceremony_not_empty} = refusal -> refusal
      _ -> {:error, :ceremony_directory_invalid}
    end
  end

  defp fresh_directory(_), do: {:error, :ceremony_required}

  defp empty(path) do
    case File.lstat(path) do
      {:error, :enoent} -> :ok
      {:ok, %File.Stat{type: :directory}} -> listing(File.ls(path))
      _ -> {:error, :ceremony_directory_invalid}
    end
  end

  defp listing({:ok, []}), do: :ok
  defp listing(_), do: {:error, :ceremony_not_empty}

  defp layout(dir) do
    paths = %{
      signer_dir: Path.join(dir, "disposable-signer"),
      backup_dir: Path.join(dir, "disposable-backup"),
      restore_dir: Path.join(dir, "disposable-restore"),
      pre: Path.join(dir, "disposable-space-pre.log"),
      final: Path.join(dir, "disposable-space.log")
    }

    for key <- [:signer_dir, :backup_dir, :restore_dir] do
      File.mkdir_p!(paths[key])
      File.chmod!(paths[key], 0o700)
    end

    {:ok,
     Map.merge(paths, %{
       signer: Path.join(paths.signer_dir, "signer.seed"),
       backup: Path.join(paths.backup_dir, "signer.backup"),
       restored: Path.join(paths.restore_dir, "signer.seed")
     })}
  end

  defp step(dir, paths, extra) do
    Keyword.merge(
      [
        ceremony: dir,
        signer: paths.signer,
        out: paths.backup,
        backup: paths.backup,
        restore_to: paths.restored
      ],
      extra
    )
  end

  defp reader, do: fn -> {:ok, @passphrase} end

  defp binding_opts(paths) do
    [
      space_log: paths.pre,
      service_public_key: Base.encode64(identity("service").pub),
      origin: @origin
    ]
  end

  defp custody do
    [
      custodian: "dry-run-custodian",
      passphrase_holder: "dry-run-passphrase-holder",
      rotation_owner: "dry-run-rotation-owner"
    ]
  end

  defp marker_text do
    "This directory is a catalog-ceremony DRY RUN. Every key in it is derived from a public label " <>
      "and is NOT a real key. Real-mode commands refuse this directory.\n"
  end

  # The disposable root signs the bootstrap; the tool never does in real mode.
  defp start_space(paths) do
    history = history()
    with :ok <- dump(history.before, paths.pre), do: {:ok, history}
  end

  defp sign_bootstrap(history, paths, payload) do
    with {:ok, record} <- Binding.from_json(payload["record"]) do
      bootstrap =
        Op.new(
          history.root,
          history.replica,
          [history.pin.id],
          :command,
          {:catalog_bootstrap_v1, [record]},
          cap: history.delegation.id
        )

      dump(Log.append!(history.before, bootstrap), paths.final)
    end
  end

  defp dump(log, path), do: Log.dump(log, path)

  @doc "The disposable bounded-continuation Space before any bootstrap, with its pieces."
  @spec history() :: map()
  def history do
    root = identity("root")
    nominee = identity("nominee")
    witnesses = for n <- 1..3, do: identity("w#{n}")

    replica =
      Authority.bind_replica(
        "replica:treehouse:space:" <> id("space") <> "#authority:bounded-continuation-v1",
        root.pub
      )

    delegation =
      Delegation.genesis(root, replica,
        ops: [:create_space, :create_thread, :catalog_bootstrap_v1, :replace_catalog_v1],
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

    before = Enum.reduce([genesis, creation, pin], Log.new(replica), &Log.append!(&2, &1))
    %{root: root, replica: replica, delegation: delegation, pin: pin, before: before}
  end

  defp id(label),
    do: :crypto.hash(:sha256, @label <> "-" <> label) |> Base.url_encode64(padding: false)

  defp seed(name), do: :crypto.hash(:sha256, @label <> ":" <> name)

  defp identity(name) do
    {pub, priv} = :crypto.generate_key(:eddsa, :ed25519, seed(name))
    %Identity{realm_id: name, pub: pub, priv: priv}
  end
end
