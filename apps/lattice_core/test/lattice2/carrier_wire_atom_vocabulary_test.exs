defmodule Lattice.CarrierWireAtomVocabularyTest do
  # Row 190 (rework, ruling D2): frame admission is a pure function of the frame bytes and the
  # closed `Lattice.Carrier.WireVocabulary`, never of which atoms the decoding VM holds.
  # PR #114 decoded an unlisted name as `Lattice.Canonical.Atom`; a log persisted under it can
  # still hold that struct, so the checked encode and the snapshot refuse it when off-list.
  use ExUnit.Case, async: true

  alias Lattice.Authority.Delegation
  alias Lattice.{BrowserLogStore, Canonical, Identity, Log, Op}
  alias Lattice.Carrier.{Wire, WireVocabulary}

  @replica "replica:wire-atom-vocabulary"
  @off_list "row190_not_listed"
  @listed "post"

  # Each position a name can occupy in a signed op, as a builder from a name to an op.
  @positions %{
    "body" => :body,
    "cap" => :cap,
    "delegation ops" => :ops,
    "delegation roles" => :roles
  }

  defp identity, do: Identity.from_seed("alice", "wire-atom-vocabulary")

  defp op_with(:body, name),
    do: Op.new(identity(), @replica, [], :command, {:post, %Canonical.Atom{name: name}})

  defp op_with(:cap, name),
    do: Op.new(identity(), @replica, [], :command, nil, cap: [%Canonical.Atom{name: name}])

  defp op_with(:ops, name), do: grant_op(ops: [%Canonical.Atom{name: name}], roles: [])
  defp op_with(:roles, name), do: grant_op(ops: [], roles: [%Canonical.Atom{name: name}])

  defp grant_op(opts) do
    delegation = Delegation.new(identity(), @replica, identity().pub, opts)
    Op.new(identity(), @replica, [], :authority, {:grant, delegation})
  end

  defp atom_twin(:body), do: Op.new(identity(), @replica, [], :command, {:post, :post})
  defp atom_twin(:cap), do: Op.new(identity(), @replica, [], :command, nil, cap: [:post])
  defp atom_twin(:ops), do: grant_op(ops: [:post], roles: [])
  defp atom_twin(:roles), do: grant_op(ops: [], roles: [:post])

  for {label, position} <- @positions do
    describe "a persisted #{label} struct" do
      test "off-list is refused by the checked encode and by the snapshot" do
        op = op_with(unquote(position), @off_list)
        refute WireVocabulary.known?(@off_list)

        assert {:error, :unknown_atom} = Wire.encode_op_checked(op)

        log = Log.append!(Log.new(@replica), op)
        assert {:error, :unknown_atom} = BrowserLogStore.dump_payload(log)
      end

      test "listed encodes to the bytes of the atom it names" do
        op = op_with(unquote(position), @listed)
        assert WireVocabulary.known?(@listed)

        assert {:ok, frame} = Wire.encode_op_checked(op)
        assert frame["body"] == Wire.encode_op(atom_twin(unquote(position)))["body"]
        assert frame["cap"] == Wire.encode_op(atom_twin(unquote(position)))["cap"]

        assert {:ok, payload} = BrowserLogStore.dump_payload(Log.append!(Log.new(@replica), op))
        assert [^frame] = payload["ops"]
      end
    end
  end

  test "a persisted off-list struct in a quarantined op refuses the snapshot too" do
    genesis = Op.new(identity(), @replica, [], :command, {:post, "genesis"})
    genuine = Op.new(identity(), @replica, [genesis.id], :command, {:post, "real"})
    forged = %{genuine | body: {:post, %Canonical.Atom{name: @off_list}}}

    {log, report} =
      @replica |> Log.new() |> Log.append!(genesis) |> Lattice.Sync.deliver([forged])

    assert [{forged_id, :bad_signature}] = report.quarantined
    assert forged_id == forged.id
    assert {:error, :unknown_atom} = BrowserLogStore.dump_payload(log)
  end

  test "unlisted names are refused on decode and listed names are admitted" do
    for position <- Map.values(@positions) do
      off_list = position |> op_with(@off_list) |> Wire.encode_op()
      listed = position |> op_with(@listed) |> Wire.encode_op()

      assert {:error, :malformed_op} = Wire.decode_op(off_list)
      assert {:error, :malformed_op} = Wire.decode_ops([listed, off_list])
      assert {:ok, %Op{}} = Wire.decode_op(listed)
    end
  end

  test "admission is the same in a VM that holds none of the atoms" do
    peer = cold_peer()
    catch_error(:peer.call(peer, String, :to_existing_atom, ["seize_records"]))

    listed = Op.new(identity(), @replica, [], :command, {:post, :seize_records})
    off_list = Op.new(identity(), @replica, [], :command, {:post, :row190_not_listed})

    for op <- [listed, off_list] do
      frame = Wire.encode_op(op)
      assert :peer.call(peer, Wire, :decode_op, [frame], 30_000) == Wire.decode_op(frame)
    end

    assert {:ok, ^listed} =
             :peer.call(peer, Wire, :decode_op, [Wire.encode_op(listed)], 30_000)

    assert {:error, :malformed_op} =
             :peer.call(peer, Wire, :decode_op, [Wire.encode_op(off_list)], 30_000)
  end

  defp cold_peer do
    {:ok, peer, _node} =
      :peer.start_link(%{connection: :standard_io, args: [~c"-pa" | :code.get_path()]})

    peer
  end
end
