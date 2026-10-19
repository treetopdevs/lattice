defmodule LatticeCarrierServer.Operator.CatalogCeremonySpaceExportTest do
  use ExUnit.Case, async: false

  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Authority.{ContinuationCertificate, Delegation}
  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.Operator.CatalogCeremony, as: Ceremony
  alias LatticeCarrierServer.Operator.CatalogCeremony.{Binding, DryRun, SpaceExport}

  @origin "wss://relay.example.test"
  @fixture Path.expand(
             "../../../../clients/treehouse-tauri-shell/test/fixtures/space_frames_export_v1.json",
             __DIR__
           )

  setup do
    base = Path.join(System.tmp_dir!(), "space-export-#{System.unique_integer([:positive])}")
    ceremony = Path.join(base, "ceremony")
    keys = Path.join(base, "keys")
    for dir <- [base, ceremony, keys], do: File.mkdir_p!(dir) && File.chmod!(dir, 0o700)
    on_exit(fn -> File.rm_rf(base) end)

    signer = Path.join(keys, "signer.seed")
    {:ok, _} = Ceremony.generate(signer: signer, ceremony: ceremony)
    {:ok, %{base: base, ceremony: ceremony}}
  end

  # ---------------------------------------------------------------- helpers

  defp random_pub, do: elem(:crypto.generate_key(:eddsa, :ed25519), 0)
  defp uid, do: :crypto.strong_rand_bytes(32) |> Base.url_encode64(padding: false)

  defp space(second? \\ false) do
    root = Identity.generate("root")
    nominee = Identity.generate("nominee")
    witnesses = for n <- 1..3, do: Identity.generate("w#{n}")

    replica =
      Authority.bind_replica(
        "replica:treehouse:space:" <> uid() <> "#authority:bounded-continuation-v1",
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

    {:ok, _} = ContinuationCertificate.profile_id(profile)

    %{
      root: root,
      replica: replica,
      delegation: delegation,
      pin: pin,
      before: Enum.reduce([genesis, creation, pin], Log.new(replica), &Log.append!(&2, &1)),
      second?: second?
    }
  end

  defp sign(space, record) do
    op =
      Op.new(
        space.root,
        space.replica,
        [space.pin.id],
        :command,
        {:catalog_bootstrap_v1, [record]},
        cap: space.delegation.id
      )

    Log.append!(space.before, op)
  end

  # Compact JSON with recursively sorted keys: the export's canonical form.
  defp canon(%{} = map) do
    body =
      map
      |> Enum.sort_by(&elem(&1, 0))
      |> Enum.map_join(",", fn {k, v} -> Jason.encode!(k) <> ":" <> canon(v) end)

    "{" <> body <> "}"
  end

  defp canon(list) when is_list(list), do: "[" <> Enum.map_join(list, ",", &canon/1) <> "]"
  defp canon(v), do: Jason.encode!(v)

  defp doc(space),
    do: space.before |> then(&SpaceExport.encode(&1, space.root.pub)) |> Jason.decode!()

  defp write!(f, name, bytes) do
    path = Path.join(f.base, name)
    File.write!(path, bytes)
    path
  end

  defp args(f, path, extra \\ []) do
    Keyword.merge(
      [
        ceremony: f.ceremony,
        space_log: path,
        service_public_key: Base.encode64(random_pub()),
        origin: @origin
      ],
      extra
    )
  end

  defp record_of(payload) do
    {:ok, record} = Binding.from_json(payload["record"])
    record
  end

  # ------------------------------------------------------------ equivalence

  test "an export loads to the same Log as the dump and gives identical ceremony verdicts", f do
    space = space()
    service = Base.encode64(random_pub())
    service_id = uid()

    pre_dump = write!(f, "pre.log", "")
    :ok = Log.dump(space.before, pre_dump)
    pre_export = write!(f, "pre.frames.json", SpaceExport.encode(space.before, space.root.pub))

    {:ok, %{log: restored}} = Log.restore_verified(pre_dump)
    assert {:ok, ^restored} = SpaceExport.load(pre_export)

    common = [service_public_key: service, service_id: service_id]
    assert {:ok, from_dump} = Ceremony.binding_payload(args(f, pre_dump, common))
    assert {:ok, from_export} = Ceremony.binding_payload(args(f, pre_export, common))

    no_nonce = &Map.delete(record_of(&1), :nonce)
    assert no_nonce.(from_dump) == no_nonce.(from_export)

    # Verify against the latest payload (its nonce) with both file forms.
    signed = sign(space, record_of(from_export))
    final_dump = write!(f, "final.log", "")
    :ok = Log.dump(signed, final_dump)
    final_export = write!(f, "final.frames.json", SpaceExport.encode(signed, space.root.pub))

    assert {:ok, a} = Ceremony.verify_binding(ceremony: f.ceremony, space_log: final_dump)
    assert {:ok, b} = Ceremony.verify_binding(ceremony: f.ceremony, space_log: final_export)

    assert Map.take(a, ~w(bootstrap_id record_sha256 space)) ==
             Map.take(b, ~w(bootstrap_id record_sha256 space))

    assert b["record_sha256"] == from_export["sha256"]
  end

  test "a retained competing genesis from another author does not poison the export (Codex row 234 /2)",
       f do
    space = space()
    attacker = Identity.generate("attacker")

    delegation =
      Delegation.genesis(attacker, space.replica, ops: [:create_space], roles: [:admin])

    rival = Op.new(attacker, space.replica, [], :authority, {:genesis, delegation, %{}})
    log = Log.append!(space.before, rival)

    dump = write!(f, "rival.log", "")
    :ok = Log.dump(log, dump)
    export = write!(f, "rival.frames.json", SpaceExport.encode(log, space.root.pub))

    common = [service_public_key: Base.encode64(random_pub()), service_id: uid()]
    assert {:ok, _} = Ceremony.binding_payload(args(f, dump, common))
    assert {:ok, _} = Ceremony.binding_payload(args(f, export, common))

    # A declared root that authored no genesis is still refused.
    other = write!(f, "other.frames.json", SpaceExport.encode(log, random_pub()))
    assert {:error, :invalid_space_log} = Ceremony.binding_payload(args(f, other, common))
  end

  test "the dry-run history round-trips through encode and load" do
    %{before: log, root: root} = DryRun.history()
    path = Path.join(System.tmp_dir!(), "dry-#{System.unique_integer([:positive])}.json")
    File.write!(path, SpaceExport.encode(log, root.pub))
    on_exit(fn -> File.rm(path) end)
    assert {:ok, loaded} = SpaceExport.load(path)
    assert loaded == elem(Log.restore_verified(dump_of(log)), 1).log
  end

  defp dump_of(log) do
    path = Path.join(System.tmp_dir!(), "dry-#{System.unique_integer([:positive])}.log")
    :ok = Log.dump(log, path)
    path
  end

  # ---------------------------------------------------------------- refusals

  defp refused!(f, name, bytes_or_path) do
    path = if File.exists?(bytes_or_path), do: bytes_or_path, else: write!(f, name, bytes_or_path)

    assert {:error, :invalid_space_log} = Ceremony.binding_payload(args(f, path)), name

    # verify-binding reads through the same reader, after a valid payload exists.
    good = write!(f, "good-#{name}.json", SpaceExport.encode(f.space.before, f.space.root.pub))
    assert {:ok, _} = Ceremony.binding_payload(args(f, good))

    assert {:error, :invalid_space_log} =
             Ceremony.verify_binding(ceremony: f.ceremony, space_log: path),
           name
  end

  setup f do
    {:ok, Map.put(f, :space, space())}
  end

  defp with_frames(f, fun) do
    d = doc(f.space)
    canon(Map.update!(d, "frames", fun))
  end

  defp swap_sig(frame) do
    <<first, rest::binary>> = Base.decode64!(frame["sig"])
    Map.put(frame, "sig", Base.encode64(<<Bitwise.bxor(first, 1), rest::binary>>))
  end

  test "the good export is accepted (baseline for the refusals)", f do
    assert canon(doc(f.space)) == SpaceExport.encode(f.space.before, f.space.root.pub)
    path = write!(f, "ok.json", canon(doc(f.space)))
    assert {:ok, _} = Ceremony.binding_payload(args(f, path))
  end

  test("forged signature", f,
    do: refused!(f, "forged", with_frames(f, fn [a | rest] -> [swap_sig(a) | rest] end))
  )

  test "tampered body with the original signature", f do
    bytes = String.replace(canon(doc(f.space)), Base.encode64("Canopy"), Base.encode64("Hacked"))
    refute bytes == canon(doc(f.space))
    refused!(f, "tampered", bytes)
  end

  test "truncated file", f do
    bytes = canon(doc(f.space))
    refused!(f, "truncated", binary_part(bytes, 0, div(byte_size(bytes), 2)))
  end

  test "missing dependency (genesis frame dropped)", f do
    genesis_id =
      f.space.before.ops |> Map.values() |> Enum.find(&(&1.deps == [])) |> Map.fetch!(:id)

    refused!(f, "nodep", with_frames(f, fn fr -> Enum.reject(fr, &(&1["id"] == genesis_id)) end))
  end

  test "frame from a second Space with the same root", f do
    other = Op.new(f.space.root, "replica:treehouse:space:other", [], :command, {:noop, []})
    frames = fn fr -> Enum.sort_by(fr ++ [Wire.encode_op(other)], & &1["id"]) end
    refused!(f, "mixed", with_frames(f, frames))
  end

  test "duplicated frame", f do
    refused!(f, "dup", with_frames(f, fn [a | rest] -> [a, a | rest] end))
  end

  test("unsorted frames", f, do: refused!(f, "unsorted", with_frames(f, &Enum.reverse/1)))

  test "extra top-level key", f do
    refused!(f, "extra-top", canon(Map.put(doc(f.space), "extra", 1)))
  end

  test "extra frame key", f do
    refused!(f, "extra-frame", with_frames(f, fn [a | r] -> [Map.put(a, "x", 1) | r] end))
  end

  test "wrong format string", f do
    refused!(
      f,
      "format",
      canon(Map.put(doc(f.space), "format", "lattice-space-frames-export-v2"))
    )
  end

  test "declared root differs from the profile root", f do
    refused!(f, "root", canon(Map.put(doc(f.space), "root", Base.encode64(random_pub()))))
  end

  test "non-canonical file encoding", f do
    refused!(f, "pretty", Jason.encode!(doc(f.space), pretty: true))
  end

  test "oversize file", f do
    refused!(f, "big", "{" <> String.duplicate(" ", 16 * 1024 * 1024 + 1))
  end

  test("empty frames", f, do: refused!(f, "empty", with_frames(f, fn _ -> [] end)))

  test "a directory is not an export", f do
    dir = Path.join(f.base, "adir")
    File.mkdir_p!(dir)
    refused!(f, "dir", dir)
  end

  # ------------------------------------------------------------ app parity

  test "the app's committed export fixture loads and re-encodes byte for byte" do
    bytes = File.read!(@fixture)
    assert {:ok, log} = SpaceExport.load(@fixture)
    root = bytes |> Jason.decode!() |> Map.fetch!("root") |> Base.decode64!()
    assert SpaceExport.encode(log, root) == bytes
  end
end
