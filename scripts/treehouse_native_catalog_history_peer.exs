# Real BEAM DAG/signature peer. A DAG result carries no authority judgment.
alias Lattice.{Canonical, Log, Op}
alias Lattice.Authority.Delegation
alias Lattice.Carrier.Wire
alias Treehouse.{CatalogCutoff, CatalogTrustVectors, CatalogVectors}
Code.ensure_loaded!(CatalogTrustVectors)
_ = [:post]

graph = fn log ->
  %{
    replica: log.replica,
    frames: log.ops |> Map.values() |> Enum.sort_by(& &1.id) |> Enum.map(&Wire.encode_op/1),
    order: Enum.map(Log.topo_ops(log), & &1.id),
    frontier: Enum.sort(Log.frontier(log))
  }
end

cutoff_result = fn log ->
  case CatalogCutoff.derive(log) do
    {:ok, result} ->
      %{
        ok: true,
        cutoff: %{
          replica: result.cutoff.replica,
          frontier: Enum.sort(result.cutoff.frontier),
          logDigest: result.cutoff.log_digest
        },
        canonicalBytes: Base.encode64(result.canonical_bytes)
      }

    {:error, reason} ->
      %{ok: false, reason: reason}
  end
end

cutoff_input = fn name, log ->
  %{
    name: name,
    replica: log.replica,
    frames: Enum.map(Log.topo_ops(log), &Wire.encode_op/1),
    rejected:
      Enum.map(Log.quarantine(log), &%{frame: Wire.encode_op(&1.op), reason: "bad_signature"})
  }
end

case System.argv() do
  ["produce"] ->
    fixture = CatalogTrustVectors.fixture(2)
    logs = [fixture.space_log | Enum.map(fixture.threads, & &1.log)]

    term = %Delegation{
      id: "",
      replica: "",
      parent_id: "",
      issuer: :binary.copy(<<7>>, 32),
      audience: :binary.copy(<<7>>, 32),
      ops: MapSet.new(),
      roles: MapSet.new(),
      live: true,
      sig: :binary.copy(<<0>>, 64)
    }

    IO.puts(
      Jason.encode!(%{
        histories: Enum.map(logs, graph),
        terms: [%{term: Wire.encode_value(term), bytes: Base.encode64(Canonical.term(term))}]
      })
    )

  ["consume"] ->
    input = IO.read(:stdio, :eof) |> Jason.decode!()

    Enum.each(input["histories"], fn history ->
      ops =
        Enum.map(history["frames"], fn frame ->
          {:ok, %Op{} = op} = Wire.decode_op(frame)
          true = Op.valid?(op)
          op
        end)

      log = Log.from_ops(history["replica"], Map.new(ops, &{&1.id, &1}))
      :ok = Log.verify_authenticity(log)
      true = map_size(log.ops) == length(ops)
      actual = graph.(log)
      true = actual.order == history["order"]
      true = actual.frontier == history["frontier"]
    end)

    IO.puts(Jason.encode!(%{histories: length(input["histories"])}))

  ["space-policy-cases"] ->
    IO.puts(Jason.encode!(%{histories: Treehouse.MemberContinuitySemanticVectors.corpus().cases}))

  [mode] when mode in ["space-policy", "space-projection"] ->
    input = IO.read(:stdio, :eof) |> Jason.decode!()

    results =
      Enum.map(input["histories"], fn h ->
        {:ok, ops} = Wire.decode_ops(h["frames"])
        log = Log.from_ops(h["replica"], Map.new(ops, &{&1.id, &1}))
        :ok = Log.verify_authenticity(log)
        analysis = Lattice.Authority.analyze(Treehouse.Space, log)

        reasons =
          Map.new(Enum.filter(ops, &(&1.kind == :command)), &{&1.id, analysis.reasons[&1.id]})

        if mode == "space-policy" do
          reasons
        else
          view = Treehouse.ReadModel.observe(Treehouse.Space, log)

          %{
            commandReasons: reasons,
            state: view.state,
            initialization: view.initialization,
            holders:
              Map.new(view.holders, fn {role, holder} ->
                {role, holder && Base.encode64(holder)}
              end)
          }
        end
      end)

    IO.puts(Jason.encode!(%{results: results}))

  [mode] when mode in ["thread-policy", "thread-projection"] ->
    input = IO.read(:stdio, :eof) |> Jason.decode!()

    results =
      Enum.map(input["histories"], fn history ->
        {:ok, ops} = Wire.decode_ops(history["frames"])
        log = Log.from_ops(history["replica"], Map.new(ops, &{&1.id, &1}))
        :ok = Log.verify_authenticity(log)
        analysis = Lattice.Authority.analyze(Treehouse.Thread, log)

        reasons =
          Map.new(Enum.filter(ops, &(&1.kind == :command)), &{&1.id, analysis.reasons[&1.id]})

        if mode == "thread-policy" do
          reasons
        else
          view = Treehouse.ReadModel.observe(Treehouse.Thread, log)

          %{
            commandReasons: reasons,
            title: view.state.title,
            moderation: view.state.moderation,
            archived: view.state.archived,
            moderator: view.holders[:moderator] && Base.encode64(view.holders[:moderator]),
            posts:
              Enum.map(view.posts, &%{id: &1.id, author: Base.encode64(&1.author), text: &1.text})
          }
        end
      end)

    IO.puts(Jason.encode!(%{results: results}))

  ["command-gates"] ->
    input = IO.read(:stdio, :eof) |> Jason.decode!()

    results =
      Enum.map(input["histories"], fn history ->
        {:ok, ops} = Wire.decode_ops(history["frames"])
        true = Enum.all?(ops, &Op.valid?/1)
        log = Log.from_ops(history["replica"], Map.new(ops, &{&1.id, &1}))
        :ok = Log.verify_authenticity(log)

        module =
          if String.starts_with?(log.replica, "replica:treehouse:space:"),
            do: Treehouse.Space,
            else: Treehouse.Thread

        Code.ensure_loaded!(module)
        analysis = Lattice.Authority.analyze(module, log)

        Map.new(Enum.filter(ops, &(&1.kind == :command)), fn op ->
          effects =
            case op.body do
              {command, args} when is_atom(command) and is_list(args) ->
                case Lattice.Replica.command_effects(module, command, args) do
                  {:ok, effects} -> effects
                  {:error, _} -> nil
                end

              _ ->
                nil
            end

          fields = effects && Enum.map(effects, fn {field, _} -> field end)

          roles =
            fields &&
              Enum.map(fields, &module.authority_role/1) |> Enum.reject(&is_nil/1) |> Enum.uniq()

          {op.id, %{reason: analysis.reasons[op.id], fields: fields, roles: roles}}
        end)
      end)

    IO.puts(Jason.encode!(%{results: results}))

  ["authority-cases"] ->
    dir =
      Path.join(
        System.tmp_dir!(),
        "native-authority-beam-#{System.pid()}-#{System.unique_integer([:positive])}"
      )

    File.mkdir!(dir)

    try do
      :ok = Lattice.ContinuationVectors.write(dir)
      data = File.read!(Path.join([dir, "continuation", "authority.json"])) |> Jason.decode!()
      IO.puts(Jason.encode!(%{histories: data}))
    after
      File.rm_rf!(dir)
    end

  ["authority"] ->
    input = IO.read(:stdio, :eof) |> Jason.decode!()

    results =
      Enum.map(input["histories"], fn history ->
        ops =
          Enum.map(history["frames"], fn frame ->
            {:ok, op} = Wire.decode_op(frame)
            true = Op.valid?(op)
            op
          end)

        log = Log.from_ops(history["replica"], Map.new(ops, &{&1.id, &1}))
        :ok = Log.verify_authenticity(log)

        {module, roles} =
          if String.starts_with?(log.replica, "replica:treehouse:space:"),
            do: {Treehouse.Space, [:admin, :moderator]},
            else: {Treehouse.Thread, [:moderator]}

        Code.ensure_loaded!(module)
        {analysis, beacons} = Lattice.Authority.analyze_with_beacon_evidence(module, log)

        Enum.each(history["expiryQueries"] || [], fn [id, expired] ->
          expected = if expired, do: :lease_expired, else: nil
          ^expected = analysis.reasons[id]
        end)

        ids = ops |> Enum.filter(&(&1.kind == :authority)) |> MapSet.new(& &1.id)

        %{
          reasons: Map.filter(analysis.reasons, fn {id, _} -> MapSet.member?(ids, id) end),
          beacons: Enum.map(beacons, &[&1.op_id, Integer.to_string(&1.epoch)]),
          epochs:
            Map.new(roles, &{&1, analysis.holder_epochs[&1] && analysis.holder_epochs[&1].op_id}),
          holders:
            Map.new(roles, &{&1, analysis.holders[&1] && Base.encode64(analysis.holders[&1])})
        }
      end)

    IO.puts(Jason.encode!(%{results: results}))

  ["delegations"] ->
    input = IO.read(:stdio, :eof) |> Jason.decode!()

    ops =
      Enum.map(input["frames"], fn frame ->
        {:ok, op} = Wire.decode_op(frame)
        true = Op.valid?(op)
        op
      end)

    log = Log.from_ops(input["replica"], Map.new(ops, &{&1.id, &1}))
    :ok = Log.verify_authenticity(log)
    root = Lattice.Authority.root(log)
    ids = input["delegationIds"]

    module =
      if String.starts_with?(input["replica"], "replica:treehouse:space:"),
        do: Treehouse.Space,
        else: Treehouse.Thread

    analysis = Lattice.Authority.analyze(module, log)

    IO.puts(
      Jason.encode!(%{
        root: if(root, do: Base.encode64(root)),
        active: Map.new(ids, &{&1, Lattice.Authority.delegation_active?(log, &1)}),
        reasons: Map.new(input["reasonIds"], &{&1, analysis.reasons[&1]})
      })
    )

  ["cutoffs"] ->
    f = CatalogVectors.bootstrap_history()

    vocabulary =
      Op.new(
        f.root,
        f.replica,
        Log.frontier(f.log),
        :command,
        {:create_space, [CatalogCutoff.cutoff_atoms()]},
        cap: f.delegation.id
      )

    high =
      Op.new(
        f.root,
        f.replica,
        [vocabulary.id],
        :authority,
        {:beacon, 18_446_744_073_709_551_615}
      )

    first = f.log |> Log.append!(vocabulary) |> Log.append!(high)

    genuine =
      Op.new(f.root, f.replica, [high.id], :command, {:create_space, ["retained"]},
        cap: f.delegation.id
      )

    {:quarantined, rejected, :bad_signature} = Log.accept(first, %{genuine | sig: <<0::512>>})

    {:quarantined, rejected, :bad_signature} =
      Log.accept(rejected, %{genuine | id: "retained:\uFEFF🌿", deps: ["withheld"], sig: <<>>})

    second = Log.append!(rejected, genuine)

    posts =
      Enum.map(1..32, fn index ->
        Op.new(
          f.root,
          f.replica,
          [high.id],
          :command,
          {:create_space, [Integer.to_string(index) <> String.duplicate("x", 8192)]},
          cap: f.delegation.id
        )
      end)

    large = Enum.reduce(posts, first, &Log.append!(&2, &1))
    unknown = Op.new(f.root, f.replica, [], :command, :cutoff_unknown_evidence_v99)
    unsupported = Log.from_ops(f.replica, %{unknown.id => unknown})

    empty_delegation = %Delegation{
      id: "",
      replica: "",
      parent_id: "",
      issuer: :binary.copy(<<7>>, 32),
      audience: :binary.copy(<<7>>, 32),
      ops: MapSet.new(),
      roles: MapSet.new(),
      live: true,
      sig: <<0::512>>
    }

    empty_frame = Op.new(f.root, f.replica, [], :command, empty_delegation)
    empty_log = Log.from_ops(f.replica, %{empty_frame.id => empty_frame})

    cases =
      for {name, log} <- [
            {"beam-complete-all-atoms-high-uint64", first},
            {"beam-rejected-same-id-arbitrary-header", second},
            {"beam-large-observation", large},
            {"beam-unknown-authentic", unsupported},
            {"beam-empty-delegation-fields", empty_log}
          ] do
        %{
          name: name,
          input: Map.delete(cutoff_input.(name, log), :name),
          result: cutoff_result.(log)
        }
      end

    IO.puts(Jason.encode!(%{cases: cases}))

  ["consume-cutoffs"] ->
    input = IO.read(:stdio, :eof) |> Jason.decode!()

    Enum.each(input["cases"], fn item ->
      raw = item["input"]
      {:ok, ops} = Wire.decode_ops(raw["frames"])
      log = Log.from_ops(raw["replica"], Map.new(ops, &{&1.id, &1}))

      rejected =
        Enum.map(raw["rejected"], fn entry ->
          true = entry["reason"] == "bad_signature"
          {:ok, op} = Wire.decode_op(entry["frame"])
          %{op: op, reason: :bad_signature}
        end)

      actual = cutoff_result.(%{log | quarantine: rejected}) |> Jason.encode!() |> Jason.decode!()
      true = actual == item["result"]
    end)

    IO.puts(Jason.encode!(%{cases: length(input["cases"])}))
end
