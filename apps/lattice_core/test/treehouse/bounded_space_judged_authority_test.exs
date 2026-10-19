defmodule Treehouse.BoundedSpaceJudgedAuthorityTest do
  # Row 235: bounded creation and bootstrap capability selection ask the authority judge,
  # never a local re-derivation of pin shape or retained-history validity. Bootstrap capability
  # selection keeps an advisory ops/roles pre-filter; the trial op's judgement is the verdict.
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Authority.Delegation
  alias Treehouse.Space

  @nonce Base.url_encode64(:crypto.hash(:sha256, "judged-authority-nonce"), padding: false)
  @nonce_replica "replica:treehouse:space:" <> @nonce
  @bounded_suffix "#authority:bounded-continuation-v1"

  defp ident(name), do: Identity.from_seed(name, "bounded-judged-test-" <> name)

  defp created(root \\ ident("root")) do
    {:ok, %{replica: replica, pending: pending}} =
      Space.prepare_bounded_creation(root, @nonce_replica, "Canopy")

    Enum.reduce(pending, Log.new(replica), &Log.append!(&2, &1))
  end

  defp params,
    do: %{
      nominee: ident("nominee").pub,
      witnesses: for(n <- ~w(w1 w2 w3), do: ident(n).pub),
      threshold: 2,
      max_lease_epochs: 7
    }

  defp pin_for(root, log) do
    {:ok, pin} = Space.prepare_continuation_pin(root, log, params())
    pin
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

  # A pin-shaped root genesis whose embedded delegation is swapped; the op itself is re-signed
  # by the root, so only the judge's delegation validation can tell it is not a pin.
  defp resigned_pin(root, log, delegation_fun) do
    %Op{deps: deps, body: {:genesis, d, policies}} = pin_for(root, log)

    {:ok, op} =
      Op.authored(root, log.replica, deps, :authority, {:genesis, delegation_fun.(d), policies})

    assert Op.valid?(op)
    Log.append!(log, op)
  end

  defp flip_sig(%Delegation{sig: <<b, rest::binary>>} = d),
    do: %{d | sig: <<Bitwise.bxor(b, 1), rest::binary>>}

  defp foreign(root) do
    other = Base.url_encode64(:crypto.hash(:sha256, "foreign-nonce"), padding: false)

    replica =
      Authority.bind_replica("replica:treehouse:space:" <> other <> @bounded_suffix, root.pub)

    fn _d -> Delegation.genesis(root, replica, ops: [], roles: [], live: false) end
  end

  describe "prepare_bounded_creation/4 pin exemption" do
    test "a pin whose delegation signature has one flipped bit is a competing initialization" do
      root = ident("root")
      forged = resigned_pin(root, created(root), &flip_sig/1)

      assert {:ok, []} = Authority.continuation_pins(forged)

      assert {:error, :different_initialization} =
               Space.prepare_bounded_creation(root, @nonce_replica, "Canopy", forged)
    end

    test "a pin whose delegation names a foreign replica is a competing initialization" do
      root = ident("root")
      forged = resigned_pin(root, created(root), foreign(root))

      assert {:ok, []} = Authority.continuation_pins(forged)

      assert {:error, :different_initialization} =
               Space.prepare_bounded_creation(root, @nonce_replica, "Canopy", forged)
    end

    test "a genuine retained pin resumes" do
      root = ident("root")
      log = created(root)
      pinned = Log.append!(log, pin_for(root, log))

      assert {:ok, %{status: :ready, pending: []}} =
               Space.prepare_bounded_creation(root, @nonce_replica, "Canopy", pinned)
    end

    # TS parity: the TS judge cannot read an integer above 2^53-1 (row 212), so it keeps this
    # pin as a malformed op rather than refusing the history; both runtimes resume `ready`.
    test "a genuine pin with an extra uint64 policy entry resumes" do
      root = ident("root")
      log = created(root)
      %Op{deps: deps, body: {:genesis, d, policies}} = pin_for(root, log)

      {:ok, pin} =
        Op.authored(root, log.replica, deps, :authority, {
          :genesis,
          d,
          Map.put(policies, :admin, 9_007_199_254_740_992)
        })

      pinned = Log.append!(log, pin)
      assert {:ok, [%{op_id: id}]} = Authority.continuation_pins(pinned)
      assert id == pin.id

      assert {:ok, %{status: :ready, pending: []}} =
               Space.prepare_bounded_creation(root, @nonce_replica, "Canopy", pinned)
    end

    test "retained history the judge cannot verify as complete is refused" do
      root = ident("root")
      log = created(root)

      {id, op} = Enum.find(Log.ops(log), fn {_, op} -> op.kind == :authority end)
      unsigned = %{log | ops: Map.put(log.ops, id, %{op | sig: <<0::512>>})}

      for bad <- [%{log | referenced: MapSet.new()}, unsigned] do
        assert {:error, :invalid_retained_log} =
                 Space.prepare_bounded_creation(root, @nonce_replica, "Canopy", bad)
      end
    end
  end

  describe "author_catalog_bootstrap/3 capability selection" do
    test "decoy root geneses before and after the real one never become the bootstrap cap" do
      root = ident("root")
      log = created(root)
      pin = pin_for(root, log)
      log = Log.append!(log, pin)
      rec = record(root, log, pin)
      {:ok, original} = Space.author_catalog_bootstrap(root, log, rec)

      [real_genesis] =
        for %Op{kind: :authority, body: {:genesis, %Delegation{id: id}, _}} = op <-
              Log.topo_ops(log),
            id == original.cap,
            do: op.id

      positions =
        for n <- 1..12 do
          decoy =
            Delegation.genesis(root, log.replica,
              ops: [:create_space, :create_thread] |> Enum.take(rem(n, 2) + 1),
              roles: Enum.take([:admin, :moderator], rem(n, 3)),
              live: n > 6
            )

          extra = Op.new(root, log.replica, [], :authority, {:genesis, decoy, %{}})
          widened = Log.append!(log, extra)

          assert {:ok, op} = Space.author_catalog_bootstrap(root, widened, rec)
          assert op.cap == original.cap

          refute MapSet.member?(
                   Authority.analyze(Space, Log.append!(widened, op)).quarantine,
                   op.id
                 )

          ids = Enum.map(Log.topo_ops(widened), & &1.id)
          Enum.find_index(ids, &(&1 == extra.id)) < Enum.find_index(ids, &(&1 == real_genesis))
        end

      assert true in positions and false in positions
    end

    test "a field-qualifying root genesis the judge refuses is tried and skipped" do
      root = ident("root")
      log = created(root)
      pin = pin_for(root, log)
      log = Log.append!(log, pin)
      rec = record(root, log, pin)
      {:ok, original} = Space.author_catalog_bootstrap(root, log, rec)
      ids = fn l -> Enum.map(Log.topo_ops(l), & &1.id) end
      real = Enum.find_index(ids.(log), &(&1 == hd(Log.topo_ops(log)).id))

      first =
        Enum.find_value(1..32, fn n ->
          # Admin with the bootstrap op, but a delegation signature with one flipped bit.
          decoy =
            Delegation.genesis(root, log.replica,
              ops: [:catalog_bootstrap_v1 | Enum.take([:create_space, :create_thread], rem(n, 3))],
              roles: [:admin],
              live: n > 16
            )
            |> flip_sig()

          extra = Op.new(root, log.replica, [], :authority, {:genesis, decoy, %{}})
          widened = Log.append!(log, extra)
          if Enum.find_index(ids.(widened), &(&1 == extra.id)) <= real, do: {widened, decoy}
        end)

      assert {widened, decoy} = first
      assert {:ok, op} = Space.author_catalog_bootstrap(root, widened, rec)
      assert op.cap == original.cap and op.cap != decoy.id
    end

    test "a Space whose only root genesis lacks the bootstrap op is not honored" do
      root = ident("root")

      replica =
        Authority.bind_replica(@nonce_replica <> @bounded_suffix, root.pub)

      d =
        Delegation.genesis(root, replica,
          ops: [:create_space, :create_thread],
          roles: [:admin, :moderator]
        )

      {:ok, genesis} = Op.authored(root, replica, [], :authority, {:genesis, d, %{}})

      {:ok, name} =
        Op.authored(root, replica, [genesis.id], :command, {:create_space, ["Canopy"]}, cap: d.id)

      log = Log.new(replica) |> Log.append!(genesis) |> Log.append!(name)
      assert Space.initialization(log) == :ready
      pin = pin_for(root, log)
      log = Log.append!(log, pin)

      assert {:error, :bootstrap_not_honored} =
               Space.author_catalog_bootstrap(root, log, record(root, log, pin))
    end
  end

  describe "Authority.continuation_pins/1" do
    test "an empty or unpinned bounded log has no pins" do
      log = created()
      assert {:ok, []} = Authority.continuation_pins(Log.new(log.replica))
      assert {:ok, []} = Authority.continuation_pins(log)
    end

    test "a pinned log names exactly the pin the profile observes" do
      root = ident("root")
      log = created(root)
      pin = pin_for(root, log)
      pinned = Log.append!(log, pin)

      assert {:ok, [%{op_id: id, profile: profile}]} = Authority.continuation_pins(pinned)
      assert id == pin.id

      assert {:ok, %{profile_genesis: ^id, profile: ^profile}} =
               Authority.continuation_profile(pinned)
    end

    test "legacy and unsupported families are refused" do
      root = ident("root")

      {:ok, %{replica: replica, pending: pending}} =
        Space.prepare_creation(root, "treehouse:legacy-judged-test", "Canopy")

      legacy = Enum.reduce(pending, Log.new(replica), &Log.append!(&2, &1))
      assert {:error, :unauthorized_continuation} = Authority.continuation_pins(legacy)

      assert {:error, :unsupported_authority_profile} =
               Authority.continuation_pins(Log.new(@nonce_replica <> @bounded_suffix))
    end

    test "unverifiable history is refused" do
      root = ident("root")
      log = created(root)
      pinned = Log.append!(log, pin_for(root, log))

      assert {:error, :invalid_verified_history} =
               Authority.continuation_pins(%{pinned | referenced: MapSet.new()})

      assert {:error, :invalid_verified_history} =
               Authority.continuation_pins(%{pinned | ops: :not_a_map})
    end
  end
end
