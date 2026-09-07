defmodule Lattice.Log do
  @moduledoc """
  Append-only, per-Replica op store with causal frontier tracking.

  A `Log` is an immutable value: appending or accepting returns a new `Log`. This
  gives clean copy semantics for partition simulation — two realms simply hold two
  diverging `Log` values that `Lattice.Sync` later reconciles.

  `accept/3` is the single op-application path shared by live delivery and
  post-partition sync (design invariant 1). It performs only *structural*
  validation:

    * replica match,
    * idempotency (re-accepting a known op is a no-op),
    * signature + content-hash integrity (a tampered op is quarantined here —
      behavior 4),
    * dependency availability (an op whose `deps` are not yet present is reported
      `:missing_deps` so the caller can buffer and retry).

  *Semantic* validity — whether an op's capability proof authorizes it, whether an
  authoritative op was authored by the holder-at-its-causal-position, whether a
  delegation was revoked — is deliberately **not** decided here. That depends on
  concurrent ops that may arrive later, so it is computed deterministically at
  reduction time by `Lattice.Authority`/`Lattice.Reduce` over the whole op set.
  Nothing is dropped: structurally-rejected ops are retained in `quarantine` and
  are auditable (design invariant 4).

  Persistence: `dump/2` / `restore/1` serialize the whole log to disk for the
  realm death-and-resurrection test (behavior 14).
  """

  alias Lattice.{Dag, Op}

  defstruct replica: nil, ops: %{}, referenced: MapSet.new(), quarantine: []

  @type quarantine_entry :: %{op: Op.t(), reason: atom()}
  @type t :: %__MODULE__{
          replica: String.t(),
          ops: %{Op.id() => Op.t()},
          referenced: MapSet.t(Op.id()),
          quarantine: [quarantine_entry()]
        }

  @spec new(String.t()) :: t()
  def new(replica) when is_binary(replica), do: %__MODULE__{replica: replica}

  @doc "Build a log directly from an op map (recomputes the referenced set). Used for causal slices in time travel."
  @spec from_ops(String.t(), %{Op.id() => Op.t()}) :: t()
  def from_ops(replica, ops) when is_binary(replica) and is_map(ops) do
    referenced =
      Enum.reduce(ops, MapSet.new(), fn {_id, op}, acc ->
        MapSet.union(acc, MapSet.new(op.deps))
      end)

    %__MODULE__{replica: replica, ops: ops, referenced: referenced}
  end

  @spec has?(t(), Op.id()) :: boolean()
  def has?(%__MODULE__{ops: ops}, id), do: Map.has_key?(ops, id)

  @spec structurally_quarantined?(t(), Op.id()) :: boolean()
  def structurally_quarantined?(%__MODULE__{quarantine: q}, id),
    do: Enum.any?(q, &(&1.op.id == id))

  @spec fetch(t(), Op.id()) :: {:ok, Op.t()} | :error
  def fetch(%__MODULE__{ops: ops}, id), do: Map.fetch(ops, id)

  @spec size(t()) :: non_neg_integer()
  def size(%__MODULE__{ops: ops}), do: map_size(ops)

  @spec ops(t()) :: %{Op.id() => Op.t()}
  def ops(%__MODULE__{ops: ops}), do: ops

  @spec op_ids(t()) :: MapSet.t(Op.id())
  def op_ids(%__MODULE__{ops: ops}), do: ops |> Map.keys() |> MapSet.new()

  @doc "Ops in canonical total order (see `Lattice.Dag`)."
  @spec topo_ops(t()) :: [Op.t()]
  def topo_ops(%__MODULE__{ops: ops}), do: Dag.topo_sort(ops)

  @doc "Current causal frontier: ids of ops that no other op depends on."
  @spec frontier(t()) :: [Op.id()]
  def frontier(%__MODULE__{ops: ops, referenced: referenced}) do
    ops |> Map.keys() |> Enum.reject(&MapSet.member?(referenced, &1)) |> Enum.sort()
  end

  @doc "Structurally-rejected ops with reasons, in arrival order, for audit."
  @spec quarantine(t()) :: [quarantine_entry()]
  def quarantine(%__MODULE__{quarantine: q}), do: Enum.reverse(q)

  @doc "Validate and normalize the untrusted structural-quarantine evidence in a log."
  @spec verified_quarantine(t()) ::
          {:ok, [%{op_id: Op.id(), reason: :bad_signature}]}
          | {:error, :invalid_structural_quarantine}
  def verified_quarantine(%__MODULE__{replica: replica, quarantine: entries})
      when is_binary(replica) and is_list(entries) do
    entries
    |> Enum.reduce_while({[], MapSet.new()}, fn
      %{op: %Op{} = op, reason: :bad_signature} = entry, {findings, ids}
      when map_size(entry) == 2 ->
        if is_binary(op.id) and op.replica == replica and not valid_op?(op) and
             not MapSet.member?(ids, op.id) do
          finding = %{op_id: op.id, reason: :bad_signature}
          {:cont, {[finding | findings], MapSet.put(ids, op.id)}}
        else
          {:halt, :error}
        end

      _entry, _acc ->
        {:halt, :error}
    end)
    |> case do
      {findings, _ids} -> {:ok, Enum.sort_by(findings, & &1.op_id)}
      :error -> {:error, :invalid_structural_quarantine}
    end
  rescue
    _ -> {:error, :invalid_structural_quarantine}
  end

  def verified_quarantine(_log), do: {:error, :invalid_structural_quarantine}

  @doc """
  Verify an untrusted log before a consumer materializes or installs it.

  Every accepted op must match its map key and replica, have all dependencies
  present, and pass its content-hash and declared-author signature checks. The
  referenced set must match those dependencies. Structural quarantine is checked
  separately by `verified_quarantine/1`: its rejected signatures are evidence,
  never accepted operations.

  This proves internal integrity and accepted-op authenticity, not semantic
  authority or completeness. It cannot detect an operation never included in the
  log. Consumers must also bind `log.replica` to their requested replica.
  """
  @spec verify_authenticity(t()) :: :ok | {:error, [String.t()]}
  def verify_authenticity(
        %__MODULE__{
          replica: replica,
          ops: ops,
          referenced: %MapSet{} = referenced,
          quarantine: quarantine
        } = log
      )
      when is_binary(replica) and byte_size(replica) > 0 and is_map(ops) and is_list(quarantine) do
    op_errors = Enum.flat_map(ops, &verify_stored_op(&1, replica, ops))

    reference_errors =
      if op_errors == [] do
        expected =
          Enum.reduce(ops, MapSet.new(), fn {_, op}, acc ->
            MapSet.union(acc, MapSet.new(op.deps))
          end)

        if MapSet.equal?(referenced, expected), do: [], else: ["log referenced set mismatch"]
      else
        []
      end

    quarantine_errors =
      case verified_quarantine(log) do
        {:ok, _evidence} -> []
        {:error, _reason} -> ["log structural quarantine invalid"]
      end

    case Enum.sort(op_errors ++ reference_errors ++ quarantine_errors) do
      [] -> :ok
      errors -> {:error, errors}
    end
  rescue
    _error -> {:error, ["log structure invalid"]}
  end

  def verify_authenticity(_log), do: {:error, ["log structure invalid"]}

  defp verify_stored_op({id, %Op{id: op_id, replica: replica, deps: deps} = op}, replica, ops)
       when is_binary(id) and is_list(deps) do
    cond do
      id != op_id -> ["log op #{id}: map key does not match op id"]
      not valid_op?(op) -> ["log op #{id}: invalid content hash or signature"]
      not Enum.all?(deps, &Map.has_key?(ops, &1)) -> ["log op #{id}: missing dependencies"]
      true -> []
    end
  end

  defp verify_stored_op({id, _op}, _replica, _ops),
    do: ["log op #{inspect(id)}: invalid structure or replica"]

  @doc """
  Accept an op into the log.

  Returns:
    * `{:ok, log}` — accepted (or already present; idempotent)
    * `{:quarantined, log, reason}` — structurally invalid, retained for audit
    * `{:missing_deps, log, missing_ids}` — caller should buffer until deps arrive
    * `{:rejected, log, reason}` — wrong replica; not stored
  """
  @spec accept(t(), Op.t()) ::
          {:ok, t()}
          | {:quarantined, t(), atom()}
          | {:missing_deps, t(), [Op.id()]}
          | {:rejected, t(), atom()}
  def accept(%__MODULE__{} = log, %Op{} = op) do
    cond do
      op.replica != log.replica ->
        {:rejected, log, :wrong_replica}

      has?(log, op.id) ->
        {:ok, log}

      # Signature is checked BEFORE the quarantine guard so a genuine op can never be
      # blocked by a previously-quarantined forgery sharing its id (the id excludes
      # the signature, so a forgery can poison an id otherwise). Invalid ops are
      # quarantined idempotently.
      not Op.valid?(op) ->
        if structurally_quarantined?(log, op.id) do
          {:quarantined, log, :already_quarantined}
        else
          {:quarantined, quarantine_op(log, op, :bad_signature), :bad_signature}
        end

      true ->
        case missing_deps(log, op) do
          [] -> {:ok, insert(log, op)}
          missing -> {:missing_deps, log, missing}
        end
    end
  end

  @doc """
  Append a locally-authored op. Same path as `accept/2` but raises if the op is
  not acceptable, since a realm should never author an op it cannot append.
  """
  @spec append!(t(), Op.t()) :: t()
  def append!(%__MODULE__{} = log, %Op{} = op) do
    case accept(log, op) do
      {:ok, log} ->
        log

      {other, _log, reason} ->
        raise ArgumentError, "cannot append op (#{other}): #{inspect(reason)}"
    end
  end

  defp missing_deps(%__MODULE__{} = log, %Op{deps: deps}),
    do: Enum.reject(deps, &has?(log, &1))

  defp insert(%__MODULE__{} = log, %Op{} = op) do
    %{
      log
      | ops: Map.put(log.ops, op.id, op),
        referenced: MapSet.union(log.referenced, MapSet.new(op.deps))
    }
  end

  defp quarantine_op(%__MODULE__{} = log, %Op{} = op, reason) do
    %{log | quarantine: [%{op: op, reason: reason} | log.quarantine]}
  end

  defp valid_op?(op) do
    Op.valid?(op)
  rescue
    _ -> false
  end

  # --- Persistence (behavior 14) -------------------------------------------

  @doc "Serialize the whole log deterministically (ops + structural quarantine) to disk."
  @spec dump(t(), Path.t()) :: :ok | {:error, term()}
  def dump(%__MODULE__{} = log, path) do
    File.write(
      path,
      :erlang.term_to_binary({:lattice_log_dump_v1, downgrade_structs(log)}, [:deterministic])
    )
  end

  # The dump-side mirror of `upgrade_structs/1`: a nil-lease delegation dumps in
  # the pre-149 nine-key shape verbatim, so lease-free logs keep byte-identical
  # dump artifacts (and dump ∘ restore is the identity on old dumps). Only a
  # delegation that actually carries a lease serializes the new key.
  defp downgrade_structs(%__MODULE__{ops: ops} = log) do
    %{log | ops: Map.new(ops, fn {id, op} -> {id, downgrade_op(op)} end)}
  end

  defp downgrade_op(%Op{body: body} = op), do: %{op | body: downgrade_body(body)}

  defp downgrade_body({:genesis, delegation, policies}),
    do: {:genesis, downgrade_delegation(delegation), policies}

  defp downgrade_body({:grant, delegation}), do: {:grant, downgrade_delegation(delegation)}

  defp downgrade_body({:transfer, role, delegation, tick}),
    do: {:transfer, role, downgrade_delegation(delegation), tick}

  defp downgrade_body({:succeed, role, delegation, proof}),
    do: {:succeed, role, downgrade_delegation(delegation), proof}

  defp downgrade_body(body), do: body

  defp downgrade_delegation(%Lattice.Authority.Delegation{expires_epoch: nil} = delegation) do
    Map.delete(delegation, :expires_epoch)
  end

  defp downgrade_delegation(other), do: other

  @doc "Restore a log previously written with `dump/2`."
  @spec restore(Path.t()) :: {:ok, t()} | {:error, term()}
  def restore(path) do
    with :ok <- ensure_dump_vocabulary(),
         {:ok, bin} <- File.read(path),
         {:ok, term} <- safe_binary_to_term(bin),
         {:lattice_log_dump_v1, %__MODULE__{} = log} <- term do
      {:ok, upgrade_structs(log)}
    else
      {:error, _} = err -> err
      _ -> {:error, :corrupt_dump}
    end
  end

  @doc """
  Capture and verify a dump before a consumer replaces state or reports provenance.

  The returned log and lowercase SHA-256 fingerprint come from the same single
  file read. Legacy delegation structs are upgraded as in `restore/1`, while
  malformed dumps fail closed before a caller installs anything. Authenticity has
  the limits documented in `verify_authenticity/1`; this does not establish
  completeness or bind the log to a consumer's requested replica.

  `restore/1` retains its existing unverified deserialization contract.
  """
  @spec restore_verified(Path.t()) ::
          {:ok, %{log: t(), sha256: String.t()}} | {:error, term()}
  def restore_verified(path) do
    with :ok <- ensure_dump_vocabulary(),
         {:ok, bytes} <- File.read(path),
         {:ok, {:lattice_log_dump_v1, %__MODULE__{ops: ops} = stored}} <-
           safe_binary_to_term(bytes),
         true <- is_map(ops),
         log = upgrade_structs(stored),
         :ok <- verify_authenticity(log) do
      {:ok, %{log: log, sha256: :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)}}
    else
      {:error, _reason} = error -> error
      _invalid -> {:error, :invalid_log}
    end
  rescue
    _error -> {:error, :invalid_log}
  end

  # `:safe` blocks atom/resource creation from a tampered dump; a dump referencing
  # unknown atoms (or otherwise unsafe terms) raises, which we map to an error.
  defp safe_binary_to_term(bin) do
    {:ok, :erlang.binary_to_term(bin, [:safe])}
  rescue
    _ -> {:error, :unsafe_dump}
  end

  # `:safe` restore refuses atoms the running VM has not interned, and a freshly
  # booted server VM loads modules lazily — so the decoder must bring the dump
  # format's substrate vocabulary with it before decoding: the struct modules a
  # dump embeds intern their own atom chunks when loaded, and the policy-map
  # keys below belong to no single module. App-level atoms (roles, command
  # names) remain the responsibility of the application modules the host loads.
  defp ensure_dump_vocabulary do
    Enum.each([Op, Lattice.Authority.Delegation, MapSet], fn module ->
      {:module, ^module} = Code.ensure_loaded(module)
    end)

    _ = known_dump_policy_atoms()
    :ok
  end

  @doc false
  def known_dump_policy_atoms do
    [
      :command,
      :authority,
      :inbox,
      :tombstone,
      :mode,
      :witnessed,
      :recovery,
      :witnesses,
      :threshold,
      :successor,
      :version,
      :dormant_ticks,
      :claim,
      :signatures,
      :witness,
      :signature,
      :holder,
      :holder_epoch,
      :policy_id,
      :role,
      :replica,
      :__beacon__,
      :max_epoch_step,
      :epoch,
      :author,
      :deps,
      :beacon,
      :__continuation__,
      :bounded_continuation,
      :continuation_v1,
      :product,
      :treehouse,
      :kind,
      :space,
      :thread,
      :admin,
      :moderator,
      :nominee,
      :max_lease_epochs,
      :profile_id,
      :profile_genesis,
      :delegation_id,
      :epoch_basis
    ]
  end

  # A dump written before a struct gained a field carries maps missing that key
  # (e.g. `Delegation.expires_epoch`, plan 149). Rebuilding through `struct/2`
  # fills new keys with their defaults without touching any persisted value, so
  # an old dump restores to exactly the delegation a nil-lease `new/4` builds
  # today — same bytes, same id, same signature.
  defp upgrade_structs(%__MODULE__{ops: ops} = log) do
    %{log | ops: Map.new(ops, fn {id, op} -> {id, upgrade_op(op)} end)}
  end

  defp upgrade_op(%Op{body: body} = op), do: %{op | body: upgrade_body(body)}

  defp upgrade_body({:genesis, delegation, policies}),
    do: {:genesis, upgrade_delegation(delegation), policies}

  defp upgrade_body({:grant, delegation}), do: {:grant, upgrade_delegation(delegation)}

  defp upgrade_body({:transfer, role, delegation, tick}),
    do: {:transfer, role, upgrade_delegation(delegation), tick}

  defp upgrade_body({:succeed, role, delegation, proof}),
    do: {:succeed, role, upgrade_delegation(delegation), proof}

  defp upgrade_body(body), do: body

  defp upgrade_delegation(%{__struct__: Lattice.Authority.Delegation} = delegation) do
    struct(Lattice.Authority.Delegation, Map.delete(delegation, :__struct__))
  end

  defp upgrade_delegation(other), do: other
end
