defmodule Treehouse.ContinuationFixtures.Space do
  @moduledoc "Test-only R04 capability/authority schema; not the R10 Space product."
  use Lattice.Replica

  state do
    field(:admin, authority: :admin, default: "")
    field(:posts, merge: :causal_list)
    field(:members, merge: :or_set)
  end

  command(:manage, [:value], do: [{:admin, {:write, value}}])
  command(:post, [:text], do: [{:posts, {:append, text}}])
  command(:admit, [:member], do: [{:members, {:add, member}}])
  command(:remove_member, [:member], do: [{:members, {:remove, member}}])
end

defmodule Treehouse.ContinuationFixtures.Thread do
  @moduledoc "Test-only R04 moderator schema; no R10 application-policy claims."
  use Lattice.Replica

  state do
    field(:moderator, authority: :moderator, default: "")
    field(:posts, merge: :causal_list)
  end

  command(:manage, [:value], do: [{:moderator, {:write, value}}])
  command(:post, [:text], do: [{:posts, {:append, text}}])
end

defmodule Treehouse.ContinuationFixtures do
  @moduledoc "Signed public-Sim fixtures with independently assembled R04 claims."
  alias Lattice.{Authority, Canonical, Identity, Log, Sim}
  alias Lattice.Authority.Delegation

  @spec new(keyword()) :: {Sim.t(), Lattice.Op.t()}
  def new(opts \\ []) do
    kind = Keyword.get(opts, :kind, :space)
    label = Keyword.get(opts, :label, "public-contract")
    nonce = digest(label)
    name = "replica:treehouse:#{kind}:#{nonce}#authority:bounded-continuation-v1"
    module = if kind == :space, do: __MODULE__.Space, else: __MODULE__.Thread

    realms = ["founder", "holder", "nominee", "copy", "w1", "w2", "w3", "observer"]

    sim =
      Sim.new(module, Keyword.get(opts, :name, name), realms ++ Enum.map(1..12, &"member#{&1}"),
        seed: "r04-fixture"
      )

    Sim.create_replica(sim, Keyword.get(opts, :creator, "founder"))
  end

  @spec profile(Sim.t(), keyword()) :: map()
  def profile(sim, opts \\ []) do
    kind = if sim.module == __MODULE__.Space, do: :space, else: :thread

    %{
      mode: :bounded_continuation,
      version: 1,
      product: :treehouse,
      kind: kind,
      role: role(sim),
      nominee: Sim.identity(sim, Keyword.get(opts, :nominee, "nominee")).pub,
      witnesses: Enum.sort(Enum.map(["w1", "w2", "w3"], &Sim.identity(sim, &1).pub)),
      threshold: Keyword.get(opts, :threshold, 2),
      max_lease_epochs: Keyword.get(opts, :max_lease_epochs, 7)
    }
  end

  @spec pin(Sim.t(), keyword()) :: {Sim.t(), Lattice.Op.t(), map()}
  def pin(sim, opts \\ []) do
    policy = Keyword.get_lazy(opts, :profile, fn -> profile(sim, opts) end)
    root = Sim.identity(sim, Keyword.get(opts, :author, "founder"))
    d = Delegation.genesis(root, sim.replica, ops: [], roles: [], live: false)

    beacon = %{
      mode: :witnessed,
      version: 1,
      witnesses: profile(sim).witnesses,
      threshold: 2,
      max_epoch_step: 1
    }

    {sim, op} =
      Sim.append(
        sim,
        root.realm_id,
        :authority,
        {:genesis, d, %{__continuation__: policy, __beacon__: beacon}}
      )

    {Sim.sync_all(sim), op, policy}
  end

  @spec role(Sim.t()) :: :admin | :moderator
  def role(sim), do: if(sim.module == __MODULE__.Space, do: :admin, else: :moderator)

  @spec continue(Sim.t(), String.t(), Lattice.Op.t(), map(), keyword()) ::
          {Sim.t(), Lattice.Op.t()}
  def continue(sim, realm, pin, profile, opts \\ []) do
    identity = Sim.identity(sim, realm)
    log = Sim.log(sim, realm)

    predecessor =
      Keyword.get_lazy(opts, :predecessor, fn ->
        Authority.holder_epoch(sim.module, log, role(sim))
      end)

    d =
      Delegation.new(identity, sim.replica, Keyword.get(opts, :audience, identity.pub),
        ops: Keyword.get(opts, :ops, [:manage, :post]),
        roles: Keyword.get(opts, :roles, [role(sim)]),
        live: Keyword.get(opts, :live, false),
        parent_id: Keyword.get(opts, :parent_id),
        expires_epoch: Keyword.get(opts, :expires_epoch, 6)
      )

    claim = %{
      version: 1,
      product: :treehouse,
      kind: profile.kind,
      replica: sim.replica,
      role: role(sim),
      profile_id: digest(Canonical.term(["lattice-continuation-profile-v1", profile])),
      profile_genesis: pin.id,
      holder: predecessor.holder,
      holder_epoch: predecessor.op_id,
      successor: d.audience,
      delegation_id: d.id,
      author: identity.pub,
      deps: Enum.sort(Log.frontier(log)),
      epoch: Keyword.get(opts, :epoch, 0),
      epoch_basis: Keyword.fetch!(opts, :epoch_basis) |> Enum.sort()
    }

    claim = Map.merge(claim, Keyword.get(opts, :claim_patch, %{}))
    payload = Canonical.term(["lattice-continuation-witness-v1", claim])

    signatures =
      Keyword.get(opts, :witnesses, ["w1", "w2"])
      |> Enum.map(fn realm ->
        witness = Sim.identity(sim, realm)
        %{witness: witness.pub, signature: Identity.sign(witness, payload)}
      end)
      |> Enum.sort_by(& &1.witness)

    certificate = %{claim: claim, signatures: signatures}
    certificate = Keyword.get(opts, :certificate_transform, &Function.identity/1).(certificate)
    Sim.append(sim, realm, :authority, {:succeed, role(sim), d, {:continuation_v1, certificate}})
  end

  @spec digest(binary()) :: String.t()
  def digest(bytes), do: :crypto.hash(:sha256, bytes) |> Base.url_encode64(padding: false)

  @doc "Candidate seven-epoch schedule on signed logical ticks, with the founder removed before E1."
  @spec two_cycles(keyword()) :: map()
  def two_cycles(opts \\ []) do
    {sim, genesis} = new(opts)
    # Enrollment is signed retained input. Product acceptance and protected-key
    # eligibility remain R10/R14/R17 responsibilities, not a Core roster claim.
    sim =
      Enum.reduce(1..12, sim, fn n, s ->
        {s, _} =
          Sim.append(s, "member#{n}", :inbox, {:enrollment, identity_public(s, "member#{n}")})

        s
      end)
      |> Sim.sync_all()

    {sim, pin, profile} = pin(sim)
    {sim, epoch0} = Sim.beacon(sim, "founder", 0)

    commands =
      if role(sim) == :admin, do: [:manage, :post, :admit, :remove_member], else: [:manage, :post]

    {sim, transfer} =
      Sim.transfer(sim, "founder", "holder", role(sim), ops: commands, expires_epoch: 6)

    sim = Sim.sync_all(sim)
    {sim, generation0} = member_grants(sim, 6)
    sim = Sim.sync_all(sim)
    bootstrap_ids = Log.op_ids(Sim.log(sim, "holder"))
    # Sim has no external signer callbacks. Assert its exact field inventory
    # in the public test, then remove every per-founder record here.
    sim = %{
      sim
      | realms: Map.delete(sim.realms, "founder"),
        logs: Map.delete(sim.logs, "founder"),
        caps: Map.delete(sim.caps, "founder")
    }

    {sim, generations, acquisitions} =
      Enum.reduce(1..14, {sim, [generation0], []}, fn epoch, {s, generations, acquisitions} ->
        {s, _} = Sim.beacon(s, "w1", epoch, witnesses: ["w1", "w2"])
        s = Sim.sync_all(s)

        if epoch in [5, 10] do
          {s, acquisition} =
            Sim.continue_role(s, "holder", role(s),
              ops: commands,
              expires_epoch: epoch + 6,
              witnesses: ["w1", "w2"]
            )

          s = Sim.sync_all(s)
          {s, grants} = member_grants(s, epoch + 6)
          {Sim.sync_all(s), generations ++ [grants], acquisitions ++ [acquisition]}
        else
          {s, generations, acquisitions}
        end
      end)

    %{
      sim: sim,
      genesis: genesis,
      pin: pin,
      profile: profile,
      epoch0: epoch0,
      transfer: transfer,
      generations: generations,
      acquisitions: acquisitions,
      bootstrap_ids: bootstrap_ids
    }
  end

  defp identity_public(sim, realm), do: Sim.identity(sim, realm).pub

  defp member_grants(sim, expires) do
    Enum.map_reduce(1..12, sim, fn n, s ->
      {s, d} = Sim.grant(s, "holder", "member#{n}", ops: [:post], expires_epoch: expires)
      {d, s}
    end)
    |> then(fn {grants, s} -> {s, grants} end)
  end
end
