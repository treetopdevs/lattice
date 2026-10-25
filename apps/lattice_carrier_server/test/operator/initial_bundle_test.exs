defmodule LatticeCarrierServer.Operator.InitialBundleTest do
  use ExUnit.Case, async: false
  alias Lattice.Sim
  alias LatticeCarrierServer.Operator.{Fixture, InitialBundle}

  setup do
    {:ok, f} = Fixture.new(second_member: true)
    child = Sim.log(f[:child], "creator")
    {:ok, %{bootstraps: [bootstrap]}} = Treehouse.CatalogBootstrap.observe(f[:updated_log])
    bytes = InitialBundle.encode(f[:updated_log], child, bootstrap.id, f[:reference].id)
    {:ok, bytes: bytes, fixture: f, child: child}
  end

  test "complete histories derive the roster, direct child grants and reference", f do
    assert {:ok, verified} = InitialBundle.decode(f.bytes)
    assert verified.space == f.fixture[:updated_log]
    assert verified.child == f.child
    assert length(verified.roster) == 2
    assert verified.reference.id == f.fixture[:reference].id
    expected_review = hd(f.fixture[:artifacts]).review

    expected_review =
      Map.update!(expected_review, "grants", &Enum.sort_by(&1, fn g -> g["recipient"] end))

    assert verified.child_review == expected_review

    assert InitialBundle.encode(
             verified.space,
             verified.child,
             verified.bootstrap.id,
             verified.reference.id
           ) == f.bytes
  end

  test "closed canonical format refuses alternative spelling and ambiguous fields", f do
    assert {:error, :invalid_initial_bundle} = InitialBundle.decode("\n" <> f.bytes)

    duplicate =
      ~s({"format":"treehouse-initial-provisioning-v1",) <>
        binary_part(f.bytes, 1, byte_size(f.bytes) - 1)

    assert {:error, :invalid_initial_bundle} = InitialBundle.decode(duplicate)

    for field <- ["privateKey", "routes", "outbox", "trusted", "state"] do
      assert {:error, :invalid_initial_bundle} =
               f.bytes
               |> JSON.decode!()
               |> Map.put(field, "forbidden")
               |> InitialBundle.canonical()
               |> InitialBundle.decode()
    end

    assert {:error, :invalid_initial_bundle} = InitialBundle.decode(<<255>>)

    assert {:error, :invalid_initial_bundle} =
             InitialBundle.decode(:binary.copy(" ", 2 * 1024 * 1024 + 1))
  end

  test "wrong root, bootstrap, reference, signatures and dependencies refuse", f do
    doc = JSON.decode!(f.bytes)
    space = hd(doc["profiles"])
    genesis = Enum.find(space["frames"], &(&1["kind"] == "authority" and &1["deps"] == []))

    changed_profiles = fn frames ->
      [%{space | "frames" => frames}, List.last(doc["profiles"])]
    end

    frames = space["frames"]
    broken = List.update_at(frames, 0, &Map.put(&1, "sig", Base.encode64(<<0::512>>)))

    mutations = [
      Map.put(doc, "spaceRoot", Base.encode64(<<0::256>>)),
      Map.put(doc, "bootstrapId", genesis["id"]),
      Map.put(doc, "referenceId", genesis["id"]),
      Map.put(doc, "profiles", changed_profiles.(broken)),
      Map.put(
        doc,
        "profiles",
        changed_profiles.(Enum.reject(frames, &(&1["id"] == genesis["id"])))
      ),
      Map.put(doc, "profiles", changed_profiles.(Enum.sort_by([hd(frames) | frames], & &1["id"])))
    ]

    for mutation <- mutations do
      assert {:error, :invalid_initial_bundle} =
               mutation |> InitialBundle.canonical() |> InitialBundle.decode()
    end
  end

  test "revoked historical child authority cannot become a sealed import", f do
    {changed, grant} =
      Sim.grant(f.fixture[:child], "creator", "nominee", ops: [:post], expires_epoch: 7)

    {changed, _} = Sim.revoke(changed, "creator", grant.id)
    child = Sim.log(changed, "creator")
    assert Lattice.Authority.analyze(Treehouse.Thread, child).reasons == %{}
    {:ok, verified} = InitialBundle.decode(f.bytes)

    bytes =
      InitialBundle.encode(verified.space, child, verified.bootstrap.id, verified.reference.id)

    assert {:error, :invalid_initial_bundle} = InitialBundle.decode(bytes)
  end

  test "a pin with an unreviewed beacon policy refuses before import", _f do
    {:ok, hostile} = Fixture.new(second_member: true, pin_beacon: {:max_epoch_step, 65_535})
    child = Sim.log(hostile[:child], "creator")
    {:ok, %{bootstraps: [bootstrap]}} = Treehouse.CatalogBootstrap.observe(hostile[:updated_log])

    bytes =
      InitialBundle.encode(hostile[:updated_log], child, bootstrap.id, hostile[:reference].id)

    assert {:error, :invalid_initial_bundle} = InitialBundle.decode(bytes)
  end

  test "a root-authored Space tombstone refuses the initial bundle", f do
    space = f.fixture[:updated_log]
    owner = Sim.identity(f.fixture[:space], "creator")
    target = f.fixture[:reference].id
    tombstone = Lattice.Op.new(owner, space.replica, [target], :tombstone, {:delete, target})
    changed = Lattice.Log.append!(space, tombstone)
    assert Lattice.Authority.tombstoned?(changed)
    {:ok, verified} = InitialBundle.decode(f.bytes)
    bytes = InitialBundle.encode(changed, f.child, verified.bootstrap.id, verified.reference.id)
    assert {:error, :invalid_initial_bundle} = InitialBundle.decode(bytes)
  end

  test "load refuses a symlink and preserves its public source", f do
    root = f.fixture[:root]
    source = Path.join(root, "bundle.json")
    link = Path.join(root, "bundle-link.json")
    File.write!(source, f.bytes)
    File.ln_s!(source, link)
    assert {:ok, _} = InitialBundle.load(source)
    assert {:error, :invalid_initial_bundle} = InitialBundle.load(link)
    assert File.read!(source) == f.bytes
  end
end
