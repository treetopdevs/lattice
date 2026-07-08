defmodule Lattice.Carrier do
  @moduledoc """
  The carrier seam: how a realm's `Lattice.Log` talks to one peer over *some*
  transport (plan 010; `docs/adr/0005-carrier-interface.md`).

  A carrier is a module implementing this behaviour plus an opaque connection
  value (`conn`). The behaviour is deliberately minimal — exactly what
  `Lattice.Sync` needs to reconcile two logs across a boundary, plus one
  ephemeral (never-logged) delivery path for `Lattice.Live`-style traffic:

    * `advertise/2` — announce our log to the peer; learn the peer's op-id set
      (the POC-scale "frontier advert"; a production carrier would negotiate
      recursively from frontiers, Beelay-style — see `docs/path_to_real.md` §2).
    * `pull/2` — fetch the ops the peer holds that we lack, in causal order.
    * `push/2` — transfer ops the peer lacks; the peer applies them through
      `Lattice.Log.accept/2` (same integrity/quarantine path as local delivery)
      and reports the outcome.
    * `live/2` — deliver a transient message that must never enter any log.

  Connection establishment/teardown is *not* part of the behaviour: it differs
  too much per transport (the simulator has no sockets) and nothing in the sync
  contract depends on it.

  `sync/3` is the transport-independent reconciliation driver: it composes the
  callbacks with the unchanged `Lattice.Sync` functions, so any carrier that
  implements the behaviour gets the same convergence, idempotency, and
  quarantine semantics the simulator pins.

  Implementations: `Lattice.Carrier.SimNet` (in-process, gated by
  `Lattice.Net`) and the plan-010 spike's WebSocket carrier
  (`LatticeNodeSpike.WsCarrier`, over a real socket between two OS processes).
  """

  alias Lattice.Carrier.Telemetry
  alias Lattice.Log
  alias Lattice.Op
  alias Lattice.Sync
  alias Lattice.Sync.Shape

  @typedoc "Opaque, implementation-defined connection value."
  @type conn :: term()

  @typedoc "Per-sync transfer summary returned by `sync/3`."
  @type stats :: %{
          sent: non_neg_integer(),
          received: non_neg_integer(),
          pushed: Sync.report(),
          pulled: Sync.report()
        }

  @doc "Announce `log` to the peer and return the peer's current op-id set."
  @callback advertise(conn(), Log.t()) :: {:ok, MapSet.t(Op.id()), conn()} | {:error, term()}

  @doc "Ops the peer holds that are missing from `have`, in causal order."
  @callback pull(conn(), MapSet.t(Op.id())) :: {:ok, [Op.t()], conn()} | {:error, term()}

  @doc "Transfer `ops` to the peer; returns the peer's acceptance report."
  @callback push(conn(), [Op.t()]) :: {:ok, Sync.report(), conn()} | {:error, term()}

  @doc "Deliver an ephemeral message. Must never be written to any log."
  @callback live(conn(), term()) :: {:ok, conn()} | {:error, term()}

  @doc """
  Reconcile `log` with the peer behind `conn` using carrier module `carrier`.

  Pushes what the peer lacks, pulls what we lack, and applies the pulled ops
  through `Lattice.Sync.deliver/2` (i.e. `Lattice.Log.accept/2` — tampered ops
  are quarantined, missing-dep ops are buffered and retried). Returns the
  updated local log, transfer stats, and the updated connection.

  Running `sync/3` twice in a row transfers nothing the second time (`sent: 0,
  received: 0`) — the idempotency half of the plan-010 GATE.
  """
  @spec sync(module(), conn(), Log.t()) ::
          {:ok, Log.t(), stats(), conn()} | {:error, term()}
  def sync(carrier, conn, %Log{} = log) when is_atom(carrier) do
    sync(carrier, conn, log, [])
  end

  @doc """
  Reconcile with options.

  Supported options:

    * `:shape` — a `Lattice.Sync.Shape` used to restrict the outbound op set to a
      dependency-closed subset. Pull remains carrier-defined unless a carrier grows a
      shape-aware pull callback.
  """
  @spec sync(module(), conn(), Log.t(), keyword()) ::
          {:ok, Log.t(), stats(), conn()} | {:error, term()}
  def sync(carrier, conn, %Log{} = log, opts) when is_atom(carrier) and is_list(opts) do
    shape = Keyword.get(opts, :shape)

    with {:ok, peer_ids, conn} <- carrier.advertise(conn, log),
         to_push = missing(log, peer_ids, shape),
         {:ok, push_report, conn} <- carrier.push(conn, to_push),
         {:ok, pulled, conn} <- carrier.pull(conn, Log.op_ids(log)) do
      {log, pull_report} = Sync.deliver(log, pulled)

      stats = %{
        sent: length(to_push),
        received: length(pulled),
        pushed: push_report,
        pulled: pull_report
      }

      Telemetry.execute(
        [:lattice, :carrier, :sync, :stop],
        %{sent: stats.sent, received: stats.received},
        %{carrier: carrier}
      )

      {:ok, log, stats, conn}
    end
  end

  defp missing(log, peer_ids, nil), do: Sync.missing(log, peer_ids)
  defp missing(log, peer_ids, %Shape{} = shape), do: Sync.missing(log, peer_ids, shape)
end
