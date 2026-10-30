defmodule Lattice.CarrierWireAdmissionParityTest do
  # Rows 205/206/209: the BEAM side of the admission-parity rulings, asserted on behaviour.
  use ExUnit.Case, async: true

  alias Lattice.Authority
  alias Lattice.Carrier.Wire
  alias Lattice.Authority.Delegation
  alias Lattice.Sim
  alias Township.Matter

  defp posted_sim do
    sim = Sim.new(Matter, "replica:matter:admission-parity", ["clerk", "resident"], seed: "ap")
    {sim, _} = Sim.create_replica(sim, "clerk")
    {sim, grant} = Sim.grant(sim, "clerk", "resident", ops: [:post])
    sim = Sim.sync_all(sim)
    {sim, p1} = Sim.command(sim, "resident", :post, ["one"], cap: grant.id)
    {_sim, p2} = Sim.command(sim, "resident", :post, ["two"], cap: grant.id)
    {Wire.encode_op(p1), Wire.encode_op(p2)}
  end

  defp bad_frame(good, body, cap), do: good |> Map.put("body", body) |> Map.put("cap", cap)

  describe "row 209 malformed atoms refuse the whole batch" do
    test "command name, argument and cap positions" do
      {good1, good2} = posted_sim()
      cap = good2["cap"]

      for v <- [5, nil, ["x"], %{}, true] do
        cases = [
          bad_frame(good1, ["tuple", [["atom", v], ["list", []]]], cap),
          bad_frame(good1, ["tuple", [["atom", "post"], ["list", [["atom", v]]]]], cap),
          bad_frame(good1, good1["body"], ["atom", v])
        ]

        for bad <- cases do
          assert {:error, :malformed_op} = Wire.decode_ops([bad, good2])
          assert {:error, :malformed_op} = Wire.decode_ops([good2, bad])
        end
      end

      for c <- [["atom"], ["atom", "post", "x"]] do
        bad = bad_frame(good1, good1["body"], c)
        assert {:error, :malformed_op} = Wire.decode_ops([bad, good2])
        assert {:error, :malformed_op} = Wire.decode_ops([good2, bad])
      end
    end

    test "delegation ops and roles elements" do
      {good1, good2} = posted_sim()
      sim = Sim.new(Matter, "replica:matter:admission-parity-d", ["clerk"], seed: "ap")
      clerk = Sim.identity(sim, "clerk")
      d = Delegation.genesis(clerk, Sim.replica(sim), ops: [:post], roles: [:clerk])
      {_sim, genesis} = Sim.append(sim, "clerk", :authority, {:genesis, d, %{}})
      frame = Wire.encode_op(genesis)
      assert {:ok, _} = Wire.decode_ops([frame])

      for v <- [5, nil, ["x"], %{}, true], key <- ["ops", "roles"] do
        bad = mutate_delegation(frame, key, v)
        assert {:error, :malformed_op} = Wire.decode_ops([bad, good2])
        assert {:error, :malformed_op} = Wire.decode_ops([good1, bad])
      end
    end

    test "standalone value" do
      assert {:error, :malformed_term} = Wire.decode_value(["atom", 5])
    end
  end

  describe "row 206 integer horizon" do
    @inputs [
      {["int", 9_007_199_254_740_991], true},
      {["int", "9007199254740991"], true},
      {["int", "9007199254740992"], true},
      {["int", "18446744073709551615"], true},
      {["int", "18446744073709551616"], false},
      {["int", 9_007_199_254_740_992], false}
    ]

    test "command argument position" do
      {good1, _} = posted_sim()

      for {term, admit?} <- @inputs do
        frame = bad_frame(good1, ["tuple", [["atom", "post"], ["list", [term]]]], good1["cap"])
        assert match?({:ok, _}, Wire.decode_ops([frame])) == admit?
        assert match?({:ok, _}, Wire.decode_value(term)) == admit?
      end
    end

    test "__beacon__ policy position" do
      {good1, _} = posted_sim()
      sim = Sim.new(Matter, "replica:matter:admission-parity-b", ["clerk"], seed: "ap")
      clerk = Sim.identity(sim, "clerk")
      d = Delegation.genesis(clerk, Sim.replica(sim), ops: [:post], roles: [:clerk])
      policy = %{mode: :witnessed, version: 1, witnesses: [], threshold: 0}
      {_sim, genesis} = Sim.append(sim, "clerk", :authority, {:genesis, d, %{__beacon__: policy}})
      frame = Wire.encode_op(genesis)
      _ = good1

      for {term, admit?} <- @inputs do
        bad = put_in_policy_version(frame, term)
        assert match?({:ok, _}, Wire.decode_ops([bad])) == admit?
      end
    end
  end

  describe "row 205 non-atom policy keys are admitted and ignored" do
    for {label, key} <- [{"binary", "clerk"}, {"integer", 7}, {"tuple", {:clerk}}] do
      test "#{label} key" do
        key = unquote(Macro.escape(key))

        sim =
          Sim.new(Matter, "replica:matter:admission-parity-k", ["clerk", "resident"], seed: "ap")

        clerk = Sim.identity(sim, "clerk")
        resident = Sim.identity(sim, "resident")

        d =
          Delegation.genesis(clerk, Sim.replica(sim),
            ops: [:close_matter, :reopen_matter],
            roles: [:clerk],
            live: true
          )

        policy = %{successor: resident.pub, dormant_ticks: 0}
        {sim, genesis} = Sim.append(sim, "clerk", :authority, {:genesis, d, %{key => policy}})
        assert {:ok, [_]} = Wire.decode_ops(Wire.encode_ops([genesis]))
        sim = Sim.sync_all(sim)

        {sim, claim} =
          Sim.succeed(sim, "resident", :clerk,
            at_tick: 3,
            ops: [:close_matter, :reopen_matter]
          )

        sim = Sim.sync_all(sim)
        log = Sim.log(sim, "clerk")
        reasons = Authority.analyze(Matter, log).reasons
        refute Map.has_key?(reasons, genesis.id)
        assert reasons[claim.id] == :unauthorized_succession
        assert Authority.holder(Matter, log, :clerk) == clerk.pub
      end
    end
  end

  describe "row 211 canonical decimal integers" do
    @non_canonical [
      "007",
      "+1",
      "-0",
      "00",
      "01",
      "-1",
      " 1",
      "1 ",
      "1_0",
      "0x1",
      "",
      "018446744073709551615",
      "18446744073709551616"
    ]

    test "non-canonical strings refuse as a term and refuse the batch" do
      {good1, good2} = posted_sim()

      for s <- @non_canonical do
        assert {:error, :malformed_term} = Wire.decode_value(["int", s])

        bad =
          bad_frame(good1, ["tuple", [["atom", "post"], ["list", [["int", s]]]]], good1["cap"])

        assert {:error, :malformed_op} = Wire.decode_ops([bad, good2])
        assert {:error, :malformed_op} = Wire.decode_ops([good2, bad])
      end
    end

    test "canonical strings are admitted" do
      {good1, _} = posted_sim()

      for s <- ["0", "9007199254740991", "9007199254740992", "18446744073709551615"] do
        assert {:ok, int} = Wire.decode_value(["int", s])
        assert int == String.to_integer(s)
        ok = bad_frame(good1, ["tuple", [["atom", "post"], ["list", [["int", s]]]]], good1["cap"])
        assert {:ok, _} = Wire.decode_ops([ok])
      end
    end

    test "encoder emits only canonical decimal and round-trips" do
      for n <- [0, 1, 9_007_199_254_740_991, 9_007_199_254_740_992, 18_446_744_073_709_551_615] do
        encoded = Wire.encode_value(n)

        if n <= 9_007_199_254_740_991,
          do: assert(encoded == ["int", n]),
          else: assert(encoded == ["int", Integer.to_string(n)])

        assert {:ok, ^n} = Wire.decode_value(encoded)
      end

      assert_raise ArgumentError, fn -> Wire.encode_value(18_446_744_073_709_551_616) end
    end
  end

  describe "row 215 term depth boundary" do
    defp nest(0, leaf, _kind), do: leaf
    defp nest(n, leaf, :list), do: ["list", [nest(n - 1, leaf, :list)]]
    defp nest(n, leaf, :tuple), do: ["tuple", [nest(n - 1, leaf, :tuple)]]
    defp nest(n, leaf, :mapset), do: ["mapset", [nest(n - 1, leaf, :mapset)]]

    defp nest(n, leaf, :map_value),
      do: ["map", [[["atom", "a"], nest(n - 1, leaf, :map_value)]]]

    defp nest(n, leaf, :map_key),
      do: ["map", [[nest(n - 1, leaf, :map_key), ["nil"]]]]

    defp nest(n, leaf, :mixed) do
      kind = Enum.at([:list, :tuple, :map_value], rem(n, 3))
      wrap(kind, nest(n - 1, leaf, :mixed))
    end

    defp wrap(:list, inner), do: ["list", [inner]]
    defp wrap(:tuple, inner), do: ["tuple", [inner]]
    defp wrap(:map_value, inner), do: ["map", [[["atom", "a"], inner]]]

    test "64 admitted and 65 refused for every container kind" do
      for kind <- [:list, :tuple, :mapset, :map_value, :map_key, :mixed] do
        assert {:ok, _} = Wire.decode_value(nest(64, ["nil"], kind)), "#{kind} 64"

        assert {:error, :malformed_term} = Wire.decode_value(nest(65, ["nil"], kind)),
               "#{kind} 65"
      end
    end

    test "body and cap positions budget separately; batch refused" do
      {good1, good2} = posted_sim()

      body = fn k ->
        ["tuple", [["atom", "post"], ["list", [nest(k, ["nil"], :list)]]]]
      end

      assert {:ok, _} = Wire.decode_ops([bad_frame(good1, body.(62), good1["cap"])])

      bad = bad_frame(good1, body.(63), good1["cap"])
      assert {:error, :malformed_op} = Wire.decode_ops([bad, good2])
      assert {:error, :malformed_op} = Wire.decode_ops([good2, bad])

      assert {:ok, _} =
               Wire.decode_ops([bad_frame(good1, good1["body"], nest(64, ["nil"], :list))])

      over = bad_frame(good1, good1["body"], nest(65, ["nil"], :list))
      assert {:error, :malformed_op} = Wire.decode_ops([over, good2])
      assert {:error, :malformed_op} = Wire.decode_ops([good2, over])
    end

    test "delegation leaf consumes no depth" do
      sim = Sim.new(Matter, "replica:matter:admission-parity-depth", ["clerk"], seed: "ap")
      clerk = Sim.identity(sim, "clerk")
      d = Delegation.genesis(clerk, Sim.replica(sim), ops: [:post], roles: [:clerk])
      leaf = Wire.encode_value(d)
      assert {:ok, _} = Wire.decode_value(nest(64, leaf, :list))
    end
  end

  defp mutate_delegation(frame, key, v) do
    ["tuple", [tag, ["delegation", fields], pol]] = frame["body"]
    fields = Map.update!(fields, key, fn [_first | rest] -> [v | rest] end)
    Map.put(frame, "body", ["tuple", [tag, ["delegation", fields], pol]])
  end

  defp put_in_policy_version(frame, term) do
    ["tuple", [tag, deleg, ["map", pairs]]] = frame["body"]

    pairs =
      Enum.map(pairs, fn
        [["atom", "__beacon__"], ["map", inner]] ->
          inner =
            Enum.map(inner, fn
              [["atom", "version"], _] -> [["atom", "version"], term]
              other -> other
            end)

          [["atom", "__beacon__"], ["map", inner]]

        other ->
          other
      end)

    Map.put(frame, "body", ["tuple", [tag, deleg, ["map", pairs]]])
  end
end
