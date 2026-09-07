defmodule Treehouse.CatalogTrustVectors do
  @moduledoc "Deterministic signed public fixtures for retained catalog trust tests."

  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Authority.Delegation
  alias Lattice.Carrier.Wire
  alias Treehouse.{CatalogCutoff, CatalogVectors, TransportCatalog}

  @spec fixture(non_neg_integer()) :: map()
  def fixture(thread_count \\ 1) do
    space = CatalogVectors.bootstrap_history()

    {space_log, threads} =
      Enum.reduce(0..(thread_count - 1)//1, {space.log, []}, fn index, {space_log, threads} ->
        thread = thread(index, space, space_log)
        {Log.append!(space_log, thread.reference), [thread | threads]}
      end)

    threads = Enum.reverse(threads)

    entries =
      [space_entry(space) | Enum.map(threads, &thread_entry(&1, space))]
      |> Enum.sort_by(& &1.replica)

    catalog = %{
      version: 1,
      product: :treehouse,
      space: space.replica,
      bootstrap: space.bootstrap.id,
      binding: space.bootstrap.id,
      revision: 0,
      previous: nil,
      entries: entries
    }

    catalog_envelope = sign_catalog(catalog, space.catalog)
    histories = [raw_history(space_log) | Enum.map(threads, &raw_history(&1.log))]

    cutoff_proofs =
      [space_log | Enum.map(threads, & &1.log)]
      |> Enum.map(fn log ->
        {:ok, proof} = CatalogCutoff.derive(log)
        %{cutoff: proof.cutoff, history: raw_history(log)}
      end)
      |> Enum.sort_by(& &1.cutoff.replica)

    next_catalog = Identity.from_seed("catalog-next", "r11a-beam-trust-next")

    rotation = %{
      version: 1,
      product: :treehouse,
      space: space.replica,
      bootstrap: space.bootstrap.id,
      parent: space.bootstrap.id,
      prior_catalog: TransportCatalog.catalog_id(catalog),
      generation: 1,
      new_catalog_key: next_catalog.pub,
      nonce: id("rotation"),
      inventory_digest: TransportCatalog.inventory_id(entries),
      cutoffs: Enum.map(cutoff_proofs, & &1.cutoff)
    }

    rotation_envelope = sign_rotation(rotation, space.catalog, next_catalog)

    %{
      space: space,
      space_log: space_log,
      threads: threads,
      histories: histories,
      cutoff_proofs: cutoff_proofs,
      catalog: catalog,
      catalog_envelope: catalog_envelope,
      catalog_json: artifact_json(catalog_envelope),
      next_catalog: next_catalog,
      rotation: rotation,
      rotation_envelope: rotation_envelope,
      rotation_json: artifact_json(rotation_envelope),
      review: %{
        version: 1,
        product: :treehouse,
        space: space.replica,
        space_root: space.root.pub,
        bootstrap_id: space.bootstrap.id,
        observed_bootstrap_ids: [space.bootstrap.id],
        disposition: :pin_exact_observed_bootstrap
      }
    }
  end

  @spec sign_catalog(map(), Identity.t()) :: map()
  def sign_catalog(catalog, signer),
    do: %{
      catalog: catalog,
      signature: Identity.sign(signer, TransportCatalog.catalog_bytes(catalog))
    }

  @spec sign_rotation(map(), Identity.t(), Identity.t()) :: map()
  def sign_rotation(rotation, old, next) do
    %{
      rotation: rotation,
      old_signature: Identity.sign(old, TransportCatalog.rotation_bytes(rotation)),
      new_signature: Identity.sign(next, TransportCatalog.rotation_possession_bytes(rotation))
    }
  end

  @spec artifact_json(map()) :: binary()
  def artifact_json(value), do: value |> Wire.encode_value() |> Jason.encode!()

  @spec raw_history(Log.t()) :: map()
  def raw_history(%Log{} = log) do
    %{
      replica: log.replica,
      frames:
        log |> Log.ops() |> Map.values() |> Enum.sort_by(& &1.id) |> Enum.map(&Wire.encode_op/1),
      rejected:
        log
        |> Log.quarantine()
        |> Enum.sort_by(& &1.op.id)
        |> Enum.map(&%{frame: Wire.encode_op(&1.op), reason: :bad_signature})
    }
  end

  @spec write_public_fixture!(Path.t()) :: map()
  def write_public_fixture!(path) do
    fixture = fixture()
    rotation_id = TransportCatalog.rotation_id(fixture.rotation_envelope)
    rotated_catalog = %{fixture.catalog | binding: rotation_id}
    rotated_envelope = sign_catalog(rotated_catalog, fixture.next_catalog)

    vector = %{
      version: 1,
      review: %{
        version: 1,
        product: "treehouse",
        space: fixture.review.space,
        spaceRoot: Base.encode64(fixture.review.space_root),
        bootstrapId: fixture.review.bootstrap_id,
        observedBootstrapIds: fixture.review.observed_bootstrap_ids,
        disposition: "pin_exact_observed_bootstrap"
      },
      histories: fixture.histories,
      cutoffProofs:
        Enum.map(fixture.cutoff_proofs, fn proof ->
          %{
            cutoff: %{
              replica: proof.cutoff.replica,
              frontier: proof.cutoff.frontier,
              logDigest: proof.cutoff.log_digest
            },
            history: proof.history
          }
        end),
      catalogJson: fixture.catalog_json,
      rotationJson: fixture.rotation_json,
      rotatedCatalogJson: artifact_json(rotated_envelope),
      expected: %{
        catalogId: TransportCatalog.catalog_id(fixture.catalog),
        rotationId: rotation_id,
        rotatedCatalogId: TransportCatalog.catalog_id(rotated_catalog),
        catalogBytes: Base.encode64(TransportCatalog.catalog_bytes(fixture.catalog)),
        rotationBytes: Base.encode64(TransportCatalog.rotation_bytes(fixture.rotation)),
        possessionBytes:
          Base.encode64(TransportCatalog.rotation_possession_bytes(fixture.rotation)),
        payloads:
          fixture.histories
          |> Enum.flat_map(fn history ->
            Enum.map(history.frames, fn frame ->
              {:ok, op} = Wire.decode_op(frame)

              %{
                replica: history.replica,
                id: op.id,
                bytes: Base.encode64(Op.canonical_encoding(op))
              }
            end)
          end)
      }
    }

    File.write!(path, Jason.encode!(vector, pretty: true) <> "\n")
    vector
  end

  @spec read_ts_fixture!(Path.t()) :: map()
  def read_ts_fixture!(path) do
    raw = path |> File.read!() |> Jason.decode!()

    %{
      review: %{
        version: raw["review"]["version"],
        product: :treehouse,
        space: raw["review"]["space"],
        space_root: decode64!(raw["review"]["spaceRoot"], 32),
        bootstrap_id: raw["review"]["bootstrapId"],
        observed_bootstrap_ids: raw["review"]["observedBootstrapIds"],
        disposition: :pin_exact_observed_bootstrap
      },
      histories: Enum.map(raw["histories"], &decode_history!/1),
      cutoff_proofs: Enum.map(raw["cutoffProofs"], &decode_proof!/1),
      catalog_json: raw["catalogJson"],
      rotation_json: raw["rotationJson"],
      rotated_catalog_json: raw["rotatedCatalogJson"],
      fork_catalog_json: raw["forkCatalogJson"],
      expected: raw["expected"]
    }
  end

  @spec id(binary()) :: binary()
  def id(label),
    do: :crypto.hash(:sha256, "r11a-beam-trust:" <> label) |> Base.url_encode64(padding: false)

  defp thread(index, space, space_log) do
    root = Identity.from_seed("thread-root-#{index}", "r11a-beam-trust-thread-#{index}")

    replica =
      Authority.bind_replica(
        "replica:treehouse:thread:" <>
          id("thread-#{index}") <> "#authority:bounded-continuation-v1",
        root.pub
      )

    delegation =
      Delegation.genesis(root, replica,
        ops: [:create_thread, :post, :archive_thread],
        roles: [:moderator]
      )

    genesis = Op.new(root, replica, [], :authority, {:genesis, delegation, %{}})

    creation =
      Op.new(root, replica, [genesis.id], :command, {:create_thread, ["Thread #{index}"]},
        cap: delegation.id
      )

    reference =
      Op.new(
        space.root,
        space.replica,
        Log.frontier(space_log),
        :command,
        {:create_thread, [replica, "Thread #{index}"]},
        cap: space.delegation.id
      )

    %{
      root: root,
      replica: replica,
      delegation: delegation,
      genesis: genesis,
      creation: creation,
      reference: reference,
      log: Log.new(replica) |> Log.append!(genesis) |> Log.append!(creation)
    }
  end

  defp decode_history!(value) do
    if Enum.sort(Map.keys(value)) != ~w(frames rejected replica),
      do: raise("closed history expected")

    %{
      replica: value["replica"],
      frames: value["frames"],
      rejected:
        Enum.map(value["rejected"], fn rejected ->
          if Enum.sort(Map.keys(rejected)) != ~w(frame reason) or
               rejected["reason"] != "bad_signature",
             do: raise("closed rejection expected")

          %{frame: rejected["frame"], reason: :bad_signature}
        end)
    }
  end

  defp decode_proof!(value) do
    if Enum.sort(Map.keys(value)) != ~w(cutoff history), do: raise("closed proof expected")
    cutoff = value["cutoff"]

    if Enum.sort(Map.keys(cutoff)) != ~w(frontier logDigest replica),
      do: raise("closed cutoff expected")

    %{
      cutoff: %{
        replica: cutoff["replica"],
        frontier: cutoff["frontier"],
        log_digest: cutoff["logDigest"]
      },
      history: decode_history!(value["history"])
    }
  end

  defp decode64!(value, width) do
    {:ok, decoded} = Base.decode64(value)

    if Base.encode64(decoded) != value or byte_size(decoded) != width,
      do: raise("canonical Base64 expected")

    decoded
  end

  defp space_entry(space) do
    %{
      product: :treehouse,
      replica: space.replica,
      kind: :space,
      schema: :treehouse_space_v1,
      root: space.root.pub,
      genesis: space.genesis.id,
      creation: space.creation.id,
      reference: space.bootstrap.id,
      route: "/r/" <> id("space-route"),
      service_id: space.record.service_id,
      service_key: space.record.service_key
    }
  end

  defp thread_entry(thread, space) do
    %{
      product: :treehouse,
      replica: thread.replica,
      kind: :thread,
      schema: :treehouse_thread_v1,
      root: thread.root.pub,
      genesis: thread.genesis.id,
      creation: thread.creation.id,
      reference: thread.reference.id,
      route: "/r/" <> id("route:" <> thread.replica),
      service_id: space.record.service_id,
      service_key: space.record.service_key
    }
  end
end
