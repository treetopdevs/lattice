defmodule Treehouse.BoundedSpaceCreationTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Identity, Log}
  alias Treehouse.{BoundedSpaceVectors, CatalogBootstrap, Space}

  @nonce Base.url_encode64(:crypto.hash(:sha256, "bounded-test-nonce"), padding: false)
  @nonce_replica "replica:treehouse:space:" <> @nonce

  defp ident(name), do: Identity.from_seed(name, "bounded-space-test-" <> name)

  defp created(root \\ ident("root")) do
    {:ok, %{replica: replica, pending: pending} = prepared} =
      Space.prepare_bounded_creation(root, @nonce_replica, "Canopy")

    log = Enum.reduce(pending, Log.new(replica), &Log.append!(&2, &1))
    {prepared, log}
  end

  defp params,
    do: %{
      nominee: ident("nominee").pub,
      witnesses: for(n <- ~w(w1 w2 w3), do: ident(n).pub),
      threshold: 2,
      max_lease_epochs: 7
    }

  defp pinned do
    root = ident("root")
    {_, log} = created(root)
    {:ok, pin} = Space.prepare_continuation_pin(root, log, params())
    {root, Log.append!(log, pin), pin}
  end

  defp record(root, log, pin) do
    {:ok, observed} = Authority.continuation_profile(log)

    %{
      version: 1,
      product: :treehouse,
      space: log.replica,
      space_root: root.pub,
      profile_genesis: pin.id,
      profile_id: observed.profile_id,
      replacement_rule: :bounded_space_admin_v1,
      catalog_key: ident("catalog").pub,
      service_id: @nonce,
      service_key: ident("service").pub,
      origin: "wss://relay.invalid",
      nonce: @nonce
    }
  end

  describe "prepare_bounded_creation/4" do
    test "creates an honored bounded-family Space with the full final op set" do
      {prepared, log} = created()
      assert prepared.profile == :bounded_root_only
      assert prepared.status == :uninitialized
      assert String.starts_with?(prepared.replica, @nonce_replica <> "#authority:bounded-")
      assert Lattice.Authority.Continuation.family(prepared.replica) == {:bounded, :space}
      assert Space.initialization(log) == :ready
      assert Authority.analyze(Space, log).reasons == %{}
      assert Lattice.state(Space, log).name == "Canopy"
      [%{body: {:genesis, d, _}} | _] = prepared.pending
      assert :replace_catalog_v1 in d.ops and :catalog_bootstrap_v1 in d.ops
      assert :attest_member_key_v1 in d.ops
    end

    test "refuses anything but the exact nonce replica grammar" do
      root = ident("root")

      for bad <- [
            "replica:treehouse:space:short",
            "replica:treehouse:thread:" <> @nonce,
            @nonce_replica <> "#root:" <> @nonce,
            @nonce_replica <> "#authority:bounded-continuation-v1",
            "treehouse:legacy"
          ] do
        assert Space.prepare_bounded_creation(root, bad, "Canopy") == {:error, :invalid_replica}
      end
    end

    test "retained-log semantics match the legacy preparation" do
      root = ident("root")
      {prepared, log} = created(root)

      assert {:ok, %{pending: [], status: :ready}} =
               Space.prepare_bounded_creation(root, @nonce_replica, "Canopy", log)

      assert {:ok, %{pending: [_, _]}} =
               Space.prepare_bounded_creation(
                 root,
                 @nonce_replica,
                 "Canopy",
                 Log.new(prepared.replica)
               )

      assert {:error, :wrong_replica} =
               Space.prepare_bounded_creation(root, @nonce_replica, "Canopy", Log.new("other"))

      assert {:error, :different_initialization} =
               Space.prepare_bounded_creation(root, @nonce_replica, "Other name", log)

      assert {:error, :wrong_root} =
               Space.prepare_bounded_creation(ident("other"), @nonce_replica, "Canopy", log)
               |> wrong()
    end
  end

  # A different identity binds a different replica, so its retained log is a wrong_replica.
  defp wrong({:error, reason}) when reason in [:wrong_root, :wrong_replica],
    do: {:error, :wrong_root}

  describe "prepare_continuation_pin/3" do
    test "pins a space profile and continuation_profile/1 observes it" do
      {_root, log, pin} = pinned()
      assert Authority.analyze(Space, log).reasons == %{}

      assert {:ok, %{profile: %{kind: :space}, profile_genesis: id}} =
               Authority.continuation_profile(log)

      assert id == pin.id
    end

    test "before the pin the profile is not configured" do
      {_, log} = created()
      assert {:error, :continuation_not_configured} = Authority.continuation_profile(log)
    end

    test "refusals" do
      root = ident("root")
      {_, log} = created(root)
      p = params()

      assert {:error, :not_root} = Space.prepare_continuation_pin(ident("x"), log, p)

      assert {:error, :invalid_continuation_profile} =
               Space.prepare_continuation_pin(root, log, %{p | threshold: 9})

      assert {:error, :invalid_continuation_profile} =
               Space.prepare_continuation_pin(root, log, %{p | max_lease_epochs: 0})

      assert {:error, :nominee_is_root} =
               Space.prepare_continuation_pin(root, log, %{p | nominee: root.pub})

      assert {:error, :witness_is_root} =
               Space.prepare_continuation_pin(root, log, %{
                 p
                 | witnesses: [root.pub | p.witnesses]
               })

      assert {:error, :witness_is_nominee} =
               Space.prepare_continuation_pin(root, log, %{
                 p
                 | witnesses: [p.nominee | tl(p.witnesses)]
               })

      assert {:error, :space_not_ready} =
               Space.prepare_continuation_pin(root, Log.new(log.replica), p)

      legacy = legacy_log(root)
      assert {:error, :not_bounded_space} = Space.prepare_continuation_pin(root, legacy, p)
    end
  end

  describe "author_catalog_bootstrap/3" do
    test "is honored, depends on the pin, and is one-time" do
      {root, log, pin} = pinned()
      rec = record(root, log, pin)
      assert {:ok, op} = Space.author_catalog_bootstrap(root, log, rec)
      assert pin.id in op.deps
      log2 = Log.append!(log, op)
      assert Authority.analyze(Space, log2).reasons == %{}
      assert Lattice.state(Space, log2).admin_actions == "catalog_bootstrap_v1"
      assert {:ok, %{bootstraps: [%{id: id}]}} = CatalogBootstrap.observe(log2)
      assert id == op.id

      assert {:error, :catalog_bootstrap_exists} =
               Space.author_catalog_bootstrap(root, log2, rec)
    end

    test "refusals" do
      {root, log, pin} = pinned()
      rec = record(root, log, pin)

      assert {:error, :not_root} = Space.author_catalog_bootstrap(ident("x"), log, rec)

      assert {:error, :invalid_catalog_bootstrap} =
               Space.author_catalog_bootstrap(root, log, %{rec | origin: "nope"})

      for bad <- [
            %{rec | space: "elsewhere"},
            %{rec | space_root: ident("x").pub},
            %{rec | profile_genesis: @nonce},
            %{rec | profile_id: @nonce}
          ] do
        assert {:error, :binding_mismatch} = Space.author_catalog_bootstrap(root, log, bad)
      end

      assert {:error, :invalid_catalog_bootstrap} =
               Space.author_catalog_bootstrap(root, log, %{rec | replacement_rule: :other})

      {_, unpinned} = created(root)

      assert {:error, :continuation_not_configured} =
               Space.author_catalog_bootstrap(root, unpinned, rec)
    end
  end

  describe "PR review: retained mature history" do
    test "a retained history with the pin and bootstrap resumes; a competing genesis still refuses" do
      {root, log, pin} = pinned()
      {:ok, boot} = Space.author_catalog_bootstrap(root, log, record(root, log, pin))
      mature = Log.append!(log, boot)

      for retained <- [log, mature] do
        assert {:ok, %{pending: [], status: :ready}} =
                 Space.prepare_bounded_creation(root, @nonce_replica, "Canopy", retained)
      end

      rival =
        Lattice.Authority.Delegation.genesis(root, log.replica,
          ops: [:create_space],
          roles: [:admin]
        )

      competing =
        Log.append!(
          mature,
          Lattice.Op.new(root, log.replica, [], :authority, {:genesis, rival, %{}})
        )

      assert {:error, :different_initialization} =
               Space.prepare_bounded_creation(root, @nonce_replica, "Canopy", competing)
    end
  end

  describe "PR review: honored-only bootstrap and exact pin exemption" do
    test "a revoked root capability yields no bootstrap" do
      {root, log, pin} = pinned()
      rec = record(root, log, pin)
      {:ok, ok} = Space.author_catalog_bootstrap(root, log, rec)
      revoked = Log.append!(log, Space.revoke_grant(root, log, ok.cap))

      assert {:error, :bootstrap_not_honored} =
               Space.author_catalog_bootstrap(root, revoked, rec)
    end

    test "an empty root genesis with a Thread profile is still a competing initialization" do
      {root, log, _pin} = pinned()

      empty =
        Lattice.Authority.Delegation.genesis(root, log.replica, ops: [], roles: [], live: false)

      thread_profile =
        Map.merge(Map.put(params(), :witnesses, Enum.sort(params().witnesses)), %{
          mode: :bounded_continuation,
          version: 1,
          product: :treehouse,
          kind: :thread,
          role: :moderator
        })

      odd =
        Lattice.Op.new(root, log.replica, Log.frontier(log), :authority, {
          :genesis,
          empty,
          %{__continuation__: thread_profile}
        })

      assert {:error, :different_initialization} =
               Space.prepare_bounded_creation(
                 root,
                 @nonce_replica,
                 "Canopy",
                 Log.append!(log, odd)
               )
    end
  end

  describe "PR review: capability selection" do
    test "a root admin genesis without catalog_bootstrap_v1 is never the bootstrap cap" do
      {root, log, pin} = pinned()
      rec = record(root, log, pin)
      {:ok, original} = Space.author_catalog_bootstrap(root, log, rec)

      for n <- 1..8 do
        restricted =
          Lattice.Authority.Delegation.genesis(root, log.replica,
            ops: [:create_space] ++ List.duplicate(:create_thread, rem(n, 2)),
            roles: [:admin],
            live: n > 4
          )

        extra = Lattice.Op.new(root, log.replica, [], :authority, {:genesis, restricted, %{}})
        widened = Log.append!(log, extra)
        assert {:ok, op} = Space.author_catalog_bootstrap(root, widened, rec)
        assert op.cap == original.cap
        refute Map.has_key?(Authority.analyze(Space, Log.append!(widened, op)).reasons, op.id)
      end
    end
  end

  describe "review findings" do
    defp unsigned(log) do
      {id, op} = Enum.find(Log.ops(log), fn {_, op} -> op.kind == :authority end)
      %{log | ops: Map.put(log.ops, id, %{op | sig: <<0::512>>})}
    end

    test "pin authoring refuses unauthenticated or incomplete history" do
      root = ident("root")
      {_, log} = created(root)

      assert {:error, :invalid_verified_history} =
               Space.prepare_continuation_pin(root, unsigned(log), params())

      assert {:error, :invalid_verified_history} =
               Space.prepare_continuation_pin(
                 root,
                 %{log | referenced: MapSet.new()},
                 params()
               )
    end

    test "a second pin is refused" do
      {root, log, _pin} = pinned()

      assert {:error, :continuation_already_pinned} =
               Space.prepare_continuation_pin(root, log, params())
    end

    test "bootstrap authoring propagates an invalid history and refuses key reuse" do
      {root, log, pin} = pinned()
      rec = record(root, log, pin)

      assert {:error, :invalid_verified_history} =
               Space.author_catalog_bootstrap(root, unsigned(log), rec)

      for bad <- [%{rec | catalog_key: root.pub}, %{rec | service_key: root.pub}] do
        assert {:error, :binding_key_reuse} = Space.author_catalog_bootstrap(root, log, bad)
      end
    end
  end

  test "a legacy Space stays refused for continuation and bootstrap" do
    root = ident("root")
    legacy = legacy_log(root)
    assert {:error, :unauthorized_continuation} = Authority.continuation_profile(legacy)

    rec = %{
      version: 1,
      product: :treehouse,
      space: legacy.replica,
      space_root: root.pub,
      profile_genesis: @nonce,
      profile_id: @nonce,
      replacement_rule: :bounded_space_admin_v1,
      catalog_key: ident("catalog").pub,
      service_id: @nonce,
      service_key: ident("service").pub,
      origin: "wss://relay.invalid",
      nonce: @nonce
    }

    assert {:error, :not_bounded_space} = Space.author_catalog_bootstrap(root, legacy, rec)
  end

  test "the parity vector file is byte-identical to a fresh regeneration" do
    path = Path.expand("../../../../" <> BoundedSpaceVectors.relative_path(), __DIR__)
    assert File.read!(path) == BoundedSpaceVectors.encoded()
  end

  defp legacy_log(root) do
    {:ok, %{replica: replica, pending: pending}} =
      Space.prepare_creation(root, "treehouse:legacy-bounded-test", "Canopy")

    Enum.reduce(pending, Log.new(replica), &Log.append!(&2, &1))
  end
end
