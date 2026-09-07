defmodule Treehouse.MemberContinuityVectors do
  @moduledoc "Public synthetic continuity statements; no membership or native ceremony evidence."

  alias Lattice.{Authority, Canonical, Identity, Log, Op}
  alias Lattice.Authority.Delegation
  alias Lattice.Carrier.Wire
  alias Treehouse.MemberContinuityCertificate, as: Certificate

  @spec fixture() :: map()
  def fixture do
    root = Identity.from_seed("root", "r19b-beam-codec-root")
    old = Identity.from_seed("old", "r19b-beam-codec-old")
    next = Identity.from_seed("new", "r19b-beam-codec-new")

    members =
      Enum.map(["a", "b"], &Identity.from_seed(&1, "r19b-beam-codec-#{&1}"))
      |> Enum.sort_by(& &1.pub)

    space =
      Authority.bind_replica(
        "replica:treehouse:space:#{id("space")}#authority:bounded-continuation-v1",
        root.pub
      )

    claim = %{
      version: 1,
      product: :treehouse,
      space: space,
      old_pub: old.pub,
      new_pub: next.pub,
      old_admission: id("old-admission"),
      old_membership: :active,
      nonce: :crypto.hash(:sha256, "r19b-beam-nonce"),
      deps: [id("dep")],
      epoch: 0,
      epoch_basis: [id("beacon")],
      parents: [],
      vouchers:
        Enum.with_index(members, fn member, i ->
          %{member: member.pub, admission: id("admission-#{i}")}
        end)
    }

    possession =
      Identity.sign(next, Canonical.term(["treehouse-member-key-possession-v1", claim]))

    vouches =
      Enum.map(
        members,
        &%{
          member: &1.pub,
          signature:
            Identity.sign(
              &1,
              Canonical.term(["treehouse-member-key-vouch-v1", claim, possession])
            )
        }
      )

    certificate = %{claim: claim, possession: possession, vouches: vouches}

    challenge = %{
      version: 1,
      product: :treehouse,
      space: space,
      old_pub: old.pub,
      heads: [id("head")],
      deps: [id("return-dep")],
      reviewer: hd(members).pub,
      nonce: :crypto.hash(:sha256, "r19b-beam-return-nonce")
    }

    signature = Identity.sign(old, Canonical.term(["treehouse-member-key-return-v1", challenge]))

    %{
      root: root,
      old: old,
      next: next,
      members: members,
      claim: claim,
      certificate: certificate,
      challenge: challenge,
      signature: signature
    }
  end

  @spec unknown_command(map()) :: map()
  def unknown_command(f) do
    delegation =
      Delegation.genesis(f.root, f.claim.space,
        ops: [
          :create_space,
          :create_thread,
          :issue_invitation,
          :revoke_invitation,
          :admit_member,
          :remove_member
        ],
        roles: [:admin],
        live: true
      )

    genesis = Op.new(f.root, f.claim.space, [], :authority, {:genesis, delegation, %{}})

    op =
      Op.new(
        f.root,
        f.claim.space,
        [genesis.id],
        :command,
        {:attest_member_key_v1, [f.claim, f.certificate.possession, f.certificate.vouches]},
        cap: delegation.id
      )

    log =
      Enum.reduce([genesis, op], Log.new(f.claim.space), fn item, log ->
        {:ok, decoded} = Wire.decode_op(Wire.encode_op(item))
        {:ok, next} = Log.accept(log, decoded)
        next
      end)

    %{genesis: genesis, op: op, log: log}
  end

  @spec codec_vector() :: map()
  def codec_vector do
    f = fixture()
    u = unknown_command(f)
    :ok = Certificate.verify_certificate(f.certificate, f.claim)
    :ok = Certificate.verify_return(f.challenge, f.signature, f.challenge)
    :unknown_command = Map.fetch!(Authority.analyze(Treehouse.Space, u.log).reasons, u.op.id)

    %{
      version: 1,
      producer: "beam",
      claim_term: Wire.encode_value(f.claim),
      certificate_term: Wire.encode_value(f.certificate),
      return_challenge_term: Wire.encode_value(f.challenge),
      return_signature: Base.encode64(f.signature),
      claim_id: Certificate.claim_id(f.claim),
      claim_bytes: Base.encode64(Certificate.claim_bytes(f.claim)),
      possession_bytes: Base.encode64(Certificate.possession_bytes(f.claim)),
      vouch_bytes: Base.encode64(Certificate.vouch_bytes(f.claim, f.certificate.possession)),
      return_bytes: Base.encode64(Certificate.return_bytes(f.challenge)),
      unknown_command: %{
        replica: f.claim.space,
        frames: Wire.encode_ops([u.genesis, u.op]),
        op_id: u.op.id,
        expected_reason: "unknown_command"
      }
    }
  end

  @spec export!(String.t()) :: :ok
  def export!(path) do
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, Jason.encode!(ordered_json(codec_vector()), pretty: true) <> "\n")
  end

  defp ordered_json(value) when is_map(value) do
    value
    |> Enum.map(fn {key, item} -> {to_string(key), ordered_json(item)} end)
    |> Enum.sort_by(&elem(&1, 0))
    |> Jason.OrderedObject.new()
  end

  defp ordered_json(value) when is_list(value), do: Enum.map(value, &ordered_json/1)
  defp ordered_json(value), do: value

  @spec id(String.t()) :: String.t()
  def id(label),
    do: :crypto.hash(:sha256, "r19b-beam-" <> label) |> Base.url_encode64(padding: false)
end
