defmodule LatticeCarrierServer.Operator.ReferenceModeTest do
  use ExUnit.Case, async: false
  alias Lattice.{Log, Op}
  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.Operator.{Fixture, ReferenceMode}

  setup do
    {:ok, fixture} = Fixture.new()
    [child, reference, _manifest] = fixture[:artifacts]
    bundle = %{child: child, reference: reference}
    child_log = Lattice.Sim.log(fixture[:child], "creator")
    space = Lattice.Sim.log(fixture[:space], "creator")

    {:ok,
     bundle: bundle,
     child_log: child_log,
     space: space,
     present: fixture[:updated_log],
     owner: Lattice.Sim.identity(fixture[:space], "creator")}
  end

  test "pending and initial presence assertions cannot substitute for each other", f do
    assert {:ok, pending} = ReferenceMode.observe(f.bundle, f.space, f.child_log)
    assert pending.ops == f.present.ops

    assert {:error, :invalid_staged_signed_artifact} =
             ReferenceMode.observe(f.bundle, f.present, f.child_log)

    initial = put_in(f.bundle, [:reference, :review], %{"mode" => "initial_existing"})
    assert {:ok, observed} = ReferenceMode.observe(initial, f.present, f.child_log)
    assert observed == f.present

    assert {:error, :invalid_staged_signed_artifact} =
             ReferenceMode.observe(initial, f.space, f.child_log)
  end

  test "listing can re-observe the exact pending reference without weakening staging", f do
    assert {:ok, observed} = ReferenceMode.observe_listing(f.bundle, f.present, f.child_log)
    assert observed == f.present

    assert {:error, :invalid_staged_signed_artifact} =
             ReferenceMode.observe(f.bundle, f.present, f.child_log)

    initial = put_in(f.bundle, [:reference, :review], %{"mode" => "initial_existing"})

    assert {:error, :reference_not_honored} =
             ReferenceMode.observe_listing(initial, f.space, f.child_log)

    assert {:ok, observed} = ReferenceMode.observe_listing(initial, f.present, f.child_log)
    assert observed == f.present
  end

  test "initial listing refuses a competing honored reference", f do
    initial = put_in(f.bundle, [:reference, :review], %{"mode" => "initial_existing"})
    {:ok, original} = initial.reference.bytes |> Jason.decode!() |> Wire.decode_op()

    competing =
      Op.new(
        f.owner,
        original.replica,
        original.deps,
        :command,
        {:create_thread, [initial.child.replica, "Competing title"]},
        cap: original.cap
      )

    assert {:ok, space} = Log.accept(f.present, competing)

    assert {:error, :initial_reference_competing} =
             ReferenceMode.observe_listing(initial, space, f.child_log)
  end

  test "a different valid signed reference cannot stand in for the observed artifact", f do
    initial = put_in(f.bundle, [:reference, :review], %{"mode" => "initial_existing"})
    {:ok, original} = initial.reference.bytes |> Jason.decode!() |> Wire.decode_op()

    alternate =
      Op.new(
        f.owner,
        original.replica,
        original.deps,
        :command,
        {:create_thread, [initial.child.replica, "Different title"]},
        cap: original.cap
      )

    assert Op.valid?(alternate)

    changed = %{
      initial
      | reference: %{
          initial.reference
          | op_id: alternate.id,
            bytes: Jason.encode!(Wire.encode_op(alternate))
        }
    }

    assert {:error, :invalid_staged_signed_artifact} =
             ReferenceMode.observe(changed, f.present, f.child_log)

    # The alternate is present and honored, but its title disagrees with the child.
    without_original = %{f.present | ops: Map.delete(f.present.ops, original.id)}
    assert {:ok, present} = Log.accept(without_original, alternate)

    assert {:error, :invalid_staged_signed_artifact} =
             ReferenceMode.observe(changed, present, f.child_log)
  end

  test "initial reference must be the exact artifact and child creation", f do
    initial = put_in(f.bundle, [:reference, :review], %{"mode" => "initial_existing"})

    assert {:error, :invalid_staged_signed_artifact} =
             ReferenceMode.observe(initial, f.present, Log.new("wrong"))

    altered = put_in(initial.child.review["creation"], initial.reference.op_id)

    assert {:error, :invalid_staged_signed_artifact} =
             ReferenceMode.observe(altered, f.present, f.child_log)

    refute ReferenceMode.valid_review?(%{"mode" => "initial_existing", "extra" => true})
    refute ReferenceMode.valid_review?(%{"mode" => "pending"})
    assert ReferenceMode.valid_review?(nil)
  end
end
