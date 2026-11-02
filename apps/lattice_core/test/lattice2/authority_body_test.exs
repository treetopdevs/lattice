defmodule Lattice2.AuthorityBodyTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Lattice.Authority.Delegation
  alias Lattice.Canonical
  alias Lattice.Graph.{AuthorityBody, ReplicaSnapshot}
  alias Lattice.Sim
  alias Township.{Matter, ReadModel}

  @replica "replica:matter:authority-body"
  @tags [:genesis, :grant, :transfer, :succeed, :heartbeat, :revoke, :request, :beacon]
  @fields [
    :id,
    :replica,
    :issuer,
    :audience,
    :parent_id,
    :ops,
    :roles,
    :live,
    :sig,
    :expires_epoch
  ]

  # --- Generators -------------------------------------------------------------

  defp scalar_gen do
    one_of([
      constant(nil),
      boolean(),
      integer(),
      binary(min_length: 0, max_length: 40),
      atom(:alphanumeric),
      member_of([:clerk, :post, :witnessed | @tags])
    ])
  end

  # Arbitrary terms: nested containers, tagged tuples, forged structs.
  defp any_term_gen do
    tree(scalar_gen(), fn child ->
      one_of([
        list_of(child, max_length: 4),
        map_of(child, child, max_length: 3),
        bind(integer(0..5), fn arity ->
          bind(one_of([member_of(@tags), atom(:alphanumeric)]), fn head ->
            map(list_of(child, length: max(arity - 1, 0)), fn rest ->
              if arity == 0, do: {}, else: List.to_tuple([head | rest])
            end)
          end)
        end),
        map(list_of(child, max_length: 3), &MapSet.new/1),
        map(child, &%MapSet{map: &1}),
        map(child, &%Canonical.Atom{name: &1}),
        bind(member_of(@fields), fn field ->
          map(child, &Map.put(delegation_template(), field, &1))
        end),
        map(member_of(@fields), &Map.delete(delegation_template(), &1))
      ])
    end)
  end

  # Terms Canonical can encode, so Op.new can sign them as a body.
  defp encodable_gen do
    scalar =
      one_of([
        constant(nil),
        boolean(),
        integer(0..1_000_000),
        binary(min_length: 0, max_length: 40),
        member_of([:clerk, :post, :resident, :witnessed]),
        map(string(:alphanumeric, max_length: 6), &%Canonical.Atom{name: &1})
      ])

    tree(scalar, fn child ->
      one_of([
        list_of(child, max_length: 3),
        map(list_of(child, max_length: 3), &List.to_tuple/1),
        map_of(child, child, max_length: 2),
        map(list_of(child, max_length: 3), &MapSet.new/1)
      ])
    end)
  end

  defp attacker_body_gen(good) do
    deleg =
      one_of([
        constant(good),
        bind(member_of(@fields -- [:expires_epoch]), fn field ->
          map(encodable_gen(), &%{good | field => &1})
        end),
        map(one_of([constant(nil), integer(0..100)]), &%{good | expires_epoch: &1}),
        encodable_gen()
      ])

    role = one_of([constant(:clerk), encodable_gen()])
    tick = one_of([integer(0..100), encodable_gen()])

    one_of([
      map(deleg, &{:grant, &1}),
      map({deleg, encodable_gen()}, fn {d, p} -> {:genesis, d, p} end),
      map({role, deleg, tick}, fn {r, d, t} -> {:transfer, r, d, t} end),
      map({role, deleg, tick}, fn {r, d, t} -> {:succeed, r, d, t} end),
      map({role, deleg, encodable_gen()}, fn {r, d, c} -> {:succeed, r, d, {:witnessed, c}} end),
      map({role, tick}, fn {r, t} -> {:heartbeat, r, t} end),
      map(encodable_gen(), &{:revoke, &1}),
      map({encodable_gen(), encodable_gen()}, fn {r, p} -> {:request, r, p} end),
      encodable_gen()
    ])
  end

  # The generator stays inside the domain Op.new can sign; a body Canonical
  # refuses (duplicate set members, a struct it cannot tag) never gets an id or
  # signature, so it never reaches a reader.
  defp signable?(body) do
    _bytes = Canonical.term(body)
    true
  rescue
    # Canonical refuses with ArgumentError, or with Protocol.UndefinedError for
    # delegation ops/roles that are not enumerable (authoring side, not a reader).
    _refused in [ArgumentError, Protocol.UndefinedError] -> false
  end

  defp delegation_template do
    %Delegation{
      id: "id",
      replica: @replica,
      issuer: <<1::256>>,
      audience: <<2::256>>,
      ops: MapSet.new([:post]),
      roles: MapSet.new([:clerk]),
      live: false,
      sig: "sig"
    }
  end

  # --- Shape checks -----------------------------------------------------------

  defp parsed_shape?({:genesis, d}), do: dview?(d)
  defp parsed_shape?({:grant, d}), do: dview?(d)
  defp parsed_shape?({:transfer, r, d, t}), do: role?(r) and dview?(d) and tick?(t)
  defp parsed_shape?({:succeed, r, d, t}), do: role?(r) and dview?(d) and tick?(t)

  defp parsed_shape?({:heartbeat, r, t}),
    do: role?(r) and tick?(t) and not match?({:witnessed, _}, t)

  defp parsed_shape?({:revoke, {:ok, t}}), do: is_binary(t)
  defp parsed_shape?({:revoke, {:malformed, _}}), do: true
  defp parsed_shape?({:request, _}), do: true
  defp parsed_shape?({:command, c, a}), do: is_atom(c) and is_list(a)
  defp parsed_shape?({:other, _}), do: true
  defp parsed_shape?(_), do: false

  defp dview?(%{issuer: i, audience: a, roles: r, ops: o, well_formed?: w} = d)
       when map_size(d) == 5 and is_boolean(w) do
    key?(i) and key?(a) and names?(r) and names?(o) and
      (not w or
         (match?({:ok, _}, i) and match?({:ok, _}, a) and match?({:ok, _}, r) and
            match?({:ok, _}, o)))
  end

  defp dview?(_), do: false

  defp key?({:ok, pub}), do: is_binary(pub) and byte_size(pub) == 32
  defp key?(:malformed), do: true
  defp key?(_), do: false

  defp names?({:ok, names}), do: is_list(names) and Enum.all?(names, &is_binary/1)
  defp names?(:malformed), do: true
  defp names?(_), do: false

  defp role?({:name, _raw, text}), do: is_binary(text)
  defp role?({:malformed, _raw}), do: true
  defp role?(_), do: false

  defp tick?({:tick, t}), do: is_integer(t)
  defp tick?({:witnessed, _}), do: true
  defp tick?({:malformed, _}), do: true
  defp tick?(_), do: false

  # --- Properties -------------------------------------------------------------

  property "parse/1 is total over arbitrary terms" do
    check all(term <- any_term_gen(), max_runs: 500) do
      assert parsed_shape?(AuthorityBody.parse(term)), inspect(term)
    end
  end

  property "both readers never raise on admitted attacker-shaped authority bodies" do
    {sim, good} = base_sim()
    base_edges = ReadModel.observe(Sim.log(sim, "clerk")).trust_graph.edges

    check all(body <- attacker_body_gen(good) |> filter(&signable?/1, 50), max_runs: 50) do
      log = append_log(sim, body)
      model = ReadModel.observe(log, labels: %{}, vouches: [])
      assert is_map(ReadModel.replay(log))
      graph = ReplicaSnapshot.build(Matter, log)

      for format <- [:mermaid, :json, :dot],
          do: assert(is_binary(ReplicaSnapshot.export(graph, format)))

      assert base_edges -- model.trust_graph.edges == []
    end
  end

  # --- Examples ---------------------------------------------------------------

  test "revoke with a non-binary target renders a marker instead of raising" do
    {sim, _good} = base_sim()

    for body <- [{:revoke, 7}, {:revoke, %{}}, {:revoke, <<154>>}] do
      log = append_log(sim, body)
      assert is_map(ReadModel.observe(log, labels: %{}, vouches: []))
      graph = ReplicaSnapshot.build(Matter, log)
      assert is_binary(ReplicaSnapshot.export(graph, :json))
      labels = Enum.map(graph.nodes, & &1.label)
      assert Enum.any?(labels, &String.contains?(&1, "revoke (malformed)")), inspect(labels)
    end
  end

  test "revoke label checks only the shown prefix of the target" do
    {sim, _good} = base_sim()
    graph = ReplicaSnapshot.build(Matter, append_log(sim, {:revoke, "12345678" <> <<255>>}))
    assert is_binary(ReplicaSnapshot.export(graph, :json))
    labels = Enum.map(graph.nodes, & &1.label)
    assert Enum.any?(labels, &String.contains?(&1, "revoke 12345678")), inspect(labels)
  end

  test "parse/1 parses each delegation field on its own" do
    good = delegation_template()

    assert {:grant, %{audience: {:ok, _}, roles: :malformed, well_formed?: false}} =
             AuthorityBody.parse({:grant, %{good | roles: [:clerk]}})

    assert {:grant, %{audience: :malformed, roles: {:ok, ["clerk"]}, well_formed?: false}} =
             AuthorityBody.parse({:grant, %{good | audience: <<1>>}})

    assert {:grant, %{ops: {:ok, ["post"]}, well_formed?: true}} =
             AuthorityBody.parse({:grant, good})
  end

  test "parse/1 keeps the raw role and tick alongside their parsed form" do
    good = delegation_template()
    wrapped = %Canonical.Atom{name: "clerk"}

    assert {:transfer, {:name, ^wrapped, "clerk"}, _, {:tick, 0}} =
             AuthorityBody.parse({:transfer, wrapped, good, 0})

    assert {:transfer, {:malformed, %{}}, _, _} = AuthorityBody.parse({:transfer, %{}, good, 0})

    assert {:succeed, {:name, :clerk, "clerk"}, _, {:malformed, %{}}} =
             AuthorityBody.parse({:succeed, :clerk, good, %{}})
  end

  # --- Helpers ----------------------------------------------------------------

  defp base_sim do
    sim = Sim.new(Matter, @replica, ["clerk", "resident"], seed: "authority-body")
    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, good} = Sim.grant(sim, "clerk", "resident", ops: [:post], roles: [:clerk])
    {Sim.sync_all(sim), good}
  end

  defp append_log(sim, body) do
    {sim, _op} = Sim.append(sim, "clerk", :authority, body)
    sim |> Sim.sync_all() |> Sim.log("clerk")
  end
end
