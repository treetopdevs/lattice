defmodule Lattice.Cap do
  @moduledoc """
  Unforgeable capability token.

  The opaque `id` is what a tab can safely serialize. The full struct is held on
  the server side and includes owner, target, operation, expiry, and audit data.
  """

  alias Lattice.Cap.{Caveat, Session}

  @enforce_keys [:id, :issuer, :owner_tab_id, :target, :ops, :created_at]
  defstruct [
    :id,
    :issuer,
    :owner_tab_id,
    :target,
    :ops,
    :parent_id,
    :root_id,
    :ttl_ms,
    :expires_at,
    :use_limit,
    uses: 0,
    caveats: [],
    delegation_allowed?: false,
    provenance: [],
    schema: nil,
    session: nil,
    revoked?: false,
    audit: %{},
    created_at: nil,
    revoked_at: nil,
    revoked_reason: nil,
    # --- Lattice 2.0 unification (design invariant 2) ---
    # `chain` is the verifiable signed delegation proof; `replica` ties this cap to
    # a Replica's op-log. The SAME cap therefore authorizes both a live Gateway
    # message (its v1 runtime fields) and a log op (its `chain` leaf is cited in
    # `Lattice.Op.cap`). See `Lattice.Live` and behavior 16.
    replica: nil,
    chain: []
  ]

  @type target ::
          {:server_pid, pid()}
          | {:server_name, atom()}
          | {:tab, String.t()}
          | term()

  @type t :: %__MODULE__{
          id: String.t(),
          issuer: term(),
          owner_tab_id: String.t(),
          target: target(),
          ops: MapSet.t(atom()),
          parent_id: String.t() | nil,
          root_id: String.t() | nil,
          ttl_ms: non_neg_integer() | nil,
          expires_at: integer() | nil,
          use_limit: pos_integer() | nil,
          uses: non_neg_integer(),
          caveats: [Caveat.t()],
          delegation_allowed?: boolean(),
          provenance: [map()],
          schema: map() | nil,
          session: Session.t() | nil,
          revoked?: boolean(),
          audit: map(),
          created_at: integer(),
          revoked_at: integer() | nil,
          revoked_reason: term(),
          replica: String.t() | nil,
          chain: [Lattice.Authority.Delegation.t()]
        }

  @doc "Attach a 2.0 delegation chain + replica to a v1 cap (unification)."
  def with_chain(%__MODULE__{} = cap, replica, chain) when is_list(chain),
    do: %{cap | replica: replica, chain: chain}

  @doc "The leaf (most-attenuated) delegation of this cap's chain, or nil."
  def leaf(%__MODULE__{chain: []}), do: nil
  def leaf(%__MODULE__{chain: chain}), do: List.last(chain)

  def new(owner_tab_id, target, ops, opts \\ []) when is_list(ops) or is_map(ops) do
    now = System.monotonic_time(:millisecond)
    ttl_ms = Keyword.get(opts, :ttl_ms) || Keyword.get(opts, :ttl)

    ttl_ms =
      case ttl_ms do
        nil -> nil
        ttl when is_integer(ttl) -> ttl
        ttl when is_float(ttl) -> round(ttl)
      end

    %__MODULE__{
      id: Keyword.get(opts, :id) || random_token(),
      issuer: Keyword.get(opts, :issuer, :server),
      owner_tab_id: owner_tab_id,
      target: target,
      ops: normalize_ops(ops),
      parent_id: Keyword.get(opts, :parent_id),
      root_id: Keyword.get(opts, :root_id),
      ttl_ms: ttl_ms,
      expires_at: Keyword.get(opts, :expires_at) || if(ttl_ms, do: now + ttl_ms),
      use_limit: Keyword.get(opts, :use_limit),
      caveats: Caveat.from_opts(opts),
      delegation_allowed?: Keyword.get(opts, :delegation_allowed?, false),
      provenance: Keyword.get(opts, :provenance, []),
      schema: Keyword.get(opts, :schema),
      session: Keyword.get(opts, :session) && Session.new(Keyword.fetch!(opts, :session)),
      audit: Keyword.get(opts, :audit, %{}),
      created_at: now
    }
    |> then(fn cap -> %{cap | root_id: cap.root_id || cap.id} end)
  end

  def random_token do
    32
    |> :crypto.strong_rand_bytes()
    |> Base.url_encode64(padding: false)
  end

  def normalize_ops(ops) do
    ops
    |> Enum.map(&normalize_op/1)
    |> MapSet.new()
  end

  def normalize_op(op) when is_atom(op), do: op
  def normalize_op(op) when is_binary(op), do: String.to_existing_atom(op)

  def token(%__MODULE__{id: id}), do: id
  def token(id) when is_binary(id), do: id

  def safe_token(%__MODULE__{id: id}) when is_binary(id), do: {:ok, id}
  def safe_token(id) when is_binary(id), do: {:ok, id}
  def safe_token(_), do: {:error, :malformed_cap}

  def expired?(%__MODULE__{expires_at: nil}), do: false

  def expired?(%__MODULE__{expires_at: expires_at}),
    do: System.monotonic_time(:millisecond) > expires_at

  def use_limited?(%__MODULE__{use_limit: nil}), do: false
  def use_limited?(%__MODULE__{use_limit: limit, uses: uses}), do: uses >= limit

  def revoke(%__MODULE__{} = cap, reason) do
    %{
      cap
      | revoked?: true,
        revoked_at: System.monotonic_time(:millisecond),
        revoked_reason: reason
    }
  end

  def external(%__MODULE__{} = cap) do
    %{
      "id" => cap.id,
      "owner_tab_id" => cap.owner_tab_id,
      "parent_id" => cap.parent_id,
      "root_id" => cap.root_id,
      "ops" => cap.ops |> MapSet.to_list() |> Enum.map(&Atom.to_string/1),
      "ttl_ms" => cap.ttl_ms,
      "expires_at" => cap.expires_at,
      "use_limit" => cap.use_limit,
      "caveats" => Enum.map(cap.caveats, &Caveat.external/1),
      "delegation_allowed" => cap.delegation_allowed?,
      "provenance" => cap.provenance,
      "target" => target_label(cap.target)
    }
  end

  def target_label({:server_pid, _pid}), do: "server_process"
  def target_label({:server_name, name}), do: Atom.to_string(name)
  def target_label({:tab, tab_id}), do: "tab:" <> tab_id
  def target_label(other), do: inspect(other)

  def target_labels({:server_pid, pid} = target), do: [target_label(target), inspect(pid)]
  def target_labels(target), do: [target_label(target)]
end
