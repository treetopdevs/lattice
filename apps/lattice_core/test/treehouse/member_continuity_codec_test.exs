defmodule Treehouse.MemberContinuityCodecTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Canonical, Identity}
  alias Lattice.Carrier.Wire
  alias Treehouse.MemberContinuityCertificate, as: Certificate
  alias Treehouse.MemberContinuityVectors, as: Vectors

  test "all four public byte purposes and independently expected signatures are closed" do
    f = Vectors.fixture()

    assert Certificate.claim_bytes(f.claim) ==
             Canonical.term(["treehouse-member-key-claim-v1", f.claim])

    assert Certificate.possession_bytes(f.claim) ==
             Canonical.term(["treehouse-member-key-possession-v1", f.claim])

    assert Certificate.vouch_bytes(f.claim, f.certificate.possession) ==
             Canonical.term(["treehouse-member-key-vouch-v1", f.claim, f.certificate.possession])

    assert Certificate.return_bytes(f.challenge) ==
             Canonical.term(["treehouse-member-key-return-v1", f.challenge])

    assert Certificate.claim_id(f.claim) ==
             :crypto.hash(:sha256, Canonical.term(["treehouse-member-key-claim-v1", f.claim]))
             |> Base.url_encode64(padding: false)

    assert :ok = Certificate.verify_certificate(f.certificate, f.claim)
    assert :ok = Certificate.verify_return(f.challenge, f.signature, f.challenge)

    assert {:ok, [f.claim, f.certificate.possession, f.certificate.vouches]} ==
             Certificate.command_arguments(f.certificate)
  end

  test "closed wire adapters retain genuine signatures and reject duplicate raw fields" do
    f = Vectors.fixture()

    for {to, from, value} <- [
          {&Certificate.claim_to_wire/1, &Certificate.claim_from_wire/1, f.claim},
          {&Certificate.certificate_to_wire/1, &Certificate.certificate_from_wire/1,
           f.certificate},
          {&Certificate.return_challenge_to_wire/1, &Certificate.return_challenge_from_wire/1,
           f.challenge}
        ] do
      encoded = Wire.encode_value(value)
      assert {:ok, ^encoded} = to.(value)
      assert {:ok, ^value} = from.(encoded)
      ["map", pairs] = encoded

      assert {:error, :invalid_member_continuity} =
               from.(["map", pairs ++ [hd(pairs)]])
    end
  end

  test "closed claim retains the exact reviewed admission, keys and ordered vouchers" do
    old = Identity.from_seed("old", "r19b-beam-old")
    next = Identity.from_seed("new", "r19b-beam-new")
    root = Identity.from_seed("root", "r19b-beam-root")

    members =
      Enum.map(["a", "b"], &Identity.from_seed(&1, "r19b-beam-member-#{&1}"))
      |> Enum.sort_by(& &1.pub)

    claim = %{
      version: 1,
      product: :treehouse,
      space:
        Authority.bind_replica(
          "replica:treehouse:space:#{id("space")}#authority:bounded-continuation-v1",
          root.pub
        ),
      old_pub: old.pub,
      new_pub: next.pub,
      old_admission: id("old-admission"),
      old_membership: :active,
      nonce: :binary.copy(<<7>>, 32),
      deps: [id("dep")],
      epoch: 0,
      epoch_basis: [id("beacon")],
      parents: [],
      vouchers:
        Enum.with_index(members, fn member, i ->
          %{member: member.pub, admission: id("admission-#{i}")}
        end)
    }

    assert {:ok, ^claim} = Certificate.normalize_claim(claim)

    for malformed <- [
          Map.put(claim, :extra, 1),
          Map.delete(claim, :old_admission),
          %{claim | old_pub: next.pub},
          %{claim | epoch: 9_007_199_254_740_992},
          %{claim | deps: []},
          %{claim | deps: claim.deps ++ claim.deps},
          %{claim | epoch_basis: []},
          %{claim | nonce: <<1>>},
          %{claim | vouchers: Enum.reverse(claim.vouchers)},
          %{claim | vouchers: claim.vouchers ++ claim.vouchers},
          %{claim | space: claim.space <> <<255>>}
        ] do
      assert {:error, :invalid_member_continuity} =
               Certificate.normalize_claim(malformed)
    end
  end

  test "every claim binding and possession purpose is covered by both member signatures" do
    f = Vectors.fixture()

    changes = [
      version: 2,
      product: :township,
      space: String.replace(f.claim.space, ":space:", ":thread:"),
      old_pub: f.root.pub,
      new_pub: f.old.pub,
      old_admission: id("different-admission"),
      old_membership: :removed,
      nonce: :binary.copy(<<0>>, 32),
      deps: [id("different-dep")],
      epoch: 1,
      epoch_basis: [id("different-beacon")],
      parents: [id("different-parent")],
      vouchers: [
        Map.put(hd(f.claim.vouchers), :admission, id("different-voucher-admission")),
        List.last(f.claim.vouchers)
      ]
    ]

    for {key, value} <- changes do
      changed = Map.put(f.claim, key, value)

      assert {:error, :invalid_member_continuity} =
               Certificate.verify_certificate(f.certificate, changed)

      assert {:error, :invalid_member_continuity} =
               Certificate.verify_certificate(%{f.certificate | claim: changed}, changed)
    end

    wrong_possessions = [
      f.signature,
      Identity.sign(f.old, Certificate.possession_bytes(f.claim)),
      Identity.sign(f.next, Certificate.claim_bytes(f.claim)),
      :binary.copy(<<0>>, 64)
    ]

    for signature <- wrong_possessions do
      assert {:error, :invalid_member_continuity} =
               Certificate.verify_certificate(%{f.certificate | possession: signature}, f.claim)
    end

    for index <- [0, 1] do
      changed =
        Map.update!(
          f.certificate,
          :vouches,
          &List.update_at(&1, index, fn entry ->
            %{entry | signature: f.certificate.possession}
          end)
        )

      assert {:ok, _} = Certificate.normalize_certificate(changed)

      assert {:error, :invalid_member_continuity} =
               Certificate.verify_certificate(changed, f.claim)
    end
  end

  test "malformed or surplus signatures cannot be normalized or hidden by successful entries" do
    f = Vectors.fixture()
    [a, b] = f.certificate.vouches

    malformed = [
      Map.put(f.certificate, :extra, 1),
      Map.delete(f.certificate, :possession),
      %{f.certificate | possession: <<0>>},
      %{f.certificate | vouches: []},
      %{f.certificate | vouches: [a]},
      %{f.certificate | vouches: [a, b, a]},
      %{f.certificate | vouches: [b, a]},
      %{f.certificate | vouches: [a, a]},
      %{f.certificate | vouches: [%{a | member: f.root.pub}, b]},
      %{f.certificate | vouches: [Map.put(a, :extra, 1), b]},
      %{f.certificate | vouches: [a, %{b | signature: <<0>>}]}
    ]

    for value <- malformed do
      assert {:error, :invalid_member_continuity} = Certificate.normalize_certificate(value)
      assert {:error, :invalid_member_continuity} = Certificate.verify_certificate(value, f.claim)
      assert {:error, :invalid_member_continuity} = Certificate.command_arguments(value)
    end
  end

  test "raw nested duplicate maps and noncanonical binary or integer representations refuse" do
    f = Vectors.fixture()
    encoded = Wire.encode_value(f.certificate)

    for field <- ["claim", "vouchers", "vouches"] do
      duplicated = duplicate_nested(encoded, field)
      assert duplicated != encoded
      assert {:error, :invalid_member_continuity} = Certificate.certificate_from_wire(duplicated)
    end

    ["map", pairs] = Wire.encode_value(f.claim)

    for replacement <- [
          ["int", "+0"],
          ["int", "00"],
          ["int", 0.0],
          ["int", -1],
          ["int", 18_446_744_073_709_551_616]
        ] do
      assert {:error, :invalid_member_continuity} =
               Certificate.claim_from_wire(["map", replace_field(pairs, "epoch", replacement)])
    end

    assert {:ok, _} =
             Certificate.claim_from_wire(["map", replace_field(pairs, "epoch", ["int", "0"])])

    binary = Base.encode64(f.claim.nonce)

    for malformed <- [
          String.trim_trailing(binary, "="),
          binary <> "\n",
          binary_part(binary, 0, 42) <> "B="
        ] do
      assert {:error, :invalid_member_continuity} =
               Certificate.claim_from_wire([
                 "map",
                 replace_field(pairs, "nonce", ["bin", malformed])
               ])
    end

    assert {:error, :invalid_member_continuity} =
             Certificate.claim_from_wire([
               "map",
               replace_field(pairs, "space", ["bin", Base.encode64(<<255>>)])
             ])

    assert {:error, :invalid_member_continuity} =
             Certificate.claim_from_wire([
               "map",
               [[["atom", "uncreated_remote_r19b_atom"], ["int", 1]]]
             ])
  end

  test "return bound uses the complete purpose bytes plus64 with attainable neighbors" do
    f = Vectors.fixture()
    deps = for n <- 1..1412, do: id("bound-#{n}")
    allowed = %{f.challenge | deps: deps |> Enum.take(1411) |> Enum.sort()}
    oversized = %{f.challenge | deps: Enum.sort(deps)}
    assert byte_size(Canonical.term(["treehouse-member-key-return-v1", allowed])) + 64 == 63_990
    assert byte_size(Canonical.term(["treehouse-member-key-return-v1", oversized])) + 64 == 64_035
    assert {:ok, ^allowed} = Certificate.normalize_return_challenge(allowed)
    signature = Identity.sign(f.old, Certificate.return_bytes(allowed))
    assert :ok = Certificate.verify_return(allowed, signature, allowed)

    assert {:error, :invalid_member_continuity} =
             Certificate.normalize_return_challenge(oversized)

    assert {:error, :invalid_member_continuity} =
             Certificate.verify_return(oversized, signature, oversized)

    assert_raise ArgumentError, fn -> Certificate.return_bytes(oversized) end

    sixteen = %{
      allowed
      | heads: Enum.sort(for n <- 1..16, do: id("head-#{n}")),
        deps: allowed.deps |> Enum.take(1396)
    }

    assert byte_size(Certificate.return_bytes(sixteen)) + 64 == 63_990
  end

  test "return signature binds every field without pretending native consumption" do
    f = Vectors.fixture()

    for {key, value} <- [
          version: 2,
          product: :township,
          space: f.claim.space <> "x",
          old_pub: f.next.pub,
          heads: [id("changed-head")],
          deps: [id("changed-deps")],
          reviewer: f.root.pub,
          nonce: :binary.copy(<<0>>, 32)
        ] do
      changed = Map.put(f.challenge, key, value)

      assert {:error, :invalid_member_continuity} =
               Certificate.verify_return(f.challenge, f.signature, changed)

      assert {:error, :invalid_member_continuity} =
               Certificate.verify_return(changed, f.signature, changed)
    end

    for signature <- [
          f.certificate.possession,
          Identity.sign(f.next, Certificate.return_bytes(f.challenge)),
          <<0>>
        ] do
      assert {:error, :invalid_member_continuity} =
               Certificate.verify_return(f.challenge, signature, f.challenge)
    end

    assert :ok = Certificate.verify_return(f.challenge, f.signature, f.challenge)
    assert :ok = Certificate.verify_return(f.challenge, f.signature, f.challenge)
  end

  test "public shape helpers refuse malformed values and byte helpers raise the documented error" do
    f = Vectors.fixture()

    for value <- [
          nil,
          [],
          1,
          "claim",
          %{},
          %{f.claim | epoch: 0.0},
          %{f.claim | parents: Enum.sort(for n <- 1..17, do: id("p#{n}"))},
          %{
            f.claim
            | vouchers: [
                %{hd(f.claim.vouchers) | member: f.claim.old_pub},
                List.last(f.claim.vouchers)
              ]
          }
        ] do
      assert {:error, :invalid_member_continuity} = Certificate.normalize_claim(value)
      assert_raise ArgumentError, fn -> Certificate.claim_id(value) end
      assert_raise ArgumentError, fn -> Certificate.claim_bytes(value) end
      assert_raise ArgumentError, fn -> Certificate.possession_bytes(value) end

      assert {:error, :invalid_member_continuity} =
               Certificate.verify_certificate(f.certificate, value)
    end

    for value <- [
          %{f.challenge | heads: []},
          %{f.challenge | heads: Enum.sort(for n <- 1..17, do: id("h#{n}"))},
          %{f.challenge | deps: []},
          %{f.challenge | heads: f.challenge.heads ++ f.challenge.heads},
          Map.put(f.challenge, :extra, 0)
        ] do
      assert {:error, :invalid_member_continuity} = Certificate.normalize_return_challenge(value)
    end

    assert_raise ArgumentError, fn -> Certificate.vouch_bytes(f.claim, <<0>>) end

    assert {:ok, _} =
             Certificate.normalize_claim(%{
               f.claim
               | epoch: 9_007_199_254_740_991,
                 old_membership: :removed,
                 parents: Enum.sort(for n <- 1..16, do: id("p#{n}"))
             })
  end

  test "BEAM float versions cannot normalize into unencodable signed artifacts" do
    f = Vectors.fixture()
    claim = %{f.claim | version: 1.0}
    challenge = %{f.challenge | version: 1.0}
    assert {:error, :invalid_member_continuity} = Certificate.normalize_claim(claim)

    assert {:error, :invalid_member_continuity} =
             Certificate.normalize_certificate(%{f.certificate | claim: claim})

    assert {:error, :invalid_member_continuity} =
             Certificate.normalize_return_challenge(challenge)

    assert {:error, :invalid_member_continuity} =
             Certificate.verify_certificate(%{f.certificate | claim: claim}, claim)

    assert {:error, :invalid_member_continuity} =
             Certificate.verify_return(challenge, f.signature, challenge)
  end

  test "new vocabulary does not enable the genuinely signed ordinary command" do
    assert Certificate.command_name() == :attest_member_key_v1
    f = Vectors.fixture()
    u = Vectors.unknown_command(f)
    assert :ok = Lattice.Log.verify_authenticity(u.log)
    assert Lattice.Op.valid?(u.op)
    analysis = Authority.analyze(Treehouse.Space, u.log)
    assert analysis.reasons[u.op.id] == :operation_not_granted
    assert MapSet.member?(analysis.quarantine, u.op.id)
    assert Map.keys(Lattice.Log.ops(u.log)) |> Enum.sort() == Enum.sort([u.genesis.id, u.op.id])
  end

  defp replace_field(pairs, key, value),
    do:
      Enum.map(pairs, fn
        [["atom", ^key], _] -> [["atom", key], value]
        pair -> pair
      end)

  defp duplicate_nested(["map", pairs], field) do
    [
      "map",
      Enum.map(pairs, fn
        [["atom", ^field], ["map", nested]] ->
          [["atom", field], ["map", nested ++ [hd(nested)]]]

        [["atom", ^field], ["list", [["map", nested] | rest]]] ->
          [["atom", field], ["list", [["map", nested ++ [hd(nested)]] | rest]]]

        [key, value] ->
          [key, duplicate_nested(value, field)]
      end)
    ]
  end

  defp duplicate_nested(value, _), do: value

  defp id(label), do: :crypto.hash(:sha256, label) |> Base.url_encode64(padding: false)
end
