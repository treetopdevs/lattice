defmodule LatticeCarrierServer.Operator.CeremonyFixture do
  @moduledoc false
  # A complete REAL ceremony directory plus the signed Space log it binds, built
  # through the public CatalogCeremony commands. The test, never the tool, signs
  # the bootstrap; every key is random.

  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Authority.{ContinuationCertificate, Delegation}
  alias LatticeCarrierServer.Operator.CatalogCeremony, as: Ceremony
  alias LatticeCarrierServer.Operator.CatalogCeremony.Binding

  @passphrase "correct horse battery staple 42"
  @origin "wss://relay.example.test"

  @doc "The origin every fixture binds."
  def origin, do: @origin

  @doc "A deterministic valid 43-character identifier."
  def id(label),
    do: :crypto.hash(:sha256, "ceremony-test-" <> label) |> Base.url_encode64(padding: false)

  def random_pub, do: elem(:crypto.generate_key(:eddsa, :ed25519), 0)

  def reader(lines) do
    {:ok, agent} = Agent.start_link(fn -> lines end)

    fn ->
      Agent.get_and_update(agent, fn
        [line | rest] -> {{:ok, line}, rest}
        [] -> {:error, []}
      end)
    end
  end

  @doc """
  The expensive, Space-independent part of a real ceremony (generate, backup,
  verify-backup, separate-host attestation), built once per VM and copied per
  use. Returns the template's directories and signer/backup paths.
  """
  @spec signer_template() :: map()
  def signer_template do
    key = {__MODULE__, :signer_template}

    case :persistent_term.get(key, nil) do
      nil ->
        :global.trans({key, self()}, fn ->
          case :persistent_term.get(key, nil) do
            nil ->
              template = build_signer_template()
              :persistent_term.put(key, template)
              template

            template ->
              template
          end
        end)

      template ->
        template
    end
  end

  defp build_signer_template do
    base =
      Path.join(
        System.tmp_dir!(),
        "ceremony-signer-template-#{System.unique_integer([:positive])}-#{System.os_time()}"
      )

    File.mkdir_p!(base)
    File.chmod!(base, 0o700)
    System.at_exit(fn _ -> File.rm_rf(base) end)

    dirs =
      for name <- ~w(ceremony keys backups restore space), into: %{} do
        dir = Path.join(base, name)
        File.mkdir_p!(dir)
        File.chmod!(dir, 0o700)
        {String.to_atom(name), dir}
      end

    f =
      Map.merge(dirs, %{
        base: base,
        signer: Path.join(dirs.keys, "signer.seed"),
        backup: Path.join(dirs.backups, "signer.backup")
      })

    {:ok, _} = Ceremony.generate(signer: f.signer, ceremony: f.ceremony)

    {:ok, _} =
      Ceremony.backup(
        signer: f.signer,
        ceremony: f.ceremony,
        out: f.backup,
        passphrase_reader: reader([@passphrase, @passphrase])
      )

    {:ok, _} =
      Ceremony.verify_backup(
        backup: f.backup,
        ceremony: f.ceremony,
        passphrase_reader: reader([@passphrase])
      )

    separate_host!(f.ceremony)
    f
  end

  @doc """
  A private copy of the signer part's ceremony directory at `dest` (created
  0700), holding the signer record, backup record and restore proof only. The
  caller adds the binding part with `bind/4`.
  """
  @spec copy_ceremony(Path.t()) :: Path.t()
  def copy_ceremony(dest) do
    File.cp_r!(signer_template().ceremony, dest)
    File.chmod!(dest, 0o700)
    dest
  end

  @doc """
  The cheap per-test binding part: the payload over `pre_log` (a bounded Space
  log carrying its pin) for `service_pub`, the record the Space root signs through
  `sign.(record)` (returning `{signed_log_path, extra}`), verify-binding over
  that signed log, and the report.
  """
  @spec bind(Path.t(), Path.t(), binary(), (map() -> {Path.t(), term()})) :: map()
  def bind(ceremony, pre_log, service_pub, sign) do
    {:ok, payload} =
      Ceremony.binding_payload(
        ceremony: ceremony,
        space_log: pre_log,
        service_public_key: Base.encode64(service_pub),
        service_id: id("operator-service"),
        origin: @origin
      )

    {:ok, record} = Binding.from_json(payload["record"])
    {signed, extra} = sign.(record)
    {:ok, binding} = Ceremony.verify_binding(ceremony: ceremony, space_log: signed)
    {:ok, _} = report(ceremony)
    %{payload: payload, record: record, binding: binding, signed: signed, extra: extra}
  end

  @doc """
  Build a complete real ceremony under `base` (created 0700): generate, backup,
  verify-backup, separate-host attestation, payload, root-signed bootstrap,
  verify-binding, report. Returns the paths, the Space, the record and the op.
  The signer part is copied from the once-per-run template.
  """
  @spec build(Path.t(), keyword()) :: map()
  def build(base, opts \\ []) do
    template = signer_template()
    File.cp_r!(template.base, base)
    File.chmod!(base, 0o700)

    dirs =
      for name <- ~w(ceremony keys backups restore space), into: %{} do
        dir = Path.join(base, name)
        File.chmod!(dir, 0o700)
        {String.to_atom(name), dir}
      end

    f =
      Map.merge(dirs, %{
        base: base,
        signer: Path.join(dirs.keys, "signer.seed"),
        backup: Path.join(dirs.backups, "signer.backup")
      })

    space = space(f.space)

    {:ok, payload} =
      Ceremony.binding_payload(
        ceremony: f.ceremony,
        space_log: space.pre,
        service_public_key:
          Keyword.get_lazy(opts, :service_key, fn -> Base.encode64(random_pub()) end),
        origin: @origin
      )

    {:ok, record} = Binding.from_json(payload["record"])
    {signed, [op]} = sign_bootstraps(space, [record], "signed")
    {:ok, binding} = Ceremony.verify_binding(ceremony: f.ceremony, space_log: signed)
    {:ok, _} = report(f.ceremony)

    Map.merge(f, %{
      space: space,
      space_dir: f.space,
      payload: payload,
      record: record,
      op: op,
      binding: binding,
      signed: signed
    })
  end

  @doc "Write (or rewrite) the verification report with the fixture's custody names."
  def report(ceremony, extra \\ []) do
    Ceremony.report(
      Keyword.merge(
        [
          ceremony: ceremony,
          custodian: "Ada",
          passphrase_holder: "Grace",
          rotation_owner: "Linus"
        ],
        extra
      )
    )
  end

  # Separateness is hostname-based; a one-host run flips it as an operator would attest.
  def separate_host!(ceremony) do
    path = Path.join(ceremony, "restore.json")

    record =
      path
      |> File.read!()
      |> Jason.decode!()
      |> Map.merge(%{"host" => "second-machine.invalid", "separate_host" => true})

    File.write!(path, Jason.encode!(record))
  end

  @doc "A disposable bounded Space with RANDOM keys, dumped under `dir`."
  def space(dir, name \\ "pre", extra_ops \\ []) do
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
    path = Path.join(dir, name <> ".log")
    :ok = Log.dump(before, path)
    %{root: root, replica: replica, delegation: delegation, pin: pin, before: before, pre: path}
  end

  @doc "The Space log with each record authored by the root as a bootstrap, dumped as `name`."
  def sign_bootstraps(space, records, name) do
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
end
