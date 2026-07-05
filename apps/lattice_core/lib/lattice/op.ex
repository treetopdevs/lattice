defmodule Lattice.Op do
  @moduledoc """
  A single capability-attested operation in a Replica's op-log.

  An `Op` is the atom of Lattice 2.0: a Replica's *identity* is its durable
  append-only set of ops, and every materialization is a pure reduction of that
  set. The `id` is the SHA-256 hash of the canonical encoding of every other
  field, which makes the log a hash-DAG: mutating any field changes the id and
  therefore breaks every descendant that cited the old id in its `deps`.

  ## Fields

    * `id`       — `<<op hash>>`, the content hash (see `canonical_encoding/1`)
    * `replica`  — the Replica log this op belongs to
    * `author`   — Ed25519 public key of the authoring realm
    * `deps`     — causal frontier: ids of direct predecessors this op saw
    * `kind`     — `:command | :authority | :inbox | :tombstone`
    * `body`     — payload term, e.g. `{:post, text}` / `{:transfer, deleg, to}`
    * `cap`      — proof: references into the delegation chain justifying this op
    * `sig`      — Ed25519 signature by `author` over the canonical encoding

  ## Canonical encoding

  The signed/hashed bytes are `Lattice.Canonical` bytes over
  `{replica, author, sorted(deps), kind, body, cap}`. `deps` is sorted so
  frontier order never affects the id. See
  `docs/adr/0001-canonical-encoding.md` for the caveats of this choice.
  """

  alias Lattice.Identity

  @enforce_keys [:id, :replica, :author, :deps, :kind, :body, :sig]
  defstruct [:id, :replica, :author, :deps, :kind, :body, :cap, :sig]

  @type kind :: :command | :authority | :inbox | :tombstone
  @type id :: String.t()
  @type t :: %__MODULE__{
          id: id(),
          replica: String.t(),
          author: Identity.pubkey(),
          deps: [id()],
          kind: kind(),
          body: term(),
          cap: term(),
          sig: binary()
        }

  @doc """
  Build and sign a new op authored by `identity`.

  `deps` is the set of ids the author currently sees as the frontier of the
  replica; it is deduplicated and sorted before hashing so the id is independent
  of frontier ordering.
  """
  @spec new(Identity.t(), String.t(), [id()], kind(), term(), keyword()) :: t()
  def new(%Identity{} = identity, replica, deps, kind, body, opts \\ [])
      when is_binary(replica) and is_list(deps) and is_atom(kind) do
    cap = Keyword.get(opts, :cap)
    sorted_deps = normalize_deps(deps)
    encoding = canonical_bytes(replica, identity.pub, sorted_deps, kind, body, cap)

    %__MODULE__{
      id: hash(encoding),
      replica: replica,
      author: identity.pub,
      deps: sorted_deps,
      kind: kind,
      body: body,
      cap: cap,
      sig: Identity.sign(identity, encoding)
    }
  end

  @doc "Recompute the canonical encoding (the signed/hashed bytes) of an op."
  @spec canonical_encoding(t()) :: binary()
  def canonical_encoding(%__MODULE__{} = op) do
    canonical_bytes(op.replica, op.author, normalize_deps(op.deps), op.kind, op.body, op.cap)
  end

  @doc """
  Verify an op is internally consistent: its id matches its content hash and its
  signature verifies against its declared author. This is the tamper check run
  at sync time (behavior 4).
  """
  @spec valid?(t()) :: boolean()
  def valid?(%__MODULE__{} = op) do
    encoding = canonical_encoding(op)
    op.id == hash(encoding) and Identity.verify(op.author, encoding, op.sig)
  end

  @doc "Recompute what an op's id *should* be from its content (ignoring the stored id)."
  @spec recompute_id(t()) :: id()
  def recompute_id(%__MODULE__{} = op), do: hash(canonical_encoding(op))

  @doc "Deduplicate and sort a dependency list deterministically."
  @spec normalize_deps([id()]) :: [id()]
  def normalize_deps(deps) when is_list(deps), do: deps |> Enum.uniq() |> Enum.sort()

  defp canonical_bytes(replica, author, deps, kind, body, cap) do
    Lattice.Canonical.op_bytes(replica, author, deps, kind, body, cap)
  end

  defp hash(bytes) do
    :crypto.hash(:sha256, bytes) |> Base.url_encode64(padding: false)
  end
end
