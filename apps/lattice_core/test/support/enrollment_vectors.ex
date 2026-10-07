defmodule Treehouse.EnrollmentVectors do
  @moduledoc """
  Test-only Treehouse invitation, join and member-post corpus (Plan 181 slice 1a).

  Each scenario drives the real `Lattice.Sim` through the invite, accept, admit and
  grant flow (or one named negative) and exports the signed frames, the exact
  per-op authoring inputs (author, dependency frontier, capability), the honored
  and quarantine verdicts with exact reasons, and the `Treehouse.ReadModel`
  observation. The TS enrollment module (slice 1b) must reproduce these op ids
  from the same public seeds, replica strings and dependency frontiers.

  The seeds are public synthetic test strings. `sha256(seed)` is the Ed25519
  private seed, exactly as `Lattice.Identity.from_seed/2` derives it. They are
  not product material and no product path may reuse them.
  """

  alias Lattice.{Authority, Identity, Log, Sim}
  alias Lattice.Authority.Delegation
  alias Lattice.Carrier.Wire
  alias Treehouse.{Invitation, ReadModel, Space, Thread}

  @seed "r13-lite-enrollment"
  @realms ["founder", "joiner", "other"]
  @member_ops [:post, :author_edit, :author_tombstone]
  @lite_route_cap 3

  @doc "The exact bytes of the exported corpus file."
  @spec encode() :: binary()
  def encode, do: Jason.encode!(ordered(build()), pretty: true) <> "\n"

  @doc "Write the corpus as `<out>/treehouse_enrollment/enrollment.json`, byte-stable across runs."
  @spec write(String.t()) :: :ok
  def write(out) do
    dir = Path.join(out, "treehouse_enrollment")
    File.mkdir_p!(dir)
    File.write!(Path.join(dir, "enrollment.json"), encode())
  end

  @doc "Build every scenario in a fixed order."
  @spec build() :: [map()]
  def build do
    [
      join_flow(),
      archived_thread_scope(),
      four_thread_cap(),
      grantless_post(),
      wrong_parent_grant(),
      wrong_recipient_acceptance(),
      scope_mismatch_after_new_thread(),
      revoked_invitation(),
      replayed_admit()
    ]
  end

  @doc "JSON-safe projection: string keys, atom values as text, non-UTF-8 binaries as base64."
  @spec json(term()) :: term()
  def json(%MapSet{} = set), do: set |> Enum.map(&json/1) |> Enum.sort()

  def json(map) when is_map(map) and not is_struct(map),
    do: Map.new(map, fn {key, value} -> {to_string(key), json(value)} end)

  def json(list) when is_list(list), do: Enum.map(list, &json/1)
  def json(tuple) when is_tuple(tuple), do: tuple |> Tuple.to_list() |> json()

  def json(value) when is_atom(value) and value not in [nil, true, false],
    do: Atom.to_string(value)

  def json(value) when is_binary(value),
    do: if(String.valid?(value), do: value, else: Base.encode64(value))

  def json(value), do: value

  # --- Scenarios ------------------------------------------------------------

  defp join_flow do
    b =
      new("join_flow")
      |> found("space", Space, "space genesis")
      |> found("thread:general", Thread, "thread genesis")

    ref = thread_ref(b, "thread:general")
    {b, _} = cmd(b, "space", "founder", "name space", :create_space, ["Canopy"])
    {b, _} = cmd(b, "space", "founder", "reference thread", :create_thread, [ref, "General"])
    {b, _} = cmd(b, "thread:general", "founder", "title thread", :create_thread, ["General"])

    {b, invite} =
      cmd(b, "space", "founder", "invite", :issue_invitation, [pub64("joiner"), [ref]])

    {b, _} = admit(b, "admit", invite, "joiner", "joiner")
    {b, _} = grant(b, "thread:general", "joiner", "grant general", @member_ops)
    b = sync(b)
    {b, post} = cmd(b, "thread:general", "joiner", "joiner post", :post, ["from the joiner"])

    {b, _} =
      cmd(b, "thread:general", "joiner", "joiner edit", :author_edit, [
        post.id,
        post.id,
        "from the joiner, edited"
      ])

    finish(b, %{"scope" => [ref]})
  end

  defp archived_thread_scope do
    b =
      new("archived_thread_scope")
      |> found("space", Space, "space genesis")
      |> found("thread:live", Thread, "live genesis")
      |> found("thread:archived", Thread, "archived genesis")

    live = thread_ref(b, "thread:live")
    archived = thread_ref(b, "thread:archived")
    scope = Enum.sort([live, archived])
    {b, _} = cmd(b, "space", "founder", "name space", :create_space, ["Canopy"])
    {b, _} = cmd(b, "space", "founder", "reference live", :create_thread, [live, "Live"])

    {b, _} =
      cmd(b, "space", "founder", "reference archived", :create_thread, [archived, "Archived"])

    {b, _} = cmd(b, "thread:live", "founder", "title live", :create_thread, ["Live"])
    {b, _} = cmd(b, "thread:archived", "founder", "title archived", :create_thread, ["Archived"])
    {b, _} = cmd(b, "thread:archived", "founder", "archive", :archive_thread, [])
    # The archived Thread cannot be dropped from the signed scope.
    {b, _} =
      cmd(b, "space", "founder", "invite without archived", :issue_invitation, [
        pub64("joiner"),
        [live]
      ])

    {b, invite} =
      cmd(b, "space", "founder", "invite", :issue_invitation, [pub64("joiner"), scope])

    {b, _} = admit(b, "admit", invite, "joiner", "joiner")
    {b, _} = grant(b, "thread:live", "joiner", "grant live", @member_ops)
    {b, _} = grant(b, "thread:archived", "joiner", "grant archived", @member_ops)
    b = sync(b)
    {b, _} = cmd(b, "thread:live", "joiner", "post to live", :post, ["live post"])
    {b, _} = cmd(b, "thread:archived", "joiner", "post to archived", :post, ["late post"])
    finish(b, %{"scope" => scope, "archivedReplicas" => [archived]})
  end

  defp four_thread_cap do
    b = new("four_thread_cap") |> found("space", Space, "space genesis")
    refs = for n <- 1..4, do: thread_ref(b, "thread:#{n}")
    {b, _} = cmd(b, "space", "founder", "name space", :create_space, ["Canopy"])

    b =
      refs
      |> Enum.with_index(1)
      |> Enum.reduce(b, fn {ref, n}, b ->
        {b, _} =
          cmd(b, "space", "founder", "reference thread #{n}", :create_thread, [ref, "Thread #{n}"])

        b
      end)

    scope = Enum.sort(refs)

    {b, _} =
      cmd(b, "space", "founder", "invite three", :issue_invitation, [
        pub64("joiner"),
        Enum.take(scope, 3)
      ])

    {b, _} =
      cmd(b, "space", "founder", "invite all four", :issue_invitation, [pub64("joiner"), scope])

    finish(b, %{
      "scope" => scope,
      "honoredThreads" => length(scope),
      "liteRouteCap" => @lite_route_cap,
      "liteRefusal" => "thread_scope_exceeds_routes"
    })
  end

  defp grantless_post do
    b =
      new("grantless_post")
      |> found("space", Space, "space genesis")
      |> found("thread:general", Thread, "thread genesis")

    ref = thread_ref(b, "thread:general")
    {b, _} = cmd(b, "space", "founder", "name space", :create_space, ["Canopy"])
    {b, _} = cmd(b, "space", "founder", "reference thread", :create_thread, [ref, "General"])
    {b, _} = cmd(b, "thread:general", "founder", "title thread", :create_thread, ["General"])

    {b, invite} =
      cmd(b, "space", "founder", "invite", :issue_invitation, [pub64("joiner"), [ref]])

    {b, _} = admit(b, "admit", invite, "joiner", "joiner")
    b = sync(b)

    {b, _} =
      cmd(b, "thread:general", "joiner", "post without capability", :post, ["no capability"],
        cap: :none
      )

    {b, _} =
      cmd(b, "thread:general", "joiner", "post under unknown capability", :post, ["unknown"],
        cap: "unknown-capability"
      )

    {b, edit_only} = grant(b, "thread:general", "joiner", "grant lacking post", [:author_edit])
    b = sync(b)

    {b, _} =
      cmd(
        b,
        "thread:general",
        "joiner",
        "post under capability lacking post",
        :post,
        ["wrong op"],
        cap: edit_only.id
      )

    {b, no_role} =
      grant(b, "thread:general", "joiner", "grant archive without moderator", [
        :post,
        :archive_thread
      ])

    b = sync(b)

    {b, _} =
      cmd(
        b,
        "thread:general",
        "joiner",
        "archive under capability lacking moderator",
        :archive_thread,
        [],
        cap: no_role.id
      )

    finish(b, %{})
  end

  defp wrong_parent_grant do
    b = new("wrong_parent_grant") |> found("thread:general", Thread, "thread genesis")
    {b, _} = cmd(b, "thread:general", "founder", "title thread", :create_thread, ["General"])
    sim = b.sims["thread:general"]
    founder = Sim.identity(sim, "founder")
    joiner = Sim.identity(sim, "joiner")

    unrooted =
      Delegation.new(founder, sim.replica, joiner.pub,
        parent_id: nil,
        ops: @member_ops,
        roles: [],
        live: false
      )

    {b, _} =
      append(
        b,
        "thread:general",
        "founder",
        "grant with unrooted parent",
        :authority,
        {:grant, unrooted}
      )

    b = sync(b)

    {b, _} =
      cmd(b, "thread:general", "joiner", "post under unrooted grant", :post, ["unrooted"],
        cap: unrooted.id
      )

    finish(b, %{})
  end

  defp wrong_recipient_acceptance do
    b = new("wrong_recipient_acceptance") |> found("space", Space, "space genesis")
    ref = thread_ref(b, "thread:general")
    {b, _} = cmd(b, "space", "founder", "name space", :create_space, ["Canopy"])
    {b, _} = cmd(b, "space", "founder", "reference thread", :create_thread, [ref, "General"])

    {b, invite} =
      cmd(b, "space", "founder", "invite", :issue_invitation, [pub64("joiner"), [ref]])

    {b, _} = admit(b, "admit with other's acceptance", invite, "joiner", "other")

    {b, _} =
      cmd(b, "space", "founder", "admit with wrong replica acceptance", :admit_member, [
        invite.id,
        pub64("joiner"),
        "member",
        Invitation.accept(identity("joiner"), "treehouse:r13:another-space", invite)
      ])

    {b, _} = admit(b, "admit naming other", invite, "other", "other")
    finish(b, %{})
  end

  defp scope_mismatch_after_new_thread do
    b = new("scope_mismatch_after_new_thread") |> found("space", Space, "space genesis")
    first = thread_ref(b, "thread:first")
    second = thread_ref(b, "thread:second")
    {b, _} = cmd(b, "space", "founder", "name space", :create_space, ["Canopy"])
    {b, _} = cmd(b, "space", "founder", "reference first", :create_thread, [first, "First"])

    {b, stale} =
      cmd(b, "space", "founder", "invite", :issue_invitation, [pub64("joiner"), [first]])

    {b, _} = cmd(b, "space", "founder", "reference second", :create_thread, [second, "Second"])
    {b, _} = admit(b, "admit with stale scope", stale, "joiner", "joiner")

    {b, _} =
      cmd(b, "space", "founder", "issue with stale scope", :issue_invitation, [
        pub64("joiner"),
        [first]
      ])

    scope = Enum.sort([first, second])

    {b, fresh} =
      cmd(b, "space", "founder", "issue with fresh scope", :issue_invitation, [
        pub64("joiner"),
        scope
      ])

    {b, _} = admit(b, "admit with fresh scope", fresh, "joiner", "joiner")
    finish(b, %{"scope" => scope})
  end

  defp revoked_invitation do
    b = new("revoked_invitation") |> found("space", Space, "space genesis")
    ref = thread_ref(b, "thread:general")
    {b, _} = cmd(b, "space", "founder", "name space", :create_space, ["Canopy"])
    {b, _} = cmd(b, "space", "founder", "reference thread", :create_thread, [ref, "General"])

    {b, invite} =
      cmd(b, "space", "founder", "invite", :issue_invitation, [pub64("joiner"), [ref]])

    {b, _} = cmd(b, "space", "founder", "revoke", :revoke_invitation, [invite.id])
    {b, _} = admit(b, "admit after revoke", invite, "joiner", "joiner")
    finish(b, %{})
  end

  defp replayed_admit do
    b = new("replayed_admit") |> found("space", Space, "space genesis")
    ref = thread_ref(b, "thread:general")
    {b, _} = cmd(b, "space", "founder", "name space", :create_space, ["Canopy"])
    {b, _} = cmd(b, "space", "founder", "reference thread", :create_thread, [ref, "General"])

    {b, invite} =
      cmd(b, "space", "founder", "invite", :issue_invitation, [pub64("joiner"), [ref]])

    {b, _} = admit(b, "admit", invite, "joiner", "joiner")
    {b, _} = admit(b, "admit again", invite, "joiner", "joiner")
    finish(b, %{})
  end

  # --- Builder --------------------------------------------------------------

  defp new(name), do: %{name: name, labels: [], sims: %{}, modules: %{}, steps: []}

  defp found(b, label, module, step_label) do
    sim = Sim.new(module, "treehouse:r13:#{b.name}:#{label}", @realms, seed: @seed)
    {sim, genesis} = Sim.create_replica(sim, "founder")

    b = %{
      b
      | labels: b.labels ++ [label],
        sims: Map.put(b.sims, label, sim),
        modules: Map.put(b.modules, label, module)
    }

    {b, _} = record(b, label, "founder", step_label, genesis)
    b
  end

  defp cmd(b, label, realm, step_label, command, args, opts \\ []) do
    {sim, op} = Sim.command(b.sims[label], realm, command, args, opts)
    record(put_sim(b, label, sim), label, realm, step_label, op)
  end

  defp append(b, label, realm, step_label, kind, body) do
    {sim, op} = Sim.append(b.sims[label], realm, kind, body)
    record(put_sim(b, label, sim), label, realm, step_label, op)
  end

  # The exact-audience Thread grant is a Sim grant, so its parent is the founder's root delegation.
  defp grant(b, label, audience, step_label, ops) do
    {sim, delegation} = Sim.grant(b.sims[label], "founder", audience, ops: ops)

    op =
      sim
      |> Sim.log("founder")
      |> Log.topo_ops()
      |> Enum.find(fn op -> match?({:grant, %{id: id}} when id == delegation.id, op.body) end)

    {b, _} = record(put_sim(b, label, sim), label, "founder", step_label, op)
    {b, delegation}
  end

  defp admit(b, step_label, invite, recipient_realm, signer_realm) do
    space = b.sims["space"]
    acceptance = Invitation.accept(identity(signer_realm), Sim.replica(space), invite)

    cmd(b, "space", "founder", step_label, :admit_member, [
      invite.id,
      pub64(recipient_realm),
      "member",
      acceptance
    ])
  end

  defp put_sim(b, label, sim), do: %{b | sims: Map.put(b.sims, label, sim)}

  defp sync(b) do
    sims = Map.new(b.sims, fn {label, sim} -> {label, Sim.sync_all(sim)} end)
    step = %{type: "sync", label: "sync", logs: b.labels}
    %{b | sims: sims, steps: [step | b.steps]}
  end

  defp record(b, label, realm, step_label, op) do
    step = %{
      label: step_label,
      log: label,
      realm: realm,
      id: op.id,
      kind: Atom.to_string(op.kind),
      deps: op.deps,
      cap: op.cap,
      input: step_input(op)
    }

    {%{b | steps: [step | b.steps]}, op}
  end

  defp step_input(%{kind: :authority, body: {:genesis, d, _policies}}) do
    %{
      "type" => "genesis",
      "delegationId" => d.id,
      "ops" => names(d.ops),
      "roles" => names(d.roles),
      "live" => d.live
    }
  end

  defp step_input(%{kind: :authority, body: {:grant, d}}) do
    %{
      "type" => "grant",
      "delegationId" => d.id,
      "audience" => audience_realm(d.audience),
      "audiencePub" => Base.encode64(d.audience),
      "parentId" => d.parent_id,
      "ops" => names(d.ops),
      "roles" => names(d.roles),
      "live" => d.live,
      "expiresEpoch" => d.expires_epoch
    }
  end

  defp step_input(%{kind: :command, body: {command, args}}),
    do: %{"type" => "command", "command" => Atom.to_string(command), "args" => json(args)}

  defp step_input(_), do: %{"type" => "other"}

  defp names(set), do: set |> Enum.map(&to_string/1) |> Enum.sort()

  defp audience_realm(pub) do
    Enum.find(@realms, &(identity(&1).pub == pub))
  end

  defp finish(b, expect) do
    b = sync(b)

    logs =
      for label <- b.labels do
        sim = b.sims[label]

        ids =
          for {_, log} <- sim.logs, do: log |> Log.topo_ops() |> Enum.map(& &1.id) |> Enum.sort()

        if Enum.uniq(ids) |> length() != 1,
          do: raise("#{b.name}/#{label} did not converge before export")

        log_entry(label, b.modules[label], Sim.log(sim, "founder"))
      end

    %{
      name: b.name,
      seeds: Map.new(@realms, &{&1, "#{@seed}:#{&1}"}),
      pubkeys: Map.new(@realms, &{&1, pub64(&1)}),
      logs: logs,
      steps: Enum.reverse(b.steps),
      expect: expect
    }
  end

  defp log_entry(label, module, log) do
    ops = Log.topo_ops(log)
    order = Enum.map(ops, & &1.id)
    reasons = json(Authority.analyze(module, log).reasons)

    %{
      label: label,
      product: product(module),
      replica: log.replica,
      frames: Enum.map(ops, &Wire.encode_op/1),
      order: order,
      honored: Enum.reject(order, &Map.has_key?(reasons, &1)),
      reasons: reasons,
      observed: observed(module, log)
    }
  end

  defp observed(module, log) do
    view = ReadModel.observe(module, log)

    view
    |> Map.update!(:holders, fn holders ->
      Map.new(holders, fn {role, pub} -> {role, pub && Base.encode64(pub)} end)
    end)
    |> Map.update!(:posts, fn posts ->
      Enum.map(posts, &Map.update!(&1, :author, fn author -> Base.encode64(author) end))
    end)
    |> json()
  end

  defp product(Space), do: "Treehouse.Space"
  defp product(Thread), do: "Treehouse.Thread"

  defp identity(realm), do: Identity.from_seed(realm, "#{@seed}:#{realm}")
  defp pub64(realm), do: realm |> identity() |> Map.fetch!(:pub) |> Base.encode64()

  defp thread_ref(b, label),
    do: Authority.bind_replica("treehouse:r13:#{b.name}:#{label}", identity("founder").pub)

  defp ordered(value) when is_map(value) do
    value
    |> Enum.map(fn {key, item} -> {to_string(key), ordered(item)} end)
    |> Enum.sort_by(&elem(&1, 0))
    |> Jason.OrderedObject.new()
  end

  defp ordered(value) when is_list(value), do: Enum.map(value, &ordered/1)
  defp ordered(value), do: value
end
