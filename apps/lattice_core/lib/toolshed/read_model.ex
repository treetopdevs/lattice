defmodule Toolshed.ReadModel do
  @moduledoc """
  Structured projection of one tool log for the Toolshed surfaces (PD-003).

  Everything a shed UI shows is computed from op presence in the DAG — custody
  is never stored or asserted. `available?` means the tool is home (no holder
  on record, or the holder IS the current validated `:custody` role holder);
  the active loan is derived from the latest honored leased grant to the
  current holder, with `overdue?` decided by the plan-149 lease machinery
  (`Lattice.Authority.expired?/2`) against the log's own beacons; and the
  request list is the Q-06 dispute surface — a request is `resolved?` exactly
  when an honored `:custody_transfer` cites its id, so an unresolved or
  refused request stays visible and timestamped with no extra bookkeeping.
  """

  alias Lattice.{Authority, Identity, Log, Op}
  alias Toolshed.Tool

  @type request :: %{
          op: String.t(),
          author_fingerprint: String.t(),
          ref: String.t(),
          payload: term(),
          resolved?: boolean()
        }

  @type loan :: %{
          borrower_fingerprint: String.t(),
          due_epoch: non_neg_integer() | nil,
          overdue?: boolean()
        }

  @type t :: %{
          listing: %{description: String.t(), condition_notes: [String.t()]},
          custody: %{
            holder: Identity.pubkey() | nil,
            holder_fingerprint: String.t() | nil,
            available?: boolean()
          },
          loan: loan() | nil,
          requests: [request()],
          evidence: %{quarantine: [String.t()], reasons: %{String.t() => atom()}}
        }

  @doc "Derive the current Toolshed instrument inputs from one tool log."
  @spec observe(Log.t()) :: t()
  def observe(%Log{} = log) do
    state = Lattice.state(Tool, log)
    analysis = Authority.analyze(Tool, log)
    holder = state.holder
    home = Map.get(analysis.holders, :custody)
    available? = holder == nil or holder == home

    %{
      listing: %{description: state.description, condition_notes: state.condition_notes},
      custody: %{
        holder: holder,
        holder_fingerprint: holder && Identity.fingerprint(holder),
        available?: available?
      },
      loan: if(available?, do: nil, else: loan(log, analysis, holder)),
      requests: requests(log, analysis),
      evidence: %{
        quarantine: analysis.quarantine |> MapSet.to_list() |> Enum.sort(),
        reasons: analysis.reasons
      }
    }
  end

  # The active loan: the latest honored leased grant to the current holder is
  # the borrow Cap; its `expires_epoch` is the due-back caveat.
  defp loan(log, analysis, borrower) do
    borrow_cap =
      log
      |> Log.topo_ops()
      |> Enum.reduce(nil, fn
        %Op{id: id, kind: :authority, body: {:grant, delegation}}, acc ->
          if delegation.audience == borrower and delegation.expires_epoch != nil and
               not MapSet.member?(analysis.quarantine, id),
             do: delegation,
             else: acc

        _op, acc ->
          acc
      end)

    %{
      borrower_fingerprint: Identity.fingerprint(borrower),
      due_epoch: borrow_cap && borrow_cap.expires_epoch,
      overdue?: borrow_cap != nil and Authority.expired?(log, borrow_cap.id)
    }
  end

  defp requests(log, analysis) do
    resolved =
      log
      |> Log.topo_ops()
      |> Enum.reduce(MapSet.new(), fn
        %Op{id: id, kind: :command, body: {:custody_transfer, [_to, request_op_id, _sig]}}, acc ->
          if MapSet.member?(analysis.quarantine, id),
            do: acc,
            else: MapSet.put(acc, request_op_id)

        _op, acc ->
          acc
      end)

    Enum.map(analysis.requests, fn r ->
      %{
        op: r.op,
        author_fingerprint: Identity.fingerprint(r.author),
        ref: r.ref,
        payload: r.payload,
        resolved?: MapSet.member?(resolved, r.op)
      }
    end)
  end
end
