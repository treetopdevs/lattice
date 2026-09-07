defmodule Treehouse.Space do
  @moduledoc """
  Treehouse's signed Space membership and Thread references, interpreted locally.

  These domain facts do not issue another replica's capabilities or transport
  admission. The enrolling application must reconcile those separately. The
  root-only offline profile makes no bounded founder-loss or live catalog claim.
  """

  use Lattice.Replica

  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Authority.Delegation
  alias Treehouse.{Invitation, TransportCatalog}

  @preview_commands [
    :create_space,
    :create_thread,
    :issue_invitation,
    :revoke_invitation,
    :admit_member,
    :remove_member
  ]

  @doc false
  @spec known_continuity_wire_atoms() :: [atom()]
  def known_continuity_wire_atoms do
    [
      :active,
      :admission,
      :attest_member_key_v1,
      :epoch_basis,
      :new_pub,
      :nonce,
      :old_admission,
      :old_membership,
      :old_pub,
      :parents,
      :removed,
      :treehouse,
      :vouchers
    ]
  end

  state do
    field(:name, merge: :lww, default: "")
    field(:members, merge: :or_set)
    field(:threads, merge: :or_set)
    field(:invitations, merge: :causal_list)
    field(:revoked_invitations, merge: :or_set)
    field(:membership_events, merge: :causal_list)
    field(:admin_actions, authority: :admin, default: nil)
    field(:moderator_actions, authority: :moderator, default: nil)
  end

  command(:create_space, [:name],
    do: [{:name, {:write, text!(name)}}, {:admin_actions, {:write, "create_space"}}]
  )

  command(:create_thread, [:replica, :title],
    do: [
      {:threads, {:add, %{"replica" => reference!(replica), "title" => text!(title)}}},
      {:admin_actions, {:write, "create_thread"}}
    ]
  )

  command(:issue_invitation, [:recipient, :threads],
    do: [
      {:invitations, {:append, %{"recipient" => text!(recipient), "threads" => texts!(threads)}}},
      {:admin_actions, {:write, "issue_invitation"}}
    ]
  )

  command(:revoke_invitation, [:invitation_id],
    do: [
      {:revoked_invitations, {:add, text!(invitation_id)}},
      {:admin_actions, {:write, "revoke_invitation"}}
    ]
  )

  command(:admit_member, [:invitation_id, :recipient, :level, :acceptance],
    do: admission(invitation_id, recipient, level, acceptance)
  )

  command(:remove_member, [:recipient],
    do: [
      {:members, {:remove, recipient!(recipient)}},
      {:membership_events, {:append, %{"action" => "remove", "recipient" => recipient}}},
      {:admin_actions, {:write, "remove_member"}}
    ]
  )

  command(:catalog_bootstrap_v1, [:_record],
    do: [{:admin_actions, {:write, "catalog_bootstrap_v1"}}]
  )

  @doc "Prepare deterministic root-only creation; pending signed ops are not yet persisted."
  @spec prepare_creation(Identity.t(), String.t(), String.t(), Log.t() | nil) ::
          {:ok, map()} | {:error, atom()}
  def prepare_creation(identity, replica, name, retained \\ nil) do
    name = text!(name)

    replica =
      if Authority.replica_commitment(replica),
        do: replica,
        else: Authority.bind_replica(replica, identity.pub)

    delegation =
      Delegation.genesis(identity, replica, ops: @preview_commands, roles: [:admin, :moderator])

    genesis = Op.new(identity, replica, [], :authority, {:genesis, delegation, %{}})

    name_op =
      Op.new(identity, replica, [genesis.id], :command, {:create_space, [name]},
        cap: delegation.id
      )

    log = retained || Log.new(replica)

    cond do
      log.replica != replica ->
        {:error, :wrong_replica}

      not valid_retained_log?(log) ->
        {:error, :invalid_retained_log}

      Authority.root(Log.append!(Log.new(replica), genesis)) != identity.pub ->
        {:error, :wrong_root}

      different_initialization?(log, genesis, name_op) ->
        {:error, :different_initialization}

      true ->
        {:ok,
         %{
           replica: replica,
           profile: :legacy_root_only,
           status: initialization(log),
           pending: Enum.reject([genesis, name_op], &Log.has?(log, &1.id))
         }}
    end
  end

  defp valid_retained_log?(%Log{ops: ops, replica: replica}) when is_map(ops) do
    Enum.all?(ops, fn
      {id, %Op{id: id, replica: ^replica, deps: deps} = op} ->
        Op.valid?(op) and Enum.all?(deps, &Map.has_key?(ops, &1))

      _ ->
        false
    end)
  rescue
    _ -> false
  end

  defp valid_retained_log?(_), do: false

  @doc "Observe durable root/name initialization without inferring a missing policy or name."
  @spec initialization(Log.t()) :: :uninitialized | :incomplete | :ready
  def initialization(%Log{} = log) do
    analysis = Authority.analyze(__MODULE__, log)
    honored = Enum.reject(Log.topo_ops(log), &MapSet.member?(analysis.quarantine, &1.id))
    roots = for %Op{kind: :authority, body: {:genesis, _, _}, id: id} <- honored, do: id

    ready? =
      Enum.any?(honored, fn
        %Op{kind: :command, body: {:create_space, [_]}, deps: [id]} -> id in roots
        _ -> false
      end)

    cond do
      ready? -> :ready
      roots == [] -> :uninitialized
      true -> :incomplete
    end
  end

  defp different_initialization?(log, genesis, name_op) do
    Enum.any?(Log.ops(log), fn
      {id, %Op{kind: :authority, body: {:genesis, _, _}}} ->
        id != genesis.id

      {id, %Op{kind: :command, body: {:create_space, [_]}, deps: deps}} ->
        deps == [genesis.id] and id != name_op.id

      _ ->
        false
    end)
  end

  @doc "Author one ordinary moderator transfer; the authority judge decides its validity."
  @spec change_moderator(Identity.t(), Log.t(), Identity.pubkey(), Delegation.t()) ::
          {Op.t(), Delegation.t()}
  def change_moderator(identity, log, recipient, parent),
    do: transfer_role(identity, log, recipient, parent, :moderator)

  @doc "Author one ordinary admin transfer with the parent capability's existing bounds."
  @spec transfer_admin(Identity.t(), Log.t(), Identity.pubkey(), Delegation.t()) ::
          {Op.t(), Delegation.t()}
  def transfer_admin(identity, log, recipient, parent),
    do: transfer_role(identity, log, recipient, parent, :admin)

  defp transfer_role(identity, log, recipient, parent, role) do
    if not (is_binary(recipient) and byte_size(recipient) == 32),
      do: raise(ArgumentError, "recipient must be a public key")

    delegation =
      Delegation.new(identity, log.replica, recipient,
        parent_id: parent.id,
        ops: MapSet.to_list(parent.ops),
        roles: [role],
        expires_epoch: parent.expires_epoch
      )

    {Op.new(
       identity,
       log.replica,
       Log.frontier(log),
       :authority,
       {:transfer, role, delegation, 0}
     ), delegation}
  end

  @doc "Author the existing issuer-checked grant revocation operation."
  @spec revoke_grant(Identity.t(), Log.t(), String.t()) :: Op.t()
  def revoke_grant(identity, log, delegation_id),
    do:
      Op.new(
        identity,
        log.replica,
        Log.frontier(log),
        :authority,
        {:revoke, text!(delegation_id)}
      )

  @doc "Author existing witnessed role evidence; bounded continuation remains the R04/R14 gate."
  @spec witnessed_succession(Identity.t(), Log.t(), atom(), Delegation.t(), map()) :: Op.t()
  def witnessed_succession(identity, log, role, delegation, certificate)
      when role in [:admin, :moderator],
      do:
        Op.new(
          identity,
          log.replica,
          Log.frontier(log),
          :authority,
          {:succeed, role, delegation, {:witnessed, certificate}}
        )

  defp admission(invitation_id, recipient, level, acceptance) do
    Enum.each([invitation_id, recipient, level, acceptance], &text!/1)

    [
      {:members, {:add, recipient}},
      {:membership_events,
       {:append,
        %{
          "action" => "admit",
          "invitation" => invitation_id,
          "level" => level,
          "recipient" => recipient
        }}},
      {:admin_actions, {:write, "admit_member"}}
    ]
  end

  defp text!(value) when is_binary(value) do
    if String.valid?(value), do: value, else: raise(ArgumentError, "Treehouse text must be UTF-8")
  end

  defp text!(_), do: raise(ArgumentError, "Treehouse value must be text")

  defp texts!(values) when is_list(values), do: Enum.map(values, &text!/1)
  defp texts!(_), do: raise(ArgumentError, "Thread scope must be a text list")

  defp reference!(value) do
    if text!(value) == "", do: raise(ArgumentError, "Thread reference is empty"), else: value
  end

  defp recipient!(value) do
    if Invitation.recipient?(value),
      do: value,
      else: raise(ArgumentError, "recipient is not a canonical public key")
  end

  def command_op_status(%Op{body: {:catalog_bootstrap_v1, [record]}} = op, _visible, context) do
    with {:ok, record} <- TransportCatalog.normalize_bootstrap(record),
         {:ok, observed} <-
           Authority.continuation_profile(Log.from_ops(op.replica, context.visible_ops)),
         true <-
           record.space == op.replica and record.space_root == op.author and
             observed.root == op.author and observed.profile_genesis == record.profile_genesis and
             observed.profile_id == record.profile_id and observed.profile.kind == :space do
      :ok
    else
      _ -> {:error, :application_invalid_catalog}
    end
  end

  def command_op_status(%Op{body: {:issue_invitation, [recipient, threads]}}, _visible, context) do
    if Invitation.recipient?(recipient) and threads == thread_scope(context),
      do: :ok,
      else: {:error, :application_invalid_invitation}
  end

  def command_op_status(
        %Op{replica: replica, body: {:revoke_invitation, [id]}},
        visible,
        context
      ),
      do: invitation_target(id, replica, visible, context)

  def command_op_status(
        %Op{replica: replica, body: {:admit_member, [id, recipient, level, signature]}},
        visible,
        context
      ) do
    with :ok <- invitation_target(id, replica, visible, context),
         %Op{body: {:issue_invitation, [^recipient, threads]}} = invite <- context.visible_ops[id],
         true <- level in ["member", "moderator"],
         true <- threads == thread_scope(context),
         false <- revoked?(id, context),
         true <- Invitation.valid_acceptance?(replica, invite, signature) do
      :ok
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :application_invalid_invitation}
    end
  end

  def command_op_status(_op, _visible, _context), do: :ok

  defp invitation_target(id, replica, visible, context) do
    cond do
      not MapSet.member?(visible, id) ->
        {:error, :application_target_not_visible}

      Map.get(context.verdicts, id) != :honored ->
        {:error, :application_target_quarantined}

      not match?(
        %Op{replica: ^replica, kind: :command, body: {:issue_invitation, [_, _]}},
        context.visible_ops[id]
      ) ->
        {:error, :application_wrong_target}

      true ->
        :ok
    end
  end

  defp thread_scope(context) do
    for(
      {id, %Op{kind: :command, body: {:create_thread, [replica, _]}}} <- context.visible_ops,
      context.verdicts[id] == :honored,
      do: replica
    )
    |> Enum.uniq()
    |> Enum.sort()
  end

  defp revoked?(invitation_id, context) do
    Enum.any?(context.visible_ops, fn
      {id, %Op{kind: :command, body: {:revoke_invitation, [^invitation_id]}}} ->
        context.verdicts[id] == :honored

      _ ->
        false
    end)
  end
end
