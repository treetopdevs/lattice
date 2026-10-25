defmodule LatticeCarrierServer.Operator.InitialBundle do
  @moduledoc """
  Closed public evidence for initial ordinary Treehouse provisioning.

  Decoding authenticates complete signed histories and derives the initial
  inventory. It neither installs client trust nor writes operator state.
  """
  alias Lattice.{Authority, Log, Op}
  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.Operator.{ReferenceMode, Staging}
  alias LatticeCarrierServer.Operator.CatalogCeremony.Atoms
  alias Treehouse.CatalogBootstrap

  @format "treehouse-initial-provisioning-v1"
  @max_bytes 2 * 1024 * 1024
  @max_frames 4000
  @history_bytes 1_048_576
  @keys ~w(bootstrapId format product profiles referenceId space spaceRoot)
  @profile_keys ~w(frames product replica)
  @frame_keys ~w(author body cap deps id kind replica sig v)
  @member_ops MapSet.new([:post, :author_edit, :author_tombstone])

  @spec load(Path.t()) :: {:ok, map()} | {:error, :invalid_initial_bundle}
  def load(path) do
    with {:ok, %{type: :regular, size: size}} when size <= @max_bytes <- File.lstat(path),
         {:ok, bytes} <- File.read(path) do
      decode(bytes)
    else
      _ -> {:error, :invalid_initial_bundle}
    end
  end

  @spec decode(term()) :: {:ok, map()} | {:error, :invalid_initial_bundle}
  def decode(bytes) when is_binary(bytes) and byte_size(bytes) <= @max_bytes do
    Atoms.load()

    with true <- String.valid?(bytes),
         {:ok, doc} when is_map(doc) <- JSON.decode(bytes),
         true <- Enum.sort(Map.keys(doc)) == @keys,
         @format <- doc["format"],
         "treehouse" <- doc["product"],
         [space_doc, child_doc] <- doc["profiles"],
         {:ok, space} <- profile(space_doc, "Treehouse.Space", :space, :admin),
         {:ok, child} <- profile(child_doc, "Treehouse.Thread", :thread, :moderator),
         true <- length(space_doc["frames"]) + length(child_doc["frames"]) <= @max_frames,
         true <- space.replica == doc["space"],
         true <- Base.encode64(Authority.root(space)) == doc["spaceRoot"],
         true <- Authority.root(space) != Authority.root(child),
         {:ok, %{bootstraps: [bootstrap]}} <- CatalogBootstrap.observe(space),
         true <- bootstrap.id == doc["bootstrapId"],
         true <- space.ops[bootstrap.id].author == Authority.root(space),
         true <- bootstrap.record.space_root == Authority.root(space),
         true <- bootstrap.record.space == space.replica,
         true <-
           bootstrap.record.service_key not in [Authority.root(space), Authority.root(child)],
         {:ok, inventory} <- inventory(space, child, doc["referenceId"]),
         true <- Base.encode64(bootstrap.record.service_key) not in inventory.roster,
         true <- canonical(doc) == bytes,
         true <- fits_initial_state?(doc, inventory.roster, Authority.root(child)) do
      {:ok,
       Map.merge(inventory, %{space: space, child: child, bootstrap: bootstrap, bytes: bytes})}
    else
      _ -> {:error, :invalid_initial_bundle}
    end
  rescue
    _ -> {:error, :invalid_initial_bundle}
  catch
    _, _ -> {:error, :invalid_initial_bundle}
  end

  def decode(_), do: {:error, :invalid_initial_bundle}

  @spec encode(Log.t(), Log.t(), String.t(), String.t()) :: binary()
  def encode(space, child, bootstrap_id, reference_id) do
    canonical(%{
      "format" => @format,
      "product" => "treehouse",
      "space" => space.replica,
      "spaceRoot" => Base.encode64(Authority.root(space)),
      "bootstrapId" => bootstrap_id,
      "referenceId" => reference_id,
      "profiles" => [
        export_profile(space, "Treehouse.Space"),
        export_profile(child, "Treehouse.Thread")
      ]
    })
  end

  @doc "Compact canonical JSON for the closed public evidence formats."
  @spec canonical(term()) :: binary()
  def canonical(map) when is_map(map) do
    "{" <>
      (map
       |> Enum.sort_by(&elem(&1, 0))
       |> Enum.map_join(",", fn {key, value} ->
         JSON.encode!(key) <> ":" <> canonical(value)
       end)) <> "}"
  end

  def canonical(list) when is_list(list), do: "[" <> Enum.map_join(list, ",", &canonical/1) <> "]"
  def canonical(value), do: JSON.encode!(value)

  defp profile(doc, product, kind, role) when is_map(doc) do
    with true <- Enum.sort(Map.keys(doc)) == @profile_keys and doc["product"] == product,
         replica when is_binary(replica) <- doc["replica"],
         frames when is_list(frames) and length(frames) in 1..@max_frames <- doc["frames"],
         {:ok, ops} <- decode_frames(frames, replica),
         log = Log.from_ops(replica, Map.new(ops, &{&1.id, &1})),
         :ok <- Log.verify_authenticity(log),
         {:ok, selected} <- Authority.continuation_profile(log),
         true <-
           selected.profile.product == :treehouse and selected.profile.kind == kind and
             selected.profile.role == role do
      {:ok, log}
    else
      _ -> :error
    end
  end

  defp profile(_, _, _, _), do: :error

  defp decode_frames(frames, replica) do
    Enum.reduce_while(frames, {:ok, []}, fn frame, {:ok, acc} ->
      with true <- is_map(frame) and Enum.sort(Map.keys(frame)) == @frame_keys,
           true <- byte_size(canonical(%{"type" => "push", "ops" => [frame]})) <= 64_000,
           {:ok, %Op{replica: ^replica} = op} <- Wire.decode_op(frame),
           true <- Wire.encode_op(op) == frame do
        {:cont, {:ok, [op | acc]}}
      else
        _ -> {:halt, :error}
      end
    end)
    |> case do
      {:ok, reversed} ->
        ops = Enum.reverse(reversed)
        ids = Enum.map(ops, & &1.id)
        if ids == Enum.sort(ids) and ids == Enum.uniq(ids), do: {:ok, ops}, else: :error

      _ ->
        :error
    end
  end

  defp inventory(space, child, reference_id) do
    root = Authority.root(child)
    analysis = Authority.analyze(Treehouse.Thread, child)
    roster = Staging.roster(space)

    with true <-
           analysis.reasons == %{} and not Authority.tombstoned?(child) and
             not Authority.tombstoned?(space),
         true <- length(roster) == 2 and Base.encode64(Authority.root(space)) in roster,
         {:ok, selected} <- Authority.continuation_profile(child),
         [%Op{body: {:genesis, root_grant, policies}} = genesis] <-
           for({_id, %Op{kind: :authority, deps: [], author: ^root} = op} <- child.ops, do: op),
         true <- policies == %{},
         [%Op{id: creation}] <-
           for({_id, %Op{kind: :command, body: {:create_thread, [_]}} = op} <- child.ops, do: op),
         grants <- grants(child, root, root_grant.id),
         true <- Enum.sort(Enum.map(grants, & &1["recipient"])) == roster,
         reference when not is_nil(reference) <- space.ops[reference_id],
         review = %{
           "creation" => creation,
           "profile_genesis" => selected.profile_genesis,
           "profile_id" => selected.profile_id,
           "grants" => grants
         },
         bundle = %{
           child: %{replica: child.replica, review: review},
           reference: %{
             replica: space.replica,
             op_id: reference_id,
             bytes: canonical(Wire.encode_op(reference)),
             review: %{"mode" => "initial_existing"}
           }
         },
         :ok <- Staging.verify_child_log(child, Map.put(bundle.child, :op_id, genesis.id)),
         {:ok, _} <- ReferenceMode.observe(bundle, space, child) do
      {:ok,
       %{roster: roster, reference: reference, child_genesis: genesis.id, child_review: review}}
    else
      _ -> :error
    end
  end

  defp grants(log, root, parent) do
    for {id, %Op{kind: :authority, body: {:grant, d}}} <- log.ops,
        Authority.delegation_active?(log, d.id),
        not Authority.revoked?(log, d.id) do
      true =
        d.issuer == root and d.parent_id == parent and d.ops == @member_ops and
          MapSet.size(d.roles) == 0 and d.live == false

      %{"recipient" => Base.encode64(d.audience), "delegation" => d.id, "introduction" => id}
    end
    |> Enum.sort_by(& &1["recipient"])
  end

  defp export_profile(log, product) do
    %{
      "product" => product,
      "replica" => log.replica,
      "frames" => log.ops |> Map.values() |> Enum.sort_by(& &1.id) |> Enum.map(&Wire.encode_op/1)
    }
  end

  defp fits_initial_state?(doc, roster, child_root) do
    Enum.all?(roster, fn participant ->
      owned =
        if participant == doc["spaceRoot"],
          do: [participant, Base.encode64(child_root)],
          else: [participant]

      profiles =
        Enum.map(doc["profiles"], fn profile ->
          Map.merge(profile, %{
            "outbox" =>
              for(frame <- profile["frames"], frame["author"] in owned, do: frame["id"]),
            "acked" => []
          })
        end)

      state = %{
        "version" => 2,
        "product" => "treehouse",
        "revision" => 0,
        "publicKey" => participant,
        "profiles" => profiles,
        "active" => List.last(profiles)["replica"],
        "intent" => nil,
        "clearedDrafts" => %{},
        "relay" => nil
      }

      byte_size(canonical(state)) <= @history_bytes
    end)
  end
end
