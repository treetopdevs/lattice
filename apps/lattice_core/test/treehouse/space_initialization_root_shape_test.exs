defmodule Treehouse.SpaceInitializationRootShapeTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Authority.Delegation
  alias Treehouse.Space

  test "a malformed genesis dependency cannot complete a valid Space creation" do
    root = Identity.from_seed("root", "initialization-root-shape")
    nonce = Base.url_encode64(:crypto.hash(:sha256, "initialization-root-shape"), padding: false)

    {:ok, %{replica: replica, pending: [genesis, _]}} =
      Space.prepare_bounded_creation(root, "replica:treehouse:space:" <> nonce, "Canopy")

    {:genesis, delegation, _} = genesis.body

    for malformed <- [nil, :genesis, %{}] do
      candidate = Op.new(root, replica, [genesis.id], :authority, {:genesis, malformed, %{}})

      creation =
        Op.new(root, replica, [candidate.id], :command, {:create_space, ["Canopy"]},
          cap: delegation.id
        )

      for frames <- [[genesis, candidate, creation], [creation, candidate, genesis]] do
        log = Log.from_ops(replica, Map.new(frames, &{&1.id, &1}))
        assert :ok = Log.verify_authenticity(log)
        assert Authority.analyze(Space, log).reasons[creation.id] == nil
        assert Space.initialization(log) == :incomplete
        assert Lattice.state(Space, log).name == "Canopy"
      end
    end
  end

  test "role-free root pins and outsider replays preserve neutral source behavior" do
    root = Identity.from_seed("root", "initialization-neutral-root")
    outsider = Identity.from_seed("outsider", "initialization-neutral-outsider")
    nonce = Base.url_encode64(:crypto.hash(:sha256, "initialization-neutral"), padding: false)

    {:ok, %{replica: replica, pending: [genesis, _]}} =
      Space.prepare_bounded_creation(root, "replica:treehouse:space:" <> nonce, "Canopy")

    {:genesis, capability, _} = genesis.body
    neutral = Delegation.genesis(root, replica, ops: [], roles: [], live: false)

    for signer <- [root, outsider] do
      candidate = Op.new(signer, replica, [genesis.id], :authority, {:genesis, neutral, %{}})

      creation =
        Op.new(root, replica, [candidate.id], :command, {:create_space, ["Canopy"]},
          cap: capability.id
        )

      log = Log.from_ops(replica, Map.new([genesis, candidate, creation], &{&1.id, &1}))
      assert :ok = Log.verify_authenticity(log)
      assert Authority.analyze(Space, log).reasons[candidate.id] == nil
      assert Space.initialization(log) == :ready
    end
  end
end
