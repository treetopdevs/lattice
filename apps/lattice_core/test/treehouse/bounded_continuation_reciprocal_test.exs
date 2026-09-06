defmodule Treehouse.BoundedContinuationReciprocalTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Log, Op}
  alias Lattice.Authority.ContinuationCertificate
  alias Lattice.Carrier.Wire
  alias Treehouse.ContinuationFixtures, as: F

  test "V05 TypeScript-authored Space and Thread operations are authenticated and honored in BEAM" do
    vectors =
      Path.expand(
        "../../../../clients/lattice-client/test/vectors/continuation/ts_authoring.json",
        __DIR__
      )
      |> File.read!()
      |> Jason.decode!()
      |> Map.fetch!("vectors")

    assert Enum.map(vectors, & &1["kind"]) == ["space", "thread"]

    for vector <- vectors do
      {module, role} =
        if vector["kind"] == "space", do: {F.Space, :admin}, else: {F.Thread, :moderator}

      Code.ensure_loaded!(module)
      empty = Log.new(vector["replica"])
      assert {:ok, ops} = Wire.decode_ops(vector["frames"])
      assert Enum.all?(ops, &Op.valid?/1)

      for %{"id" => id, "bytes" => bytes} <- vector["canonical"] do
        op = Enum.find(ops, &(&1.id == id))
        assert Base.encode64(Op.canonical_encoding(op)) == bytes
      end

      log = Enum.reduce(ops, empty, &Log.append!(&2, &1))
      analysis = Authority.analyze(module, log)
      final_id = vector["finalOpId"]
      assert analysis.reasons == %{}

      assert Authority.holder_epoch(module, log, role) == %{
               holder: Base.decode64!(vector["holder"]),
               op_id: final_id
             }

      {:ok, final} = Log.fetch(log, final_id)
      assert {:succeed, ^role, delegation, {:continuation_v1, certificate}} = final.body
      assert delegation.id == vector["delegationId"]

      assert Base.encode64(ContinuationCertificate.signing_payload(certificate.claim)) ==
               vector["claimBytes"]

      preceding = Enum.reduce(Enum.reject(ops, &(&1.id == final_id)), empty, &Log.append!(&2, &1))
      forged = %{final | sig: <<0::512>>}
      assert {:quarantined, retained, :bad_signature} = Log.accept(preceding, forged)
      refute Log.has?(retained, final_id)
      refute Authority.holder_epoch(module, retained, role).op_id == final_id
      assert {:ok, repaired} = Log.accept(retained, final)
      assert Authority.holder_epoch(module, repaired, role).op_id == final_id

      # Existing causal admission buffers a valid final op until its deps arrive.
      assert {:missing_deps, ^empty, missing} = Log.accept(empty, final)
      assert missing == final.deps
    end
  end
end
