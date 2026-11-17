defmodule Lattice2.AuthorityBodyTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Lattice.Authority.Delegation
  alias Lattice.Canonical
  alias Lattice.Graph.{AuthorityBody, Export, ReplicaSnapshot}
  alias Lattice.Sim
  alias Township.{AuditBundle, Matter, ReadModel}

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
    role = one_of([constant(:clerk), encodable_gen()])
    deleg = deleg_gen(good)
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

  defp deleg_gen(good) do
    one_of([
      constant(good),
      bind(member_of(@fields -- [:expires_epoch]), fn field ->
        map(encodable_gen(), &%{good | field => &1})
      end),
      map(one_of([constant(nil), integer(0..100)]), &%{good | expires_epoch: &1}),
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

  defp parsed_shape?({:revoke, {:ok, t}}), do: is_binary(t) and String.valid?(t)
  defp parsed_shape?({:revoke, {:malformed, _}}), do: true
  defp parsed_shape?({:request, _}), do: true
  defp parsed_shape?({:command, c, a}), do: is_atom(c) and is_list(a)
  defp parsed_shape?({:other, _}), do: true
  defp parsed_shape?(_), do: false

  # `well_formed?` is the delegation shape plus both keys. Roles and ops are
  # display fields: a well-formed delegation may still carry a name that is not
  # valid UTF-8, so they may be `:malformed` independently of `well_formed?`.
  defp dview?(%{issuer: i, audience: a, roles: r, ops: o, well_formed?: w} = d)
       when map_size(d) == 5 and is_boolean(w) do
    key?(i) and key?(a) and names?(r) and names?(o) and
      (not w or (match?({:ok, _}, i) and match?({:ok, _}, a)))
  end

  defp dview?(_), do: false

  defp key?({:ok, pub}), do: is_binary(pub) and byte_size(pub) == 32
  defp key?(:malformed), do: true
  defp key?(_), do: false

  defp names?({:ok, names}),
    do: is_list(names) and Enum.all?(names, &(is_binary(&1) and String.valid?(&1)))

  defp names?(:malformed), do: true
  defp names?(_), do: false

  defp role?({:name, _raw, text}), do: is_binary(text) and String.valid?(text)
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

  property "readers stay display-safe on admitted attacker-shaped authority bodies" do
    {sim, good} = base_sim()
    base_edges = ReadModel.observe(Sim.log(sim, "clerk")).trust_graph.edges

    check all(body <- attacker_body_gen(good) |> filter(&signable?/1, 50), max_runs: 50) do
      log = append_log(sim, body)
      model = ReadModel.observe(log, labels: %{}, vouches: [])
      assert is_binary(Jason.encode!(model.trust_graph))
      assert is_binary(Jason.encode!(ReadModel.replay(log)))
      assert is_binary(Jason.encode!(model.op_dag))
      graph = ReplicaSnapshot.build(Matter, log)

      for format <- [:mermaid, :dot],
          do: assert(String.valid?(ReplicaSnapshot.export(graph, format)))

      assert is_map(Jason.decode!(ReplicaSnapshot.export(graph, :json)))

      # The exact bytes AuditBundle writes for the trust graph.
      for format <- [:dot, :mermaid],
          do: assert(String.valid?(Export.export(model.trust_graph, format)))

      assert base_edges -- model.trust_graph.edges == []
    end
  end

  # Row 325: admission checks a Matter command's name, arity and effect shape,
  # never its value, so an ordinary capability writes any encodable term into
  # state. The per-run assertions keep the property from going vacuous (D-317).
  @tag :tmp_dir
  property "Township model text slots stay display-safe on admitted attacker-shaped command arguments",
           %{tmp_dir: tmp_dir} do
    sim = matter_command_sim()

    commands = member_of([:set_title, :set_summary, :post, :admit, :remove_member])
    calls = tuple({commands, encodable_gen(), boolean()})

    check all(
            {cmd, arg, authorized?} <- filter(calls, &signable?({elem(&1, 0), [elem(&1, 1)]}), 50),
            max_runs: 50
          ) do
      opts = if authorized?, do: [], else: [cap: :none]
      {sim, op} = Sim.command(sim, "resident", cmd, [arg], opts)
      log = sim |> Sim.sync_all() |> Sim.log("clerk")
      model = ReadModel.observe(log, labels: %{}, vouches: [])
      raw = Lattice.state(Matter, log)
      context = inspect({cmd, arg, authorized?})

      if authorized? do
        refute Map.has_key?(model.roles.reasons, op.id), context
        assert raw_reached?(raw, cmd, arg), context
      else
        assert Map.has_key?(model.roles.reasons, op.id), context

        if cmd in [:admit, :remove_member],
          do: assert(Enum.any?(model.members.denied, &(&1.op_id == op.id)), context)
      end

      for text <- model_text_slots(model), do: assert(display_text?(text), context)
      assert is_binary(Jason.encode!(%{threads: model.threads, members: model.members}))
      replay = ReadModel.replay(log)
      assert is_binary(Jason.encode!(replay))

      for %{"state" => state} <- replay["frames"],
          text <- [state["title"], state["summary"] | state["posts"] ++ state["members"]],
          do: assert(display_text?(text), context)

      assert {:ok, _manifest} = AuditBundle.write(tmp_dir, log)
      assert is_map(Jason.decode!(File.read!(Path.join(tmp_dir, "state.json"))))
    end
  end

  # D-317: the property must reach loan/3, Toolshed's only AuthorityBody
  # consumer, so it first establishes custody with the borrower and an active
  # leased borrow Cap, then lets the borrower append attacker-shaped grants.
  # It covers loan/3 only; the next property covers requests/2 (row 324).
  property "Toolshed.ReadModel loan projection stays display-safe on admitted attacker-shaped authority bodies" do
    sim = Sim.new(Toolshed.Tool, "replica:tool:authority-body", ["owner", "borrower"], seed: "ab")
    {sim, _genesis} = Sim.create_replica(sim, "owner")
    {sim, request} = Sim.request(sim, "borrower", "custody", {:custody_transfer, []})
    sim = Sim.sync_all(sim)
    owner = Sim.identity(sim, "owner")
    borrower = Sim.identity(sim, "borrower")

    consent =
      Lattice.Authority.Consent.sign_custody(borrower, Sim.replica(sim), request.id, owner.pub)

    {sim, _transfer} =
      Sim.command(sim, "owner", :custody_transfer, [borrower.pub, request.id, consent])

    {sim, good} = Sim.grant(sim, "owner", "borrower", ops: [:note_condition], expires_epoch: 4)
    sim = Sim.sync_all(sim)

    base = sim |> Sim.log("owner") |> Toolshed.ReadModel.observe()
    assert %{due_epoch: 4, overdue?: false} = base.loan
    fingerprint = Lattice.Identity.fingerprint(borrower.pub)

    # Half the bodies are grants, the only tag loan/3 reads.
    bodies = one_of([map(deleg_gen(good), &{:grant, &1}), attacker_body_gen(good)])

    check all(body <- bodies |> filter(&signable?/1, 50), max_runs: 50) do
      {sim, _op} = Sim.append(sim, "borrower", :authority, body)
      model = sim |> Sim.sync_all() |> Sim.log("owner") |> Toolshed.ReadModel.observe()

      assert %{borrower_fingerprint: ^fingerprint, overdue?: overdue?} = model.loan,
             inspect(body)

      assert is_boolean(overdue?)
      assert model.loan.due_epoch == 4, inspect(body)
      assert is_binary(Jason.encode!(model.loan))
      assert String.valid?(model.loan.borrower_fingerprint)
      assert String.valid?(model.custody.holder_fingerprint)
      for r <- model.requests, do: assert(String.valid?(r.author_fingerprint))
    end
  end

  # Row 324: the loan property above appends its bodies as :authority, and
  # Authority collects requests only from :inbox ops, so it never reaches
  # requests/2. This property appends attacker-shaped :inbox requests and checks
  # each one by op id (D-317 non-vacuity) before checking the text contract.
  property "Toolshed request ref stays display-safe on admitted attacker-shaped :inbox requests" do
    sim = Sim.new(Toolshed.Tool, "replica:tool:request-ref", ["owner", "borrower"], seed: "rr")
    {sim, _genesis} = Sim.create_replica(sim, "owner")
    sim = Sim.sync_all(sim)

    # An explicit invalid-UTF-8 branch so most seeds reach the binary case.
    bad_utf8 = map(binary(max_length: 8), &(&1 <> <<255>>))
    pairs = tuple({one_of([constant("custody"), bad_utf8, encodable_gen()]), encodable_gen()})

    check all(
            {ref, payload} <- filter(pairs, fn {r, p} -> signable?({:request, r, p}) end, 50),
            max_runs: 50
          ) do
      {sim, op} = Sim.append(sim, "borrower", :inbox, {:request, ref, payload})
      model = sim |> Sim.sync_all() |> Sim.log("owner") |> Toolshed.ReadModel.observe()
      context = inspect({ref, payload})

      assert [r] = Enum.filter(model.requests, &(&1.op == op.id)), context
      assert is_binary(r.ref) and String.valid?(r.ref), context

      if is_binary(ref) and String.valid?(ref),
        do: assert(r.ref == ref, context),
        else: assert(r.ref == "(malformed)", context)

      assert r.payload == payload, context
      assert String.valid?(inspect(r.payload)), context
      assert String.valid?(r.author_fingerprint), context
      assert is_binary(Jason.encode!(Map.delete(r, :payload))), context
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

  test "revoke whose target is not valid UTF-8 renders the marker even with a valid prefix" do
    {sim, _good} = base_sim()
    body = {:revoke, "12345678" <> <<255>>}
    graph = ReplicaSnapshot.build(Matter, append_log(sim, body))
    assert is_map(Jason.decode!(ReplicaSnapshot.export(graph, :json)))
    labels = Enum.map(graph.nodes, & &1.label)
    assert Enum.any?(labels, &String.contains?(&1, "revoke (malformed)")), inspect(labels)
    assert {:revoke, {:malformed, _}} = AuthorityBody.parse(body)
  end

  test "an honest revoke still renders its 8-character prefix" do
    {sim, good} = base_sim()
    {sim, revoke} = Sim.revoke(sim, "clerk", good.id)
    log = sim |> Sim.sync_all() |> Sim.log("clerk")
    labels = Enum.map(ReplicaSnapshot.build(Matter, log).nodes, & &1.label)
    shown = "revoke " <> String.slice(good.id, 0, 8)
    assert Enum.any?(labels, &String.contains?(&1, shown)), inspect(labels)
    assert {:revoke, {:ok, id}} = AuthorityBody.parse(revoke.body)
    assert id == good.id
  end

  test "invalid UTF-8 role or delegation names never reach the trust graph as text" do
    {sim, good} = base_sim()
    base_edges = ReadModel.observe(Sim.log(sim, "clerk")).trust_graph.edges
    bad_roles = %{good | roles: MapSet.new([<<255>>])}
    bad_ops = %{good | ops: MapSet.new([%Canonical.Atom{name: <<255>>}])}

    for body <- [
          {:transfer, <<255>>, good, 0},
          {:succeed, %Canonical.Atom{name: <<255>>}, good, 0},
          {:grant, bad_roles},
          {:grant, bad_ops}
        ] do
      log = append_log(sim, body)
      model = ReadModel.observe(log, labels: %{}, vouches: [])
      assert is_binary(Jason.encode!(model.trust_graph)), inspect(body)
      assert model.trust_graph.edges -- base_edges == [], inspect(body)
      assert is_binary(ReplicaSnapshot.export(ReplicaSnapshot.build(Matter, log), :json))
    end

    assert {:transfer, {:malformed, <<255>>}, _, _} =
             AuthorityBody.parse({:transfer, <<255>>, good, 0})

    assert {:grant, %{roles: :malformed, well_formed?: true}} =
             AuthorityBody.parse({:grant, bad_roles})
  end

  test "a well-formed delegation with a non-UTF-8 name satisfies the totality shape" do
    good = delegation_template()

    for body <- [
          {:grant, %{good | roles: MapSet.new([<<255>>])}},
          {:grant, %{good | ops: MapSet.new([%Canonical.Atom{name: <<255>>}])}}
        ] do
      parsed = AuthorityBody.parse(body)
      assert {:grant, %{well_formed?: true}} = parsed
      assert parsed_shape?(parsed), inspect(parsed)
    end
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

  defp matter_command_sim do
    sim = Sim.new(Matter, @replica, ["clerk", "resident"], seed: "authority-body-commands")
    {sim, _genesis} = Sim.create_replica(sim, "clerk")

    {sim, _grant} =
      Sim.grant(sim, "clerk", "resident",
        ops: [:set_title, :set_summary, :post, :admit, :remove_member]
      )

    Sim.sync_all(sim)
  end

  defp raw_reached?(raw, :set_title, arg), do: raw.title == arg
  defp raw_reached?(raw, :set_summary, arg), do: raw.summary == arg
  defp raw_reached?(raw, :post, arg), do: List.last(raw.posts) == arg
  defp raw_reached?(raw, :admit, arg), do: arg in raw.members
  defp raw_reached?(raw, :remove_member, arg), do: arg not in raw.members

  defp model_text_slots(model) do
    [model.threads.title, model.threads.summary | model.threads.posts] ++
      model.members.current ++ Enum.map(model.members.denied, & &1.member)
  end

  defp display_text?(text), do: is_binary(text) and String.valid?(text)

  defp append_log(sim, body) do
    {sim, _op} = Sim.append(sim, "clerk", :authority, body)
    sim |> Sim.sync_all() |> Sim.log("clerk")
  end
end
