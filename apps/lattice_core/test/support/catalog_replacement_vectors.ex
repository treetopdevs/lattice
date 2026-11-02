defmodule Treehouse.CatalogReplacementVectors do
  @moduledoc """
  Deterministic `replace_catalog_v1` codec and Stage A evidence (plan 316 PR 1).

  Disposable seeded keys only. A Core-honored fixture op is an authorized signed proposal,
  not a route switch or installed catalog trust.
  """

  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Carrier.Wire
  alias Treehouse.{CatalogCutoff, CatalogVectors, Space}
  alias Treehouse.TransportCatalog, as: Catalog

  @path "catalog/replacement_v1.json"
  @high_uint64 9_007_199_254_740_992

  @spec fixture() :: map()
  def fixture do
    f = CatalogVectors.bootstrap_history()
    new_catalog = Identity.from_seed("catalog", "r316-replacement-new-catalog")
    new_service = Identity.from_seed("service", "r316-replacement-new-service")

    genuine =
      Op.new(f.root, f.replica, [f.bootstrap.id], :command, {:create_space, ["Retained"]},
        cap: f.delegation.id
      )

    {:quarantined, log, :bad_signature} = Log.accept(f.log, %{genuine | sig: <<0::512>>})
    log = Log.append!(log, genuine)
    beacon = Op.new(f.root, f.replica, [genuine.id], :authority, {:beacon, 1})
    log = Log.append!(log, beacon)

    {:ok, cutoff} = CatalogCutoff.derive(log)

    entries = [
      %{
        product: :treehouse,
        replica: f.replica,
        kind: :space,
        schema: :treehouse_space_v1,
        root: f.root.pub,
        genesis: f.genesis.id,
        creation: f.creation.id,
        reference: f.bootstrap.id,
        route: "/r/" <> id("replacement-space-route"),
        service_id: id("replacement-service"),
        service_key: new_service.pub
      }
    ]

    claim = %{
      version: 1,
      product: :treehouse,
      space: f.replica,
      bootstrap: f.bootstrap.id,
      profile_genesis: f.record.profile_genesis,
      profile_id: f.record.profile_id,
      parents: [f.bootstrap.id],
      prior_catalogs: [%{binding: f.bootstrap.id, catalog: nil}],
      generation: 1,
      nonce: id("replacement-nonce"),
      new_catalog_key: new_catalog.pub,
      new_service_id: id("replacement-service"),
      new_service_key: new_service.pub,
      new_origin: "wss://replacement-relay.invalid:8443",
      inventory_digest: Catalog.inventory_id(entries),
      cutoffs: [cutoff.cutoff],
      author: f.root.pub,
      cap: f.delegation.id,
      holder_epoch: f.genesis.id,
      deps: Enum.sort(Log.frontier(log)),
      epoch: 1,
      epoch_basis: [beacon.id]
    }

    catalog_possession =
      Identity.sign(new_catalog, Catalog.replacement_possession_bytes(:catalog, claim))

    service_possession =
      Identity.sign(new_service, Catalog.replacement_possession_bytes(:service, claim))

    :ok = Catalog.verify_replacement_possession(claim, catalog_possession, service_possession)
    op = replacement_op(f, claim, [claim, catalog_possession, service_possession])

    Map.merge(f, %{
      new_catalog: new_catalog,
      new_service: new_service,
      genuine: genuine,
      beacon: beacon,
      cutoff: cutoff,
      entries: entries,
      claim: claim,
      catalog_possession: catalog_possession,
      service_possession: service_possession,
      before_replacement: log,
      replacement: op,
      log: Log.append!(log, op)
    })
  end

  @doc "Sign a `replace_catalog_v1` op over the fixture frontier; overrides are raw op fields."
  @spec replacement_op(map(), map(), list(), keyword()) :: Op.t()
  def replacement_op(f, claim, args, opts \\ []) do
    identity = Keyword.get(opts, :identity, f.root)
    deps = Keyword.get(opts, :deps, claim.deps)
    cap = Keyword.get(opts, :cap, f.delegation.id)
    Op.new(identity, f.replica, deps, :command, {:replace_catalog_v1, args}, cap: cap)
  end

  @doc "Re-sign both possessions for a changed claim under the fixture's new keys."
  @spec signed_args(map(), map()) :: list()
  def signed_args(f, claim) do
    [
      claim,
      Identity.sign(f.new_catalog, Catalog.replacement_possession_bytes(:catalog, claim)),
      Identity.sign(f.new_service, Catalog.replacement_possession_bytes(:service, claim))
    ]
  end

  @doc """
  Stage A refusals, each judged alone after `before_replacement` plus its listed prefix ops.
  """
  @spec stage_a_cases(map()) :: [{String.t(), [Op.t()], Op.t()}]
  def stage_a_cases(f) do
    claim = f.claim
    cp = f.catalog_possession
    sp = f.service_possession

    [
      {"malformed-claim-extra-field",
       replacement_op(f, claim, [Map.put(claim, :extra, 1), cp, sp])},
      {"malformed-claim-nil", replacement_op(f, claim, [nil, cp, sp])},
      {"wrong-author-field",
       replacement_op(f, claim, signed_args(f, %{claim | author: f.nominee.pub}))},
      {"wrong-cap-field", replacement_op(f, claim, signed_args(f, %{claim | cap: f.genesis.id}))},
      {"deps-differ-from-op",
       replacement_op(f, claim, signed_args(f, claim), deps: [f.bootstrap.id])},
      {"holder-epoch-not-visible",
       replacement_op(f, claim, signed_args(f, %{claim | holder_epoch: id("unseen-epoch")}))},
      {"bootstrap-not-visible",
       replacement_op(
         f,
         claim,
         signed_args(f, %{claim | bootstrap: id("unseen-bootstrap")})
       )},
      {"bootstrap-not-a-bootstrap-op",
       replacement_op(f, claim, signed_args(f, %{claim | bootstrap: f.creation.id}))},
      quarantined_bootstrap(f),
      {"wrong-space",
       replacement_op(f, claim, signed_args(f, %{claim | space: "another-space"}))},
      {"bad-catalog-possession", replacement_op(f, claim, [claim, sp, sp])},
      {"bad-service-possession", replacement_op(f, claim, [claim, cp, cp])},
      {"non-binary-possession", replacement_op(f, claim, [claim, :admin, sp])},
      # Wire uint64s above 2^53 - 1: TS must refuse them in the decoder, not as malformed_term.
      {"high-generation",
       replacement_op(f, claim, [%{claim | generation: @high_uint64}, cp, sp])},
      {"high-epoch", replacement_op(f, claim, [%{claim | epoch: @high_uint64}, cp, sp])},
      {"high-integer-possession", replacement_op(f, claim, [claim, @high_uint64, sp])}
    ]
    |> Enum.map(fn
      {name, op} -> {name, [], op}
      prefixed -> prefixed
    end)
  end

  # A visible catalog_bootstrap_v1 that Core quarantines (wrong space root).
  defp quarantined_bootstrap(f) do
    record = %{f.record | space_root: f.nominee.pub}

    bad =
      Op.new(f.root, f.replica, [f.pin.id], :command, {:catalog_bootstrap_v1, [record]},
        cap: f.delegation.id
      )

    deps = Enum.sort(Log.frontier(Log.append!(f.before_replacement, bad)))
    claim = %{f.claim | bootstrap: bad.id, deps: deps}
    {"bootstrap-quarantined", [bad], replacement_op(f, claim, signed_args(f, claim))}
  end

  @spec vector() :: map()
  def vector do
    f = fixture()
    claim_term = Wire.encode_value(f.claim)

    swapped =
      Identity.sign(f.new_catalog, Catalog.replacement_possession_bytes(:service, f.claim))

    rotation = %{
      version: 1,
      product: :treehouse,
      space: f.replica,
      bootstrap: f.bootstrap.id,
      parent: f.bootstrap.id,
      prior_catalog: id("prior-catalog"),
      generation: 1,
      new_catalog_key: f.new_catalog.pub,
      nonce: f.claim.nonce,
      inventory_digest: f.claim.inventory_digest,
      cutoffs: f.claim.cutoffs
    }

    stage_a =
      for {name, prefix, op} <- stage_a_cases(f) do
        log = Enum.reduce(prefix ++ [op], f.before_replacement, &Log.append!(&2, &1))

        %{
          "name" => name,
          "prefix" => Enum.map(prefix, &Wire.encode_op/1),
          "frame" => Wire.encode_op(op),
          "reason" => to_string(Authority.analyze(Space, log).reasons[op.id])
        }
      end

    %{
      "version" => 1,
      "claim_term" => claim_term,
      "claim_bytes" => Base.encode64(Catalog.replacement_claim_bytes(f.claim)),
      "catalog_key" => Base.encode64(f.new_catalog.pub),
      "service_key" => Base.encode64(f.new_service.pub),
      "catalog_possession_bytes" =>
        Base.encode64(Catalog.replacement_possession_bytes(:catalog, f.claim)),
      "service_possession_bytes" =>
        Base.encode64(Catalog.replacement_possession_bytes(:service, f.claim)),
      "catalog_possession" => Base.encode64(f.catalog_possession),
      "service_possession" => Base.encode64(f.service_possession),
      "inventory_term" => Wire.encode_value(f.entries),
      "inventory_bytes" => Base.encode64(Catalog.inventory_bytes(f.entries)),
      "inventory_id" => Catalog.inventory_id(f.entries),
      "cutoff" => cutoff_vector(f.before_replacement, f.cutoff),
      "replica" => f.replica,
      "frames" => Enum.map(Log.topo_ops(f.log), &Wire.encode_op/1),
      "binding_id" => f.replacement.id,
      "stage_a" => stage_a,
      "negative" => [
        %{
          "name" => "swapped-purpose",
          "claim_term" => claim_term,
          "catalog_possession" => Base.encode64(swapped),
          "service_possession" => Base.encode64(f.service_possession),
          "result" => "invalid_possession"
        },
        %{
          "name" => "rotation-shaped-map",
          "claim_term" => Wire.encode_value(rotation),
          "result" => "malformed_catalog"
        },
        %{
          "name" => "unsorted-parents",
          "claim_term" =>
            Wire.encode_value(%{
              f.claim
              | parents: Enum.sort([f.bootstrap.id, f.pin.id], :desc),
                prior_catalogs:
                  Enum.sort([
                    %{binding: f.bootstrap.id, catalog: nil},
                    %{binding: f.pin.id, catalog: nil}
                  ])
            }),
          "result" => "malformed_catalog"
        },
        %{
          "name" => "nil-not-alone",
          "claim_term" =>
            Wire.encode_value(%{
              f.claim
              | prior_catalogs: [
                  %{binding: f.bootstrap.id, catalog: nil},
                  %{binding: f.bootstrap.id, catalog: id("prior-catalog")}
                ]
            }),
          "result" => "malformed_catalog"
        },
        %{
          "name" => "extra-field",
          "claim_term" => Wire.encode_value(Map.put(f.claim, :binding, f.bootstrap.id)),
          "result" => "malformed_catalog"
        }
      ]
    }
  end

  @spec write(String.t()) :: :ok
  def write(directory) do
    path = Path.join(directory, @path)
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, encode(vector()))
  end

  @spec encode(map()) :: binary()
  def encode(vector), do: Jason.encode!(vector, pretty: true) <> "\n"

  defp cutoff_vector(log, cutoff) do
    %{
      "replica" => log.replica,
      "rejected_frames" =>
        Enum.map(Log.quarantine(log), fn rejected ->
          %{"frame" => Wire.encode_op(rejected.op), "reason" => "bad_signature"}
        end),
      "frontier" => cutoff.cutoff.frontier,
      "log_digest" => cutoff.cutoff.log_digest,
      "canonical_bytes" => Base.encode64(cutoff.canonical_bytes),
      "ops" => Enum.map(cutoff.ops, &record/1),
      "rejected" => Enum.map(cutoff.rejected, &Map.put(record(&1), "reason", "bad_signature"))
    }
  end

  defp record(record),
    do: %{
      "id" => record.id,
      "bytes" => Base.encode64(record.bytes),
      "sig" => Base.encode64(record.sig)
    }

  defp id(label),
    do: :crypto.hash(:sha256, "r316-replacement-" <> label) |> Base.url_encode64(padding: false)
end
