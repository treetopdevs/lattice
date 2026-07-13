defmodule LatticeNodeSpike.TownshipGrantHandoffScenario do
  @moduledoc """
  Deterministic Sim oracle for the versioned delegation-grant handoff.

  The base is byte-identical to the existing onboarding prefix while two idle
  realms supply distinct recipient identities. Sim then derives the sound grant,
  its recipient post, a non-attenuating child grant, and the refused use of that
  rejected capability.
  """

  alias Lattice.Authority.Delegation
  alias Lattice.{Log, Sim}
  alias LatticeNodeSpike.TownshipOnboardingScenario
  alias Township.{Matter, ReadModel}

  @issuer "clerk"
  @recipient "grant-recipient"
  @unsound_audience "unsound-audience"
  @realms ["clerk", "resident", @recipient, @unsound_audience]
  @resident_ops [:admit, :post, :set_summary, :set_title]
  @recipient_post "grant recipient post"

  @type projection :: %{
          op_ids: [String.t()],
          read_model: map(),
          causal_replay: map()
        }

  @spec oracle() :: map()
  def oracle do
    base_sim = base_sim()
    base_log = Sim.log(base_sim, @issuer)

    {grant_sim, sound_delegation} =
      Sim.grant(base_sim, @issuer, @recipient, ops: @resident_ops)

    grant_sim = Sim.sync_all(grant_sim)
    sound_grant_log = Sim.log(grant_sim, @issuer)
    sound_grant_op = grant_op!(sound_grant_log, sound_delegation.id)

    {recipient_use_sim, recipient_use_op} =
      Sim.command(grant_sim, @recipient, :post, [@recipient_post])

    recipient_use_sim = Sim.sync_all(recipient_use_sim)
    recipient_use_log = Sim.log(recipient_use_sim, @issuer)

    recipient_identity = Sim.identity(recipient_use_sim, @recipient)
    unsound_audience_identity = Sim.identity(recipient_use_sim, @unsound_audience)

    unsound_delegation =
      Delegation.new(
        recipient_identity,
        Sim.replica(recipient_use_sim),
        unsound_audience_identity.pub,
        ops: [:close_matter],
        roles: [:clerk],
        live: false,
        parent_id: sound_delegation.id
      )

    {unsound_grant_sim, unsound_grant_op} =
      Sim.append(
        recipient_use_sim,
        @recipient,
        :authority,
        {:grant, unsound_delegation}
      )

    unsound_grant_sim = Sim.sync_all(unsound_grant_sim)
    unsound_grant_log = Sim.log(unsound_grant_sim, @issuer)
    {:ok, unsound_use_body} = Matter.command_body(:close_matter, [])

    {final_sim, unsound_use_op} =
      Sim.append(
        unsound_grant_sim,
        @unsound_audience,
        :command,
        unsound_use_body,
        cap: unsound_delegation.id
      )

    final_sim = Sim.sync_all(final_sim)
    final_log = Sim.log(final_sim, @issuer)

    %{
      replica: Sim.replica(base_sim),
      issuer: endpoint(base_sim, @issuer),
      recipient: endpoint(base_sim, @recipient),
      unsound_audience: endpoint(base_sim, @unsound_audience),
      base: stage(base_log),
      sound_grant: %{
        delegation: sound_delegation,
        op: sound_grant_op,
        log: sound_grant_log,
        projection: projection(sound_grant_log)
      },
      recipient_use: %{
        text: @recipient_post,
        op: recipient_use_op,
        log: recipient_use_log,
        projection: projection(recipient_use_log)
      },
      unsound_grant: %{
        delegation: unsound_delegation,
        op: unsound_grant_op,
        log: unsound_grant_log,
        projection: projection(unsound_grant_log)
      },
      unsound_use: %{op: unsound_use_op},
      final: stage(final_log)
    }
  end

  @spec base_sim() :: Sim.t()
  def base_sim, do: TownshipOnboardingScenario.base_sim(@realms)

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

  defp stage(log) do
    %{log: log, projection: projection(log)}
  end

  defp grant_op!(log, delegation_id) do
    Enum.find(Log.topo_ops(log), fn
      %{kind: :authority, body: {:grant, %Delegation{id: ^delegation_id}}} -> true
      _op -> false
    end) || raise "grant handoff scenario missing grant op #{delegation_id}"
  end
end
