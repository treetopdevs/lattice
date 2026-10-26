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
  ["artifact-profile-produce"] ->
    alias Treehouse.CatalogTrust

    directory =
      Path.join(
        System.tmp_dir!(),
        "native-artifact-profile-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(directory)

    try do
      path = Path.join(directory, "public.json")
      CatalogTrustVectors.write_public_fixture!(path)
      b = CatalogTrustVectors.read_ts_fixture!(path)
      expected = %{trust_revision: 0, history_generation: 0}
      page = %{catalogs: [], rotations: [], histories: [], cutoff_proofs: []}

      run = fn state, incoming ->
        CatalogTrust.evaluate(%{
          installed: state,
          expected: expected,
          incoming: Map.merge(page, incoming)
        })
      end

      observe = fn d ->
        %{kind: Atom.to_string(d.kind), reason: d.reason && Atom.to_string(d.reason)}
      end

      %{kind: :propose, next: prepared} =
        CatalogTrust.prepare_installation(%{
          review: b.review,
          history: hd(b.histories),
          store: %{kind: :verified_fresh, expected: expected}
        })

      %{kind: :propose, next: base} =
        run.(prepared, %{catalogs: [b.catalog_json], histories: b.histories})

      %{kind: :propose} =
        run.(base, %{
          catalogs: [b.rotated_catalog_json],
          rotations: [b.rotation_json],
          cutoff_proofs: b.cutoff_proofs
        })

      cases =
        for {field, original, rotation, number} <- [
              {"version", b.catalog_json, false, 1},
              {"revision", b.catalog_json, false, 0},
              {"generation", b.rotation_json, true, 1}
            ],
            token <- [
              Jason.encode!(Integer.to_string(number)),
              "#{number}.0",
              "#{number}e0",
              "-0",
              "9007199254740992",
              String.duplicate("9", 10000),
              Jason.encode!(String.duplicate("9", 10000)),
              "01",
              "duplicate"
            ] do
          pair = ~s([["atom","#{field}"],["int",#{number}]])

          json =
            if token == "duplicate",
              do: String.replace(original, pair, pair <> "," <> pair, global: false),
              else:
                String.replace(
                  original,
                  ~s(["atom","#{field}"],["int",#{number}]),
                  ~s(["atom","#{field}"],["int",#{token}]),
                  global: false
                )

          true = json != original

          incoming =
            if rotation,
              do: %{
                rotations: [json],
                catalogs: [b.rotated_catalog_json],
                cutoff_proofs: b.cutoff_proofs
              },
              else: %{catalogs: [json], histories: b.histories}

          %{kind: :reject, reason: :malformed_catalog} =
            d = run.(if(rotation, do: base, else: prepared), incoming)

          %{json: json, results: [observe.(d)]}
        end

      controls =
        for {rotation, original, state} <- [
              {false, b.catalog_json, prepared},
              {true, b.rotation_json, base}
            ] do
          json = original <> String.duplicate(" ", 131_072 - byte_size(original))

          incoming =
            if rotation,
              do: %{
                rotations: [json],
                catalogs: [b.rotated_catalog_json],
                cutoff_proofs: b.cutoff_proofs
              },
              else: %{catalogs: [json], histories: b.histories}

          %{kind: :propose} = d = run.(state, incoming)

          oversized =
            if rotation, do: %{rotations: [json <> " "]}, else: %{catalogs: [json <> " "]}

          %{kind: :reject, reason: :control_history_limit} = over = run.(state, oversized)
          %{json: json, result: observe.(d), over: observe.(over)}
        end

      foreign =
        for epoch <- [5, "5"] do
          json =
            Jason.encode!([
              "delegation",
              %{
                id: "",
                replica: "",
                issuer: Base.encode64(:binary.copy(<<7>>, 32)),
                audience: Base.encode64(:binary.copy(<<7>>, 32)),
                parent_id: nil,
                ops: ["int", "5"],
                roles: [],
                live: true,
                sig: Base.encode64(:binary.copy(<<9>>, 64)),
                expires_epoch: epoch
              }
            ])

          %{kind: :reject, reason: :malformed_catalog} =
            d = run.(prepared, %{catalogs: [json], histories: b.histories})

          nested =
            for rotation <- [false, true] do
              original = if rotation, do: b.rotation_json, else: b.catalog_json
              mutated = String.replace(original, ~s(["int",1]), json, global: false)
              true = mutated != original

              incoming =
                if rotation,
                  do: %{rotations: [mutated]},
                  else: %{catalogs: [mutated], histories: b.histories}

              state = if rotation, do: base, else: prepared
              %{kind: :reject, reason: :malformed_catalog} = result = run.(state, incoming)
              %{json: mutated, result: observe.(result)}
            end

          [%{json: json, result: observe.(d)} | nested]
        end
        |> List.flatten()

      IO.puts(Jason.encode!(%{cases: cases, controls: controls, foreign: foreign}))
    after
      File.rm_rf!(directory)
    end

  ["rotation-produce"] ->
    f = CatalogVectors.codec_vector()
    IO.puts(Jason.encode!(%{envelope: f.rotation_envelope_term, key: f.expected_old_key}))

  ["rotation-consume"] ->
    alias Treehouse.TransportCatalog, as: Catalog
    input = IO.read(:stdio, :eof) |> Jason.decode!()

    results =
      Enum.map(input["cases"], fn item ->
        with {:ok, envelope} when is_map(envelope) <- Wire.decode_value(item["envelope"]),
             true <- Enum.sort(Map.keys(envelope)) == [:new_signature, :old_signature, :rotation],
             true <- is_binary(envelope.old_signature) and byte_size(envelope.old_signature) == 64,
             true <- is_binary(envelope.new_signature) and byte_size(envelope.new_signature) == 64,
             {:ok, record} <- Catalog.normalize_rotation(envelope.rotation) do
          valid =
            case Base.decode64(item["key"]) do
              {:ok, key} -> Catalog.verify_rotation(envelope, key) == :ok
              _ -> false
            end

          %{
            shape: true,
            valid: valid,
            id: Catalog.rotation_id(envelope),
            rotationBytes: Base.encode64(Catalog.rotation_bytes(record)),
            possessionBytes: Base.encode64(Catalog.rotation_possession_bytes(record))
          }
        else
          _ -> %{shape: false, valid: false}
        end
      end)

    IO.puts(Jason.encode!(%{results: results}))

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
