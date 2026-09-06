defmodule Lattice.ContinuationVectors do
  @moduledoc "Test-only signed R04 corpus exported through the existing conformance gate."
  alias Lattice.{Authority, Canonical, Log, Op, Sim}
  alias Lattice.Authority.{ContinuationCertificate, Delegation}
  alias Lattice.Carrier.Wire
  alias Treehouse.ContinuationFixtures, as: F

  @spec write(String.t()) :: :ok
  def write(out) do
    path = Path.join(out, "continuation")
    File.mkdir_p!(path)
    vectors = cases() ++ refusal_cases() ++ shape_cases() ++ Enum.map(0..12, &cycle/1)
    File.write!(Path.join(path, "authority.json"), Jason.encode!(vectors, pretty: true))
    :ok
  end

  @spec cases() :: [map()]
  def cases do
    Enum.flat_map([:space, :thread], fn kind ->
      {sim, _} = F.new(kind: kind, label: "vectors-#{kind}")
      {sim, pin, profile} = F.pin(sim)
      {sim, epoch} = Sim.beacon(sim, "founder", 0)
      sim = Sim.sync_all(sim)

      choices = [
        {"valid", []},
        {"wide", [ops: [:manage, :not_granted]]},
        {"unleased", [expires_epoch: nil]},
        {"too_long", [expires_epoch: 7]},
        {"wrong_basis", [epoch_basis: []]},
        {"subthreshold", [witnesses: ["w1"]]},
        {"bad_surplus", [witnesses: ["w1", "w2", "observer"]]},
        {"wrong_predecessor", [claim_patch: %{holder_epoch: F.digest("other")}]},
        {"wrong_deps", [claim_patch: %{deps: []}]},
        {"duplicate",
         [
           certificate_transform: fn c ->
             %{c | signatures: c.signatures ++ [hd(c.signatures)]}
           end
         ]},
        {"malformed", [certificate_transform: fn c -> Map.put(c, :extra, true) end]}
      ]

      vectors =
        Enum.map(choices, fn {name, opts} ->
          {branch, acquisition} =
            F.continue(
              sim,
              "nominee",
              pin,
              profile,
              Keyword.merge([epoch_basis: [epoch.id]], opts)
            )

          {:succeed, _, delegation, _} = acquisition.body
          branch = Sim.sync_all(branch)

          {branch, _post} =
            Sim.command(branch, "nominee", :post, ["#{kind}:#{name}"], cap: delegation.id)

          vector("#{kind}:#{name}", branch, "nominee")
        end)

      {left, first} =
        F.continue(sim, "nominee", pin, profile, epoch_basis: [epoch.id], ops: [:manage])

      {right, second} =
        F.continue(sim, "nominee", pin, profile, epoch_basis: [epoch.id], ops: [:manage, :post])

      merged = Map.merge(Log.ops(Sim.log(left, "nominee")), Log.ops(Sim.log(right, "nominee")))
      race = %{sim | logs: Map.put(sim.logs, "nominee", Log.from_ops(sim.replica, merged))}
      race_vector = vector("#{kind}:same-predecessor-race", race, "nominee")
      true = MapSet.size(MapSet.new([first.id, second.id])) == 2
      {:succeed, role, d, {:continuation_v1, cert}} = first.body

      shape_vectors =
        Enum.map(
          [
            {"outer-arity", Tuple.insert_at(first.body, 4, :extra)},
            {"proof-arity", {:succeed, role, d, {:continuation_v1, cert, :extra}}},
            {"unknown-role", {:succeed, :undeclared, d, {:continuation_v1, cert}}},
            {"malformed-delegation", {:succeed, role, %{}, {:continuation_v1, %{}}}}
          ],
          fn {name, body} ->
            {branch, _} = Sim.append(sim, "nominee", :authority, body)
            vector("#{kind}:#{name}", branch, "nominee")
          end
        )

      vectors ++ [race_vector] ++ shape_vectors
    end)
  end

  defp refusal_cases do
    unsupported =
      Enum.map(
        [
          "replica:treehouse:space:bad-nonce#authority:bounded-continuation-v1",
          "replica:treehouse:space:bad\nnonce#authority:bounded-continuation-v1",
          "replica:treehouse:space:bad\u2028nonce#authority:bounded-continuation-v1",
          "replica:treehouse:space:#{F.digest("unknown-version")}#authority:bounded-continuation-v2"
        ],
        fn name ->
          {sim, _} = F.new(name: name)
          {sim, _} = Sim.command(sim, "founder", :post, ["unsupported family"])

          {sim, _} =
            Sim.append(
              sim,
              "founder",
              :authority,
              {:succeed, :admin, %{}, {:continuation_v1, %{}}}
            )

          vector(name, sim, "founder")
        end
      )

    {sim, _} = F.new(name: "replica:legacy:literal#authority:bounded-continuation-v1")
    {sim, pin, profile} = F.pin(sim)
    {sim, epoch} = Sim.beacon(sim, "founder", 0)

    {sim, candidate} =
      F.continue(Sim.sync_all(sim), "nominee", pin, profile, epoch_basis: [epoch.id])

    {:succeed, role, d, {:continuation_v1, cert}} = candidate.body

    {malformed, _} =
      Sim.append(
        sim,
        "nominee",
        :authority,
        {:succeed, role, d, {:continuation_v1, cert, :extra}}
      )

    {malformed_delegation, _} =
      Sim.append(sim, "nominee", :authority, {:succeed, :admin, %{}, {:continuation_v1, %{}}})

    unsupported ++
      [
        vector("legacy:literal-authority-is-not-versioned", sim, "nominee"),
        vector("legacy:malformed-new-proof-is-not-legacy", malformed, "nominee"),
        vector("legacy:malformed-delegation-new-proof", malformed_delegation, "nominee")
      ]
  end

  defp cycle(index) do
    kind = if index == 0, do: :space, else: :thread
    fixture = F.two_cycles(kind: kind, label: "vector-cycle-#{index}")
    sim = fixture.sim

    sim =
      Enum.reduce(Enum.with_index(fixture.generations), sim, fn {grants, generation}, s ->
        Enum.reduce(Enum.with_index(grants, 1), s, fn {d, member}, acc ->
          {acc, _} =
            Sim.command(
              acc,
              "member#{member}",
              :post,
              ["generation #{generation} member #{member}"],
              cap: d.id
            )

          acc
        end)
      end)
      |> Sim.sync_all()

    vector("#{kind}:two-cycles:#{index}", sim, "holder")
  end

  defp shape_cases do
    {sim, genesis} = F.new(label: "closed-authority-shapes")
    {sim, epoch} = Sim.beacon(sim, "founder", 0)
    root = Sim.identity(sim, "founder")
    empty = Delegation.genesis(root, sim.replica, ops: [], roles: [], live: false)
    profile = F.profile(sim)

    {bad_pin, pin} =
      Sim.append(
        sim,
        "founder",
        :authority,
        {:genesis, empty, %{__continuation__: profile}, :extra}
      )

    {bad_pin, attempt} =
      F.continue(Sim.sync_all(bad_pin), "nominee", pin, profile, epoch_basis: [epoch.id])

    {true, :continuation_not_configured} = Sim.quarantined(bad_pin, "nominee", attempt.id)

    {sim, pin, profile} = F.pin(sim)
    {:genesis, original, _} = genesis.body
    holder = Sim.identity(sim, "holder")

    d =
      Delegation.new(root, sim.replica, holder.pub,
        parent_id: original.id,
        ops: [:manage, :post],
        roles: [:admin],
        expires_epoch: 6
      )

    {bad_transfer, transfer} =
      Sim.append(sim, "founder", :authority, {:transfer, :admin, d, 0, :extra})

    {bad_transfer, attempt} =
      F.continue(Sim.sync_all(bad_transfer), "holder", pin, profile,
        epoch_basis: [epoch.id],
        claim_patch: %{holder: holder.pub, holder_epoch: transfer.id}
      )

    {true, :unauthorized_continuation} = Sim.quarantined(bad_transfer, "holder", attempt.id)

    {bad_grant, _} = Sim.append(sim, "founder", :authority, {:grant, d, :extra})

    {bad_grant, _} =
      Sim.command(Sim.sync_all(bad_grant), "holder", :post, ["extra grant"], cap: d.id)

    {bad_revoke, _} = Sim.append(sim, "founder", :authority, {:revoke, original.id, :extra})

    {bad_revoke, _} =
      Sim.command(bad_revoke, "founder", :post, ["extra revoke is inert"], cap: original.id)

    [
      vector("space:extra-genesis-is-not-pin", bad_pin, "nominee"),
      vector("space:extra-transfer-is-not-predecessor", bad_transfer, "holder"),
      vector("space:extra-grant-is-not-capability", bad_grant, "holder"),
      vector("space:extra-revoke-is-inert", bad_revoke, "founder")
    ]
  end

  defp vector(name, sim, realm) do
    log = Sim.log(sim, realm)
    ops = Log.topo_ops(log)
    analysis = Authority.analyze(sim.module, log)
    role = F.role(sim)

    realm_by_key =
      Map.new(sim.realms, fn {name, identity} -> {Base.encode64(identity.pub), name} end)

    # Founder is absent from runtime custody in the lifecycle fixtures; an
    # identity label is display metadata and does not restore its private key.
    realm_by_key = Map.put(realm_by_key, Base.encode64(hd(ops).author), "founder")

    certificates =
      for %Op{body: {:succeed, _, _, {:continuation_v1, c}}} = op <- ops,
          ContinuationCertificate.valid_shape?(c),
          do: %{
            opId: op.id,
            claimBytes: Base.encode64(ContinuationCertificate.signing_payload(c.claim))
          }

    profiles =
      for %Op{body: {:genesis, _, %{__continuation__: p}}} = op <- ops,
          {:ok, profile} <- [ContinuationCertificate.normalize_policy(p)],
          {:ok, id} <- [ContinuationCertificate.profile_id(profile)],
          do: %{
            opId: op.id,
            profileId: id,
            bytes: Base.encode64(Canonical.term(["lattice-continuation-profile-v1", profile]))
          }

    %{
      name: name,
      replica: sim.replica,
      role: role,
      schema: %{
        name: "R04.#{role}",
        fields: %{role => %{authority: role}, posts: %{merge: :causal_list}}
      },
      realmByPubkey: realm_by_key,
      frames: Enum.map(ops, &Wire.encode_op/1),
      canonical: Enum.map(ops, &%{id: &1.id, bytes: Base.encode64(Op.canonical_encoding(&1))}),
      reasons: analysis.reasons,
      holderEpoch: analysis.holder_epochs[role] && analysis.holder_epochs[role].op_id,
      posts: Lattice.state(sim.module, log).posts,
      profiles: profiles,
      certificates: certificates
    }
  end
end
