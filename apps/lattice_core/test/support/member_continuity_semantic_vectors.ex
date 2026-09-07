defmodule Treehouse.MemberContinuitySemanticVectors do
  @moduledoc "Independently BEAM-authored public continuity histories for reciprocal verification."
  alias Lattice.{Authority, Canonical, Identity, Log, Op, Sim}
  alias Lattice.Carrier.Wire
  alias Treehouse.{Invitation, MemberContinuity, Space}
  alias Treehouse.MemberContinuityCertificate, as: Certificate
  alias Treehouse.MemberContinuitySemanticFixture, as: Fixture

  def corpus do
    {sim, original} = Fixture.founded()
    base = Sim.log(sim, "root")
    cap = cap(base)

    request = %{
      old_pub: original.old_pub,
      old_admission: original.old_admission,
      new_pub: original.new_pub,
      old_membership: :active,
      nonce: original.nonce,
      voucher_admissions: Enum.map(original.vouchers, & &1.admission),
      author: Sim.identity(sim, "root").pub,
      cap_id: cap
    }

    {:ok, reviewed} = MemberContinuity.review(base, request)
    cert = certificate(sim, reviewed.claim)
    {:ok, assembled} = MemberContinuity.assemble(base, reviewed, cert, Sim.identity(sim, "root"))
    valid = assembled.op
    wrong_cap = signed(sim, original, digest("missing-cap"))

    bad_cert =
      Op.new(
        Sim.identity(sim, "root"),
        sim.replica,
        original.deps,
        :command,
        {:attest_member_key_v1, [original, <<0::512>>, cert.vouches]},
        cap: cap
      )

    missing = signed(sim, %{original | old_admission: digest("missing-admission")}, cap)
    stale = signed(sim, %{original | deps: [valid.id], nonce: <<11::256>>}, cap)

    remove =
      Op.new(
        Sim.identity(sim, "root"),
        sim.replica,
        original.deps,
        :command,
        {:remove_member, [Base.encode64(hd(original.vouchers).member)]},
        cap: cap
      )

    removed = signed(sim, %{original | deps: [remove.id]}, cap)
    fork_claim = %{original | nonce: <<12::256>>}
    fork = signed(sim, fork_claim, cap)

    resolution_claim = %{
      original
      | nonce: <<13::256>>,
        deps: Enum.sort([valid.id, fork.id]),
        parents: Enum.sort([Certificate.claim_id(original), Certificate.claim_id(fork_claim)])
    }

    resolution = signed(sim, resolution_claim, cap)

    malformed =
      Op.new(
        Sim.identity(sim, "root"),
        sim.replica,
        original.deps,
        :command,
        {:attest_member_key_v1, [original, <<>>, cert.vouches]},
        cap: cap
      )

    mixed_resolution =
      signed(
        sim,
        %{
          original
          | nonce: <<14::256>>,
            deps: Enum.sort([valid.id, malformed.id]),
            parents: [Certificate.claim_id(original)]
        },
        cap
      )

    cases =
      [
        {"review_assembled", [valid]},
        {"wrong_capability", [wrong_cap]},
        {"bad_certificate", [bad_cert]},
        {"missing_admission", [missing]},
        {"stale_parent_context", [valid, stale]},
        {"causal_removed_voucher", [remove, removed]},
        {"concurrent_removed_voucher", [valid, remove]},
        {"same_old_fork", [valid, fork]},
        {"all_head_resolution", [valid, fork, resolution]},
        {"mixed_parent_wrappers", [valid, malformed, mixed_resolution]}
      ]
      |> Enum.map(fn {name, ops} -> vector_case(name, append(base, ops), original.old_pub) end)

    root = Sim.identity(sim, "root")

    {root_sim, invite} =
      Sim.command(sim, "root", :issue_invitation, [Base.encode64(root.pub), []])

    {root_sim, admission} =
      Sim.command(root_sim, "root", :admit_member, [
        invite.id,
        Base.encode64(root.pub),
        "member",
        Invitation.accept(root, sim.replica, invite)
      ])

    extended = Sim.log(root_sim, "root")
    parent_claim = %{original | deps: Log.frontier(extended)}
    parent = signed(sim, parent_claim, cap)
    competing = signed(sim, %{parent_claim | old_pub: root.pub, old_admission: admission.id}, cap)

    removal =
      Op.new(
        root,
        sim.replica,
        parent_claim.deps,
        :command,
        {:remove_member, [Base.encode64(hd(original.vouchers).member)]},
        cap: cap
      )

    dependent_claim = %{
      parent_claim
      | deps: [parent.id],
        nonce: <<15::256>>,
        parents: [Certificate.claim_id(parent_claim)],
        vouchers:
          Enum.sort_by(
            [
              %{member: root.pub, admission: admission.id},
              Enum.at(original.vouchers, 1)
            ],
            & &1.member
          )
    }

    dependent = signed(sim, dependent_claim, cap)

    cases =
      cases ++
        [
          vector_case(
            "cross_old_target_collision",
            append(extended, [parent, competing]),
            original.old_pub
          ),
          vector_case(
            "future_parent_invalidation",
            append(extended, [parent, dependent, removal]),
            original.old_pub
          )
        ]

    {:ok, claim_term} = Certificate.claim_to_wire(reviewed.claim)
    {:ok, certificate_term} = Certificate.certificate_to_wire(cert)

    %{
      version: 1,
      producer: "beam",
      cases: cases,
      authoring: %{
        replica: sim.replica,
        frames: Wire.encode_ops(Log.topo_ops(base)),
        request: public_request(request),
        claim_term: claim_term,
        certificate_term: certificate_term,
        claim_id: reviewed.claim_id,
        claim_bytes: Base.encode64(reviewed.claim_bytes),
        possession_bytes: Base.encode64(reviewed.possession_bytes),
        frame: assembled.frame,
        frame_bytes: Base.encode64(Op.canonical_encoding(valid))
      }
    }
  end

  def vector_case(name, log, old_pub) do
    %{
      name: name,
      replica: log.replica,
      old_pub: Base.encode64(old_pub),
      frames: Wire.encode_ops(Log.topo_ops(log)),
      expected: summary(log)
    }
  end

  def summary(log) do
    {:ok, observed} = MemberContinuity.observe(log)

    %{
      frontier: observed.verified_frontier,
      records:
        Enum.map(observed.records, fn record ->
          %{
            claim_id: record.claim_id,
            claim_bytes: Base.encode64(Certificate.claim_bytes(record.claim)),
            wrappers:
              Enum.map(record.wrappers, fn wrapper ->
                %{
                  op_id: wrapper.op_id,
                  author: Base.encode64(wrapper.author),
                  cap_id: wrapper.cap_id,
                  certificate_bytes: Base.encode64(Canonical.term(wrapper.certificate))
                }
              end)
          }
        end),
      links:
        Enum.map(observed.links, fn link ->
          %{
            old_pub: Base.encode64(link.old_pub),
            heads: link.heads,
            status: Atom.to_string(link.status),
            affected_wrappers: link.affected_wrappers
          }
        end),
      quarantine: observed.quarantine,
      state: Lattice.state(Space, log),
      holders:
        Map.new(Authority.analyze(Space, log).holders, fn {role, key} ->
          {role, Base.encode64(key)}
        end)
    }
  end

  def public_request(request) do
    %{
      old_pub: Base.encode64(request.old_pub),
      old_admission: request.old_admission,
      new_pub: Base.encode64(request.new_pub),
      old_membership: Atom.to_string(request.old_membership),
      nonce: Base.encode64(request.nonce),
      voucher_admissions: request.voucher_admissions,
      author: Base.encode64(request.author),
      cap_id: request.cap_id
    }
  end

  def request_from_json(request) do
    %{
      old_pub: Base.decode64!(request["old_pub"]),
      old_admission: request["old_admission"],
      new_pub: Base.decode64!(request["new_pub"]),
      old_membership: if(request["old_membership"] == "active", do: :active, else: :removed),
      nonce: Base.decode64!(request["nonce"]),
      voucher_admissions: request["voucher_admissions"],
      author: Base.decode64!(request["author"]),
      cap_id: request["cap_id"]
    }
  end

  def export!(path) do
    File.mkdir_p!(Path.dirname(path))

    File.write!(
      path,
      Jason.encode!(stable(corpus() |> Jason.encode!() |> Jason.decode!()), pretty: true) <> "\n"
    )
  end

  defp stable(value) when is_map(value),
    do:
      Jason.OrderedObject.new(
        value
        |> Enum.sort()
        |> Enum.map(fn {key, value} -> {key, stable(value)} end)
      )

  defp stable(value) when is_list(value), do: Enum.map(value, &stable/1)
  defp stable(value), do: value

  defp cap(log),
    do:
      Enum.find_value(log.ops, fn
        {_, %Op{body: {:genesis, delegation, _}}} ->
          if MapSet.member?(delegation.ops, :attest_member_key_v1), do: delegation.id

        _ ->
          nil
      end)

  defp certificate(sim, claim) do
    possession = Identity.sign(Sim.identity(sim, "new"), Certificate.possession_bytes(claim))

    vouches =
      Enum.map(claim.vouchers, fn voucher ->
        member = Enum.find(Map.values(sim.realms), &(&1.pub == voucher.member))

        %{
          member: member.pub,
          signature: Identity.sign(member, Certificate.vouch_bytes(claim, possession))
        }
      end)

    %{claim: claim, possession: possession, vouches: vouches}
  end

  defp signed(sim, claim, cap) do
    cert = certificate(sim, claim)

    Op.new(
      Sim.identity(sim, "root"),
      sim.replica,
      claim.deps,
      :command,
      {:attest_member_key_v1, [claim, cert.possession, cert.vouches]},
      cap: cap
    )
  end

  defp append(log, ops), do: Enum.reduce(ops, log, &Log.append!(&2, &1))

  defp digest(label),
    do: :crypto.hash(:sha256, "beam-semantic-#{label}") |> Base.url_encode64(padding: false)
end
