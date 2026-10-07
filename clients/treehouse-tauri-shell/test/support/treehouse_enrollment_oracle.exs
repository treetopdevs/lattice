# Plan 181 slice 4 oracle: replay the observed gate scenario through `Lattice.Sim` and compare.
#
# Inputs, all JSON in <dir>:
#   trace.json     the replica strings, the command order and the observed sync points. It carries no
#                  post text (text keys only) and no key material.
#   texts.json     the post texts by key. Private: it is an input to this script and never uploaded.
#   observed.json  what the real run produced: relay log paths, both stores, a fresh observer pull.
#
# The oracle derives every op's dependencies from `Lattice.Sim` alone. It never reads a dep from the
# observed frames, so equality is not tautological. The compared surfaces, in both directions, are:
# op ids, byte-equal wire frames (signature included), canonical state, and the exact quarantine reason
# map. Four negative controls must each make the comparison fail: dropping the sync that fixes an op's
# dependency frontier, dropping one id, changing one frame byte, and skipping the grant.
#
# usage: treehouse_enrollment_oracle.exs <dir>
alias Lattice.{Authority, Identity, Log, Sim, Sync}
alias Lattice.Carrier.Wire
alias Treehouse.{Invitation, ReadModel, Space, Thread}

defmodule TreehouseGateOracle do
  @commands %{
    "create_space" => :create_space,
    "create_thread" => :create_thread,
    "post" => :post
  }
  # The shell's "legacy root only" Space profile signs this fixed capability ceiling at genesis
  # (`prepareTreehouseSpaceCreation`). It is stated here as an independent expectation, never read back
  # from the observed frames. The Thread genesis takes the full Thread command registry, as the Sim does.
  @space_genesis_ops [
    :create_space,
    :create_thread,
    :issue_invitation,
    :revoke_invitation,
    :admit_member,
    :remove_member
  ]
  @ops %{
    "post" => :post,
    "author_edit" => :author_edit,
    "author_tombstone" => :author_tombstone
  }

  def module_for("Treehouse.Space"), do: Space
  def module_for("Treehouse.Thread"), do: Thread

  # --- Replay ---------------------------------------------------------------------------------

  def replay(trace, texts) do
    logs = Map.new(trace["logs"], &{&1["label"], &1})

    state = %{
      sims: %{},
      invites: %{},
      logs: logs,
      namespace: trace["namespace"],
      realms: trace["realms"]
    }

    state = Enum.reduce(trace["events"], state, &apply_event(&1, &2, texts))

    # One last full sync, then every realm must hold the same log.
    sims = Map.new(state.sims, fn {label, sim} -> {label, Sim.sync_all(sim)} end)

    for {label, sim} <- sims do
      ids =
        for {_realm, log} <- sim.logs,
            do: log |> Log.topo_ops() |> Enum.map(& &1.id) |> Enum.sort()

      if length(Enum.uniq(ids)) != 1, do: raise("#{label}: Sim realms did not converge")
    end

    %{state | sims: sims}
  end

  defp apply_event(%{"type" => "found", "log" => label}, state, _texts) do
    entry = Map.fetch!(state.logs, label)
    [name | _] = String.split(entry["replica"], "#root:")
    sim = Sim.new(module_for(entry["product"]), name, state.realms, seed: state.namespace)
    opts = if entry["product"] == "Treehouse.Space", do: [ops: @space_genesis_ops], else: []
    {sim, _genesis} = Sim.create_replica(sim, "founder", opts)

    if Sim.replica(sim) != entry["replica"],
      do:
        raise("#{label}: Sim replica #{Sim.replica(sim)} is not the observed #{entry["replica"]}")

    put_in(state.sims[label], sim)
  end

  defp apply_event(%{"type" => "command"} = ev, state, texts) do
    sim = Map.fetch!(state.sims, ev["log"])
    args = Enum.map(ev["args"], &arg(&1, state, texts))
    opts = if ev["cap"] == "none", do: [cap: :none], else: []
    {sim, _op} = Sim.command(sim, ev["realm"], Map.fetch!(@commands, ev["command"]), args, opts)
    put_in(state.sims[ev["log"]], sim)
  end

  defp apply_event(%{"type" => "invite"} = ev, state, _texts) do
    sim = Map.fetch!(state.sims, ev["log"])
    threads = ev["threads"] |> Enum.map(&Sim.replica(Map.fetch!(state.sims, &1))) |> Enum.sort()
    args = [pub64(sim, ev["recipient"]), threads]
    {sim, op} = Sim.command(sim, ev["realm"], :issue_invitation, args)
    state = put_in(state.sims[ev["log"]], sim)
    put_in(state.invites[ev["ref"]], op)
  end

  defp apply_event(%{"type" => "admit"} = ev, state, _texts) do
    sim = Map.fetch!(state.sims, ev["log"])
    invite = Map.fetch!(state.invites, ev["invite"])
    acceptance = Invitation.accept(Sim.identity(sim, ev["signer"]), Sim.replica(sim), invite)

    {sim, _op} =
      Sim.command(sim, ev["realm"], :admit_member, [
        invite.id,
        pub64(sim, ev["recipient"]),
        "member",
        acceptance
      ])

    put_in(state.sims[ev["log"]], sim)
  end

  defp apply_event(%{"type" => "grant"} = ev, state, _texts) do
    sim = Map.fetch!(state.sims, ev["log"])
    ops = Enum.map(ev["ops"], &Map.fetch!(@ops, &1))
    {sim, _delegation} = Sim.grant(sim, ev["issuer"], ev["audience"], ops: ops)
    put_in(state.sims[ev["log"]], sim)
  end

  defp apply_event(%{"type" => "sync"} = ev, state, _texts) do
    labels = ev["logs"] || Map.keys(state.sims)
    sims = Enum.reduce(labels, state.sims, fn l, acc -> Map.update!(acc, l, &Sim.sync_all/1) end)
    %{state | sims: sims}
  end

  defp apply_event(%{"type" => "partition"}, state, _texts),
    do: %{
      state
      | sims: Map.new(state.sims, fn {l, s} -> {l, Sim.partition(s, "founder", "joiner")} end)
    }

  defp apply_event(%{"type" => "heal"}, state, _texts),
    do: %{
      state
      | sims: Map.new(state.sims, fn {l, s} -> {l, Sim.heal(s, "founder", "joiner")} end)
    }

  defp arg(%{"replicaOf" => label}, state, _texts), do: Sim.replica(Map.fetch!(state.sims, label))
  defp arg(%{"textKey" => key}, _state, texts), do: Map.fetch!(texts, key)
  defp arg(value, _state, _texts), do: value

  defp pub64(sim, realm), do: sim |> Sim.identity(realm) |> Map.fetch!(:pub) |> Base.encode64()

  # --- Expected surfaces from the Sim --------------------------------------------------------

  def expected(state) do
    for {label, sim} <- state.sims, into: %{} do
      module = sim.module
      log = Sim.log(sim, "founder")
      ops = Log.topo_ops(log)

      {label,
       %{
         module: module,
         replica: log.replica,
         frames: Map.new(ops, &{&1.id, frame(&1)}),
         reasons: reasons(module, log),
         state: observed(module, log)
       }}
    end
  end

  def frame(op), do: op |> Wire.encode_op() |> Jason.encode!() |> Jason.decode!()

  def reasons(module, log), do: module |> Authority.analyze(log) |> Map.fetch!(:reasons) |> json()

  def observed(module, log) do
    module
    |> ReadModel.observe(log)
    |> Map.update!(:holders, fn holders ->
      Map.new(holders, fn {role, pub} -> {role, pub && Base.encode64(pub)} end)
    end)
    |> Map.update!(:posts, fn posts ->
      Enum.map(posts, &Map.update!(&1, :author, fn author -> Base.encode64(author) end))
    end)
    |> json()
  end

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

  # --- Comparison ------------------------------------------------------------------------------

  @doc "Every observed source against the Sim expectation. Returns a list of failure strings."
  def compare(expected, observed, participants, forbidden) do
    sources(expected, observed)
    |> Enum.flat_map(fn {source, label, loaded} ->
      want = Map.fetch!(expected, label)
      check(source, label, want, loaded, participants, forbidden)
    end)
    |> Kernel.++(store_discipline(observed))
    |> Kernel.++(missing_logs(expected, observed))
  end

  # [{source_name, label, {:frames, [map]} | {:log, Log} | {:error, why}}]
  defp sources(expected, observed) do
    relay =
      for {label, path} <- observed["relayLogs"], Map.has_key?(expected, label) do
        case Log.restore(path) do
          {:ok, log} ->
            structural = Log.quarantine(log)

            if structural == [],
              do: {"relay", label, {:frames, log |> Log.topo_ops() |> Enum.map(&frame/1)}},
              else: {"relay", label, {:error, "structural quarantine on the relay log"}}

          {:error, why} ->
            {"relay", label, {:error, "unreadable relay log: #{inspect(why)}"}}
        end
      end

    stores =
      for {who, store} <- observed["stores"], profile <- store["profiles"] do
        {"#{who} store", profile["label"], {:frames, profile["frames"]}}
      end

    observer =
      for {label, frames} <- observed["observer"], do: {"observer pull", label, {:frames, frames}}

    relay ++ stores ++ observer
  end

  defp missing_logs(expected, observed) do
    for label <- Map.keys(expected),
        not Map.has_key?(observed["relayLogs"], label) or
          not Map.has_key?(observed["observer"], label),
        do: "#{label}: not observed on the relay or by the observer"
  end

  defp check(source, label, _want, {:error, why}, _participants, _forbidden),
    do: ["#{source}/#{label}: #{why}"]

  defp check(source, label, want, {:frames, frames}, participants, forbidden) do
    prefix = "#{source}/#{label}"
    got = Map.new(frames, &{&1["id"], &1})

    id_failures =
      cond do
        length(frames) != map_size(got) ->
          ["#{prefix}: duplicate ids"]

        true ->
          missing = Map.keys(want.frames) -- Map.keys(got)
          extra = Map.keys(got) -- Map.keys(want.frames)

          if missing == [] and extra == [],
            do: [],
            else: ["#{prefix}: ids differ (missing #{length(missing)}, extra #{length(extra)})"]
      end

    frame_failures =
      for {id, theirs} <- got,
          mine = Map.get(want.frames, id),
          mine != nil,
          mine != theirs,
          do: "#{prefix}: frame #{id} is not byte-equal to the Sim frame"

    if id_failures ++ frame_failures != [] do
      id_failures ++ frame_failures
    else
      derived(prefix, label, want, frames, participants, forbidden)
    end
  end

  # Ids and frames match, so the derived surfaces come from the observed frames themselves.
  defp derived(prefix, _label, want, frames, participants, forbidden) do
    with {:ok, ops} <- Wire.decode_ops(frames),
         {log, %{pending: [], rejected: [], quarantined: []}} <-
           Sync.deliver(Log.new(want.replica), ops) do
      authors = ops |> Enum.map(&Base.encode64(&1.author)) |> Enum.uniq()

      author_failures =
        for author <- authors,
            author not in participants or author in forbidden,
            do: "#{prefix}: op authored by a non-participant key"

      reason_failures =
        if reasons(want.module, log) == want.reasons,
          do: [],
          else: ["#{prefix}: quarantine reason map differs from the Sim"]

      state_failures =
        if observed(want.module, log) == want.state,
          do: [],
          else: ["#{prefix}: canonical state differs from the Sim"]

      author_failures ++ reason_failures ++ state_failures
    else
      other ->
        ["#{prefix}: observed frames do not rebuild a clean log (#{inspect(other, limit: 3)})"]
    end
  end

  # Each store: acked equals retained and nothing is pending.
  defp store_discipline(observed) do
    for {who, store} <- observed["stores"], profile <- store["profiles"] do
      ids = profile["frames"] |> Enum.map(& &1["id"]) |> Enum.sort()
      prefix = "#{who} store/#{profile["label"]}"

      acked =
        if Enum.sort(profile["acked"]) == ids,
          do: [],
          else: ["#{prefix}: acked is not the retained set"]

      pending =
        if profile["outbox"] -- profile["acked"] == [],
          do: [],
          else: ["#{prefix}: pending is not zero"]

      acked ++ pending
    end
    |> List.flatten()
  end

  # The clients' own verdicts, as the app computed them, must equal the Sim's exact reason map.
  def client_reason_failures(expected, observed) do
    for {who, store} <- observed["stores"], profile <- store["profiles"] do
      want = Map.fetch!(expected, profile["label"]).reasons

      if json(profile["reasons"]) == want,
        do: [],
        else: ["#{who} store/#{profile["label"]}: client quarantine reasons differ from the Sim"]
    end
    |> List.flatten()
  end
end

[dir] = System.argv()
read = fn name -> dir |> Path.join(name) |> File.read!() |> Jason.decode!() end
trace = read.("trace.json")
texts = read.("texts.json")
observed = read.("observed.json")

founder_pub =
  Identity.from_seed("founder", "#{trace["namespace"]}:founder").pub |> Base.encode64()

joiner_pub = Identity.from_seed("joiner", "#{trace["namespace"]}:joiner").pub |> Base.encode64()
participants = [founder_pub, joiner_pub]
forbidden = observed["relayPubs"] ++ [observed["observerPub"]]

run = fn trace, observed ->
  state = TreehouseGateOracle.replay(trace, texts)
  expected = TreehouseGateOracle.expected(state)

  failures =
    TreehouseGateOracle.compare(expected, observed, participants, forbidden) ++
      TreehouseGateOracle.client_reason_failures(expected, observed)

  {failures, expected}
end

{failures, expected} = run.(trace, observed)

if failures != [] do
  IO.puts(:stderr, "ORACLE_FAILED\n" <> Enum.join(failures, "\n"))
  System.halt(1)
end

# --- Negative controls: each mutated input must make the comparison fail --------------------------

drop_event = fn trace, pred ->
  index = Enum.find_index(trace["events"], pred)
  if index == nil, do: raise("control target not found")
  %{trace | "events" => List.delete_at(trace["events"], index)}
end

# Perturb one dependency frontier: a sync inserted just before the forged post hands the joiner the
# grant, so its authored deps (and therefore its id) change.
forged_at =
  Enum.find_index(trace["events"], fn ev ->
    ev["type"] == "command" and ev["cap"] == "none"
  end)

# A trace with no forged post (the packaged UI cannot forge one) perturbs a different frontier: dropping
# the sync point that precedes the first founder authoring step after a joiner authoring step leaves the
# founder without the joiner's operation, so the founder's deps (and id) change.
drop_founder_sync = fn trace ->
  events = trace["events"]
  authored = fn ev, realm -> ev["type"] == "command" and ev["realm"] == realm end
  first_joiner = Enum.find_index(events, &authored.(&1, "joiner"))

  reply =
    first_joiner &&
      events
      |> Enum.with_index()
      |> Enum.find_value(fn {ev, i} ->
        if i > first_joiner and authored.(ev, "founder"), do: i
      end)

  sync_before =
    reply &&
      events
      |> Enum.with_index()
      |> Enum.filter(fn {ev, i} -> i < reply and ev["type"] == "sync" end)
      |> List.last()

  if sync_before == nil, do: raise("perturb control target not found")
  %{trace | "events" => List.delete_at(events, elem(sync_before, 1))}
end

perturbed =
  if forged_at do
    %{
      trace
      | "events" =>
          List.insert_at(trace["events"], forged_at, %{"type" => "sync", "logs" => ["general"]})
    }
  else
    drop_founder_sync.(trace)
  end

mutate_frames = fn observed, who, label, fun ->
  stores =
    Map.update!(observed["stores"], who, fn store ->
      Map.update!(store, "profiles", fn profiles ->
        Enum.map(profiles, fn p ->
          if p["label"] == label, do: Map.update!(p, "frames", fun), else: p
        end)
      end)
    end)

  %{observed | "stores" => stores}
end

flip = fn frames ->
  [first | rest] = Enum.sort_by(frames, & &1["id"])
  sig = first["sig"]
  swapped = if String.at(sig, 4) == "A", do: "B", else: "A"
  [%{first | "sig" => String.slice(sig, 0, 4) <> swapped <> String.slice(sig, 5..-1//1)} | rest]
end

# A replay that cannot even be built (no capability for a command) also counts as a failed comparison.
rejected = fn trace, observed ->
  try do
    elem(run.(trace, observed), 0) != []
  rescue
    _error -> true
  end
end

controls = %{
  "perturb_dep" => rejected.(perturbed, observed),
  "drop_id" =>
    rejected.(trace, mutate_frames.(observed, "joiner", "general", fn frames -> tl(frames) end)),
  "flip_byte" => rejected.(trace, mutate_frames.(observed, "founder", "space", flip)),
  "skip_grant" =>
    rejected.(
      drop_event.(trace, fn ev -> ev["type"] == "grant" and ev["log"] == "general" end),
      observed
    )
}

if not Enum.all?(Map.values(controls), & &1) do
  IO.puts(:stderr, "ORACLE_CONTROL_FAILED #{inspect(controls)}")
  System.halt(1)
end

out = %{
  ok: true,
  controls: controls,
  logs:
    for(
      {label, want} <- Enum.sort(expected),
      do: %{
        label: label,
        ops: map_size(want.frames),
        ids: want.frames |> Map.keys() |> Enum.sort()
      }
    ),
  reasons: Map.new(expected, fn {label, want} -> {label, want.reasons} end)
}

File.write!(Path.join(dir, "oracle_out.json"), Jason.encode!(out, pretty: true))
IO.puts("ORACLE_OK #{map_size(expected)} logs")
