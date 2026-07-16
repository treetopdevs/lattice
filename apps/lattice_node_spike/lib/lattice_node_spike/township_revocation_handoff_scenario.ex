defmodule LatticeNodeSpike.TownshipRevocationHandoffScenario do
  @moduledoc """
  Deterministic Sim oracle for the versioned revocation handoff.

  The recipient uses a clerk-issued post capability before revocation, explicitly
  pulls the clerk's revoke, and then cites the retained capability in a causally
  later post that authority quarantines without changing Township matter state.
  """

  alias Lattice.Authority.Delegation
  alias Lattice.{Log, Sim}
  alias LatticeNodeSpike.TownshipOnboardingScenario
  alias Township.ReadModel

  @issuer "clerk"
  @recipient "revocation-recipient"
  @realms [@issuer, "resident", @recipient]
  @pre_revoke_text "revocation recipient post before revoke"
  @revoked_text "revocation recipient post after revoke"

  @type projection :: %{
          op_ids: [String.t()],
          read_model: map(),
          causal_replay: map()
        }

  @spec oracle() :: map()
  def oracle do
    base_sim = TownshipOnboardingScenario.base_sim(@realms)

    {grant_sim, delegation} = Sim.grant(base_sim, @issuer, @recipient, ops: [:post])
    grant_sim = Sim.sync_all(grant_sim)
    grant_log = Sim.log(grant_sim, @issuer)
    grant_op = grant_op!(grant_log, delegation.id)

    {pre_revoke_sim, pre_revoke_op} =
      Sim.command(grant_sim, @recipient, :post, [@pre_revoke_text])

    pre_revoke_sim = Sim.sync_all(pre_revoke_sim)
    pre_revoke_log = Sim.log(pre_revoke_sim, @issuer)

    {revoke_sim, revoke_op} = Sim.revoke(pre_revoke_sim, @issuer, delegation.id)
    revoke_log = Sim.log(revoke_sim, @issuer)
    recipient_log_before_pull = Sim.log(revoke_sim, @recipient)

    recipient_pull_sim = Sim.sync(revoke_sim, @issuer, @recipient)
    recipient_pull_log = Sim.log(recipient_pull_sim, @recipient)

    {revoked_use_sim, revoked_use_op} =
      Sim.command(recipient_pull_sim, @recipient, :post, [@revoked_text], cap: delegation.id)

    final_sim = Sim.sync_all(revoked_use_sim)
    final_log = Sim.log(final_sim, @issuer)

    %{
      replica: Sim.replica(base_sim),
      issuer: endpoint(base_sim, @issuer),
      recipient: endpoint(base_sim, @recipient),
      grant: %{
        delegation: delegation,
        op: grant_op,
        log: grant_log,
        projection: projection(grant_log)
      },
      pre_revoke_use: %{
        text: @pre_revoke_text,
        op: pre_revoke_op,
        log: pre_revoke_log,
        projection: projection(pre_revoke_log)
      },
      revoke: %{
        op: revoke_op,
        log: revoke_log,
        recipient_log_before_pull: recipient_log_before_pull,
        projection: projection(revoke_log)
      },
      recipient_pull: %{
        log: recipient_pull_log,
        projection: projection(recipient_pull_log)
      },
      revoked_use: %{text: @revoked_text, op: revoked_use_op},
      final: %{
        log: final_log,
        projection: projection(final_log)
      }
    }
  end

  @spec projection(Log.t()) :: projection()
  def projection(%Log{} = log) do
    %{
      op_ids: log |> Log.op_ids() |> Enum.sort(),
      read_model: ReadModel.observe(log),
      causal_replay: ReadModel.replay(log)
    }
  end

  defp endpoint(sim, realm) do
    %{realm: realm, identity: Sim.identity(sim, realm)}
  end

  defp grant_op!(log, delegation_id) do
    Enum.find(Log.topo_ops(log), fn
      %{kind: :authority, body: {:grant, %Delegation{id: ^delegation_id}}} -> true
      _op -> false
    end) || raise "revocation handoff scenario missing grant op #{delegation_id}"
  end
end
