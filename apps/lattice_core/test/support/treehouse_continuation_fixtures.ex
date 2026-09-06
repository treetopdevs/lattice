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
  alias Lattice.Authority.Delegation
  alias Lattice.{Authority, Canonical, Identity, Log, Sim}

  @spec new(keyword()) :: {Sim.t(), Lattice.Op.t()}
  def new(opts \\ []) do
    kind = Keyword.get(opts, :kind, :space)
    label = Keyword.get(opts, :label, "public-contract")
    nonce = digest(label)
    name = "replica:treehouse:#{kind}:#{nonce}#authority:bounded-continuation-v1"
    module = if kind == :space, do: __MODULE__.Space, else: __MODULE__.Thread

    realms = ["founder", "holder", "nominee", "copy", "w1", "w2", "w3", "observer"]
    sim = Sim.new(module, name, realms ++ Enum.map(1..12, &"member#{&1}"), seed: "r04-fixture")
    Sim.create_replica(sim, "founder")
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
end
