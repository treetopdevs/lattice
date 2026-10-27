Code.require_file("support/native_peer_output.exs", __DIR__)

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

      Lattice.NativePeerOutput.puts(
        Jason.encode!(%{cases: cases, controls: controls, foreign: foreign})
      )
    after
      File.rm_rf!(directory)
    end

  ["entry-high-lease-profile"] ->
    alias Treehouse.{CatalogEntries, CatalogTrust}
    f = CatalogTrustVectors.fixture()
    [thread] = f.threads

    lease =
      Delegation.new(thread.root, thread.replica, thread.root.pub,
        ops: [],
        roles: [],
        live: false,
        expires_epoch: 9_007_199_254_740_992
      )

    op = Op.new(thread.root, thread.replica, [], :authority, {:genesis, lease, %{}})
    true = Op.valid?(op)
    log = Log.append!(thread.log, op)

    {:error, :unsupported_cutoff} =
      CatalogEntries.observe(f.catalog, %{f.space.replica => f.space_log, thread.replica => log})

    expected = %{trust_revision: 0, history_generation: 0}

    %{kind: :propose, next: prepared} =
      CatalogTrust.prepare_installation(%{
        review: f.review,
        history: CatalogTrustVectors.raw_history(f.space_log),
        store: %{kind: :verified_fresh, expected: expected}
      })

    histories = [
      CatalogTrustVectors.raw_history(f.space_log),
      CatalogTrustVectors.raw_history(log)
    ]

    %{kind: :reject, reason: :invalid_verified_history} =
      decision =
      CatalogTrust.evaluate(%{
        installed: prepared,
        expected: expected,
        incoming: %{
          catalogs: [f.catalog_json],
          rotations: [],
          histories: histories,
          cutoff_proofs: []
        }
      })

    review = %{
      version: 1,
      product: "treehouse",
      space: f.review.space,
      spaceRoot: Base.encode64(f.review.space_root),
      bootstrapId: f.review.bootstrap_id,
      observedBootstrapIds: f.review.observed_bootstrap_ids,
      disposition: "pin_exact_observed_bootstrap"
    }

    Lattice.NativePeerOutput.puts(
      Jason.encode!(%{
        case: %{review: review, catalogJson: f.catalog_json, histories: histories},
        public: %{kind: decision.kind, reason: decision.reason},
        typedReason: "unsupported_cutoff"
      })
    )

  ["raw-incoming-consume"] ->
    alias Treehouse.CatalogTrust
    input = IO.read(:stdio, :eof) |> Jason.decode!()
    review = input["review"]

    review = %{
      version: 1,
      product: :treehouse,
      space: review["space"],
      space_root: Base.decode64!(review["spaceRoot"]),
      bootstrap_id: review["bootstrapId"],
      observed_bootstrap_ids: review["observedBootstrapIds"],
      disposition: :pin_exact_observed_bootstrap
    }

    raw_history = fn raw ->
      Map.new(raw, fn
        {"replica", value} ->
          {:replica, value}

        {"frames", value} ->
          {:frames, value}

        {"rejected", records} ->
          {:rejected,
           Enum.map(records, fn
             record when is_map(record) ->
               Map.new(record, fn
                 {"frame", value} -> {:frame, value}
                 {"reason", "bad_signature"} -> {:reason, :bad_signature}
                 {"reason", value} -> {:reason, value}
                 pair -> pair
               end)

             value ->
               value
           end)}

        pair ->
          pair
      end)
    end

    expected = %{trust_revision: 0, history_generation: 0}

    %{kind: :propose, next: installed} =
      CatalogTrust.prepare_installation(%{
        review: review,
        history: raw_history.(input["baselineHistory"]),
        store: %{kind: :verified_fresh, expected: expected}
      })

    results =
      Enum.map(input["cases"], fn item ->
        decision =
          CatalogTrust.evaluate(%{
            installed: installed,
            expected: expected,
            incoming: %{
              catalogs: [item["catalogJson"]],
              rotations: [],
              cutoff_proofs: [],
              histories: Enum.map(item["histories"], raw_history)
            }
          })

        %{
          kind: decision.kind,
          reason: decision.reason,
          ids: get_in(decision, [:detail, :ids]) || [],
          route_count: length(Map.get(decision, :routes, []))
        }
      end)

    Lattice.NativePeerOutput.puts(Jason.encode!(%{results: results}))

  ["entries-consume"] ->
    alias Treehouse.{CatalogEntries, TransportCatalog}
    input = IO.read(:stdio, :eof) |> Jason.decode!()

    results =
      Enum.map(input["cases"], fn item ->
        {:ok, envelope} = TransportCatalog.decode_catalog_json(item["catalogJson"])

        logs =
          Map.new(item["histories"], fn raw ->
            [] = raw["rejected"]
            {:ok, ops} = Wire.decode_ops(raw["frames"])
            log = Log.from_ops(raw["replica"], Map.new(ops, &{&1.id, &1}))
            {raw["replica"], log}
          end)

        case CatalogEntries.observe(envelope.catalog, logs) do
          {:ok, observation} ->
            %{
              ok: true,
              entries: Wire.encode_value(observation.entries),
              bootstrap: Wire.encode_value(observation.bootstrap.record),
              bootstrapId: observation.bootstrap.id
            }

          {:error, reason} ->
            %{ok: false, reason: reason}
        end
      end)

    Lattice.NativePeerOutput.puts(Jason.encode!(%{results: results}))

  ["entries-produce"] ->
    alias Treehouse.{CatalogEntries, TransportCatalog}
    alias Lattice.Identity
    f = CatalogTrustVectors.fixture(2)
    [first, second] = Enum.sort_by(f.threads, & &1.replica)
    histories = Map.new([f.space_log | Enum.map(f.threads, & &1.log)], &{&1.replica, &1})

    change = fn catalog, replica, edits ->
      %{
        catalog
        | entries:
            Enum.map(catalog.entries, fn e ->
              if e.replica == replica, do: Map.merge(e, edits), else: e
            end)
      }
    end

    base = [
      {"complete", f.catalog, histories},
      {"missing-child", f.catalog, Map.delete(histories, first.replica)}
    ]

    changes = [
      {"wrong-root", %{root: f.space.root.pub}},
      {"genesis-is-creation", %{genesis: first.creation.id}},
      {"creation-is-genesis", %{creation: first.genesis.id}},
      {"wrong-reference", %{reference: f.space.creation.id}},
      {"missing-genesis", %{genesis: CatalogTrustVectors.id("missing-genesis")}},
      {"missing-creation", %{creation: CatalogTrustVectors.id("missing-creation")}},
      {"missing-reference", %{reference: CatalogTrustVectors.id("missing-reference")}}
    ]

    cases =
      base ++
        Enum.map(changes, fn {name, edits} ->
          {name, change.(f.catalog, first.replica, edits), histories}
        end)

    cases =
      cases ++
        [
          {"pending-cannot-hide-invalid-entry",
           change.(f.catalog, second.replica, %{root: f.space.root.pub}),
           Map.delete(histories, first.replica)}
        ]

    stranger = Identity.from_seed("entry-stranger", "native-entry-stranger")

    refused_reference =
      Op.new(
        stranger,
        f.space.replica,
        Log.frontier(f.space_log),
        :command,
        {:create_thread, [first.replica, "Denied"]},
        cap: f.space.delegation.id
      )

    refused_creation =
      Op.new(stranger, first.replica, [first.genesis.id], :command, {:create_thread, ["Denied"]},
        cap: first.delegation.id
      )

    unrelated = Delegation.genesis(first.root, first.replica, ops: [], roles: [], live: false)
    unrelated = Op.new(first.root, first.replica, [], :authority, {:genesis, unrelated, %{}})
    false_genesis = Delegation.genesis(first.root, first.replica, ops: [], roles: [], live: false)

    false_genesis =
      Op.new(stranger, first.replica, [], :authority, {:genesis, false_genesis, %{}})

    rooted_creation =
      Op.new(
        first.root,
        first.replica,
        [first.genesis.id, false_genesis.id],
        :command,
        {:create_thread, ["Root's actual command"]},
        cap: first.delegation.id
      )

    false_genesis_log = first.log |> Log.append!(false_genesis) |> Log.append!(rooted_creation)

    false =
      MapSet.member?(
        Lattice.Authority.analyze(Treehouse.Thread, false_genesis_log).quarantine,
        rooted_creation.id
      )

    cases =
      cases ++
        [
          {"refused-reference",
           change.(f.catalog, first.replica, %{reference: refused_reference.id}),
           Map.put(histories, f.space.replica, Log.append!(f.space_log, refused_reference))},
          {"refused-creation",
           change.(f.catalog, first.replica, %{creation: refused_creation.id}),
           Map.put(histories, first.replica, Log.append!(first.log, refused_creation))},
          {"unrelated-genesis", change.(f.catalog, first.replica, %{genesis: unrelated.id}),
           Map.put(histories, first.replica, Log.append!(first.log, unrelated))},
          {"wrong-genesis-author",
           change.(f.catalog, first.replica, %{
             genesis: false_genesis.id,
             creation: rooted_creation.id
           }), Map.put(histories, first.replica, false_genesis_log)}
        ]

    extra_replica = "replica:unrelated-entry-history"
    extra = Op.new(stranger, extra_replica, [], :authority, {:future_entry_observation, []})
    extra_log = Log.new(extra_replica) |> Log.append!(extra)
    corrupt = %{extra_log | ops: %{extra.id => %{extra | sig: <<0::512>>}}}

    cases =
      cases ++
        [
          {"unrelated-unsupported", f.catalog, Map.put(histories, extra_replica, extra_log)},
          {"missing-plus-unrelated-forgery", f.catalog,
           histories |> Map.delete(first.replica) |> Map.put(extra_replica, corrupt)},
          {"unsupported-plus-forgery", f.catalog,
           histories
           |> Map.put(extra_replica, extra_log)
           |> Map.put(first.replica, %{
             first.log
             | ops: Map.put(first.log.ops, first.creation.id, %{first.creation | sig: <<0::512>>})
           })}
        ]

    results =
      Enum.map(cases, fn {name, catalog, logs} ->
        result =
          case CatalogEntries.observe(catalog, logs) do
            {:ok, observation} ->
              %{
                ok: true,
                entries: Wire.encode_value(observation.entries),
                bootstrap: Wire.encode_value(observation.bootstrap.record),
                bootstrapId: observation.bootstrap.id
              }

            {:error, reason} ->
              %{ok: false, reason: reason}
          end

        {:ok, _} = TransportCatalog.normalize_catalog(catalog)

        %{
          name: name,
          catalogJson:
            CatalogTrustVectors.artifact_json(
              CatalogTrustVectors.sign_catalog(catalog, f.space.catalog)
            ),
          histories:
            Enum.map(Enum.sort(logs), fn {name, log} ->
              %{name: name, raw: CatalogTrustVectors.raw_history(log)}
            end),
          result: result
        }
      end)

    Lattice.NativePeerOutput.puts(Jason.encode!(%{cases: results}))

  ["rotation-produce"] ->
    f = CatalogVectors.codec_vector()

    Lattice.NativePeerOutput.puts(
      Jason.encode!(%{envelope: f.rotation_envelope_term, key: f.expected_old_key})
    )

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

    Lattice.NativePeerOutput.puts(Jason.encode!(%{results: results}))

  ["causal-slices"] ->
    input = IO.read(:stdio, :eof) |> Jason.decode!()

    results =
      Enum.map(input["histories"], fn history ->
        {:ok, ops} = Wire.decode_ops(history["frames"])
        log = Log.from_ops(history["replica"], Map.new(ops, &{&1.id, &1}))
        :ok = Log.verify_authenticity(log)
        true = map_size(log.ops) == length(ops)

        queries =
          Enum.map(history["queries"], fn frontier ->
            if Enum.all?(frontier, &Map.has_key?(log.ops, &1)) do
              selected =
                Enum.reduce(frontier, MapSet.new(), fn id, ids ->
                  ids |> MapSet.put(id) |> MapSet.union(Lattice.Dag.ancestors(log.ops, id))
                end)

              slice = Log.from_ops(log.replica, Map.take(log.ops, MapSet.to_list(selected)))
              :ok = Log.verify_authenticity(slice)
              graph.(slice)
            else
              nil
            end
          end)

        %{queries: queries}
      end)

    Lattice.NativePeerOutput.puts(Jason.encode!(%{results: results}))

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

    Lattice.NativePeerOutput.puts(
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

    Lattice.NativePeerOutput.puts(Jason.encode!(%{histories: length(input["histories"])}))

  ["space-policy-cases"] ->
    Lattice.NativePeerOutput.puts(
      Jason.encode!(%{histories: Treehouse.MemberContinuitySemanticVectors.corpus().cases})
    )

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

    Lattice.NativePeerOutput.puts(Jason.encode!(%{results: results}))

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

    Lattice.NativePeerOutput.puts(Jason.encode!(%{results: results}))

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

    Lattice.NativePeerOutput.puts(Jason.encode!(%{results: results}))

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
      Lattice.NativePeerOutput.puts(Jason.encode!(%{histories: data}))
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

    Lattice.NativePeerOutput.puts(Jason.encode!(%{results: results}))

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

    Lattice.NativePeerOutput.puts(
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

    Lattice.NativePeerOutput.puts(Jason.encode!(%{cases: cases}))

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

    Lattice.NativePeerOutput.puts(Jason.encode!(%{cases: length(input["cases"])}))
end
