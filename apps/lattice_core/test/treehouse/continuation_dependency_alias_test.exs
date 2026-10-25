defmodule Treehouse.ContinuationDependencyAliasTest do
  use ExUnit.Case, async: false
  alias Lattice.{Canonical, Log, Op}
  alias Lattice.Carrier.Wire
  alias Treehouse.ContinuationDependencyAlias, as: F

  test "canonical header aliases preserve fresh product authority and cutoff" do
    for kind <- [:space, :thread] do
      f = F.fixture(kind)
      expected = F.judge(f.module, f.role, f.op.replica, f.prior ++ [f.op])
      assert expected.epoch == f.op.id
      assert expected.holder == Base.encode64(f.nominee.pub)

      for op <- F.aliases(f.op), ops <- [f.prior ++ [op], [op | Enum.reverse(f.prior)]] do
        assert Op.valid?(op)
        assert op.id == f.op.id
        assert op.sig == f.op.sig
        assert Canonical.op_payload(op) == Canonical.op_payload(f.op)
        assert_outcome(F.judge(f.module, f.role, f.op.replica, ops), expected)
      end
    end
  end

  test "genuine dependency and signed claim changes still refuse" do
    for kind <- [:space, :thread] do
      f = F.fixture(kind)
      forged = %{f.op | deps: [f.genesis.id | f.op.deps]}
      refute Op.valid?(forged)
      prior = Log.from_ops(f.op.replica, Map.new(f.prior, &{&1.id, &1}))
      assert {:quarantined, _, :bad_signature} = Log.accept(prior, forged)

      for {op, reason} <- F.negatives(f) do
        assert Op.valid?(op)
        result = F.judge(f.module, f.role, f.op.replica, f.prior ++ [op])
        assert result.reasons[op.id] == reason
        refute result.epoch == op.id
      end
    end
  end

  test "actual TS produces and consumes live BEAM dependency alias histories" do
    client = Path.expand("../../../../clients/lattice-client", __DIR__)

    {output, 0} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/continuation_dependency_alias_peer.ts", "produce"],
        cd: client,
        stderr_to_stdout: true
      )

    input = Jason.decode!(output)

    for v <- input["vectors"] do
      {module, role} =
        if v["kind"] == "space",
          do: {Treehouse.Space, :admin},
          else: {Treehouse.Thread, :moderator}

      Code.ensure_loaded!(module)
      {:ok, prior} = Wire.decode_ops(v["prior"])
      {:ok, op} = Wire.decode_op(v["frame"])

      for alias_op <- F.aliases(op),
          ops <- [prior ++ [alias_op], [alias_op | Enum.reverse(prior)]] do
        {:ok, decoded_alias} = alias_op |> Wire.encode_op() |> Wire.decode_op()
        assert decoded_alias.deps == alias_op.deps
        assert decoded_alias == alias_op
        actual = F.judge(module, role, v["replica"], ops) |> Jason.encode!() |> Jason.decode!()
        assert_outcome(actual, v["expected"])
      end

      for n <- v["negatives"] do
        {:ok, op} = Wire.decode_op(n["frame"])
        result = F.judge(module, role, v["replica"], prior ++ [op])
        assert Atom.to_string(result.reasons[op.id]) == n["reason"]
      end
    end

    dir =
      Path.join(
        System.tmp_dir!(),
        "continuation-alias-#{System.pid()}-#{System.unique_integer([:positive])}"
      )

    File.mkdir!(dir)

    try do
      path = Path.join(dir, "public.json")

      File.write!(
        path,
        Jason.encode!(%{vectors: Enum.map([:space, :thread], &F.vector(F.fixture(&1)))})
      )

      {output, status} =
        System.cmd(
          "node",
          [
            "--import",
            "tsx",
            "test/support/continuation_dependency_alias_peer.ts",
            "verify-beam",
            path
          ],
          cd: client,
          stderr_to_stdout: true
        )

      assert status == 0, output
      assert output =~ "CONTINUATION_ALIAS_RECIPROCAL_OK"
    after
      File.rm_rf!(dir)
    end
  end

  defp assert_outcome(actual, expected) do
    actual = actual |> Jason.encode!() |> Jason.decode!()
    expected = expected |> Jason.encode!() |> Jason.decode!()

    for key <- ["epoch", "holder", "reasons", "cutoff"] do
      assert actual[key] == expected[key]
    end

    assert actual["cutoffBytes"] == expected["cutoffBytes"], "canonical cutoff bytes differ"
  end
end
