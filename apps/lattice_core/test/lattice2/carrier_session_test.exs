defmodule Lattice.CarrierSessionTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Lattice.Carrier.{Session, Wire}
  alias Lattice.Identity

  @server_nonce Base.url_encode64(:binary.copy(<<1>>, 32), padding: false)
  @other_server_nonce Base.url_encode64(:binary.copy(<<2>>, 32), padding: false)

  test "server nonce frames carry independent session and operation wire versions" do
    frame = Session.nonce_frame(wire_version: Wire.version())

    assert %{
             "type" => "carrier_nonce",
             "nonce" => nonce,
             "wire_version" => wire_version,
             "session_version" => session_version
           } = frame

    assert wire_version == Wire.version()
    assert session_version == Session.session_version()
    assert {:ok, decoded} = Base.url_decode64(nonce, padding: false)
    assert byte_size(decoded) == 32

    assert {:ok, ^nonce} =
             Session.verify_nonce_frame(frame, expected_wire_version: Wire.version())
  end

  test "nonce frames reject malformed and unsupported versions" do
    frame = Session.nonce_frame(wire_version: Wire.version())

    assert {:error, :unsupported_wire_version} =
             frame
             |> Map.put("wire_version", Wire.version() + 1)
             |> Session.verify_nonce_frame(expected_wire_version: Wire.version())

    assert {:error, :unsupported_session_version} =
             frame
             |> Map.put("session_version", Session.session_version() + 1)
             |> Session.verify_nonce_frame(expected_wire_version: Wire.version())

    assert {:error, :malformed_session} =
             frame
             |> Map.put("nonce", "too-short")
             |> Session.verify_nonce_frame(expected_wire_version: Wire.version())
  end

  test "challenge response binds realm, replica, both nonces, and both versions" do
    identity = Identity.from_seed("node-a", "carrier-session")
    challenge = challenge("server", "replica:session")
    response = Session.respond(challenge, identity, "node-a")

    assert :ok =
             Session.verify_response(challenge, response,
               expected_realm: "node-a",
               expected_pubkey: identity.pub
             )
  end

  test "wrong realm or wrong key is rejected" do
    identity = Identity.from_seed("node-a", "carrier-session")
    other = Identity.from_seed("node-b", "carrier-session:other")
    challenge = challenge("server", "replica:session")
    response = Session.respond(challenge, identity, "node-a")

    assert {:error, :wrong_realm} =
             Session.verify_response(challenge, response,
               expected_realm: "node-b",
               expected_pubkey: identity.pub
             )

    assert {:error, :bad_signature} =
             Session.verify_response(challenge, response,
               expected_realm: "node-a",
               expected_pubkey: other.pub
             )
  end

  test "responses from the right realm but missing required fields are malformed" do
    challenge = challenge("server", "replica:session")
    identity = Identity.from_seed("node-a", "carrier-session")

    assert {:error, :malformed_session} =
             Session.verify_response(challenge, %{"realm" => "node-a"},
               expected_realm: "node-a",
               expected_pubkey: identity.pub
             )
  end

  test "signed challenges authenticate the caller before protocol messages are served" do
    identity = Identity.from_seed("node-b", "carrier-session")

    challenge =
      "node-b"
      |> challenge("replica:session")
      |> Session.sign_challenge(identity)

    assert :ok =
             Session.verify_challenge(challenge,
               expected_realm: "node-b",
               expected_pubkey: identity.pub,
               expected_server_nonce: @server_nonce,
               expected_wire_version: Wire.version()
             )
  end

  test "signed challenges reject nonce and version mismatches" do
    identity = Identity.from_seed("node-b", "carrier-session")

    signed =
      "node-b"
      |> challenge("replica:session")
      |> Session.sign_challenge(identity)

    assert {:error, :wrong_server_nonce} =
             Session.verify_challenge(signed,
               expected_realm: "node-b",
               expected_pubkey: identity.pub,
               expected_server_nonce: @other_server_nonce,
               expected_wire_version: Wire.version()
             )

    assert {:error, :unsupported_wire_version} =
             Session.verify_challenge(signed,
               expected_realm: "node-b",
               expected_pubkey: identity.pub,
               expected_server_nonce: @server_nonce,
               expected_wire_version: Wire.version() + 1
             )

    assert {:error, :unsupported_session_version} =
             signed
             |> Map.put("session_version", Session.session_version() + 1)
             |> Session.verify_challenge(
               expected_realm: "node-b",
               expected_pubkey: identity.pub,
               expected_server_nonce: @server_nonce,
               expected_wire_version: Wire.version()
             )
  end

  test "both signature directions bind the server nonce" do
    client = Identity.from_seed("node-b", "carrier-session")
    server = Identity.from_seed("node-a", "carrier-session-server")

    signed =
      "node-b"
      |> challenge("replica:session")
      |> Session.sign_challenge(client)

    tampered = Map.put(signed, "server_nonce", @other_server_nonce)

    assert {:error, :bad_signature} =
             Session.verify_challenge(tampered,
               expected_realm: "node-b",
               expected_pubkey: client.pub,
               expected_server_nonce: @other_server_nonce,
               expected_wire_version: Wire.version()
             )

    response = Session.respond(signed, server, "node-a")

    assert {:error, :bad_signature} =
             Session.verify_response(tampered, response,
               expected_realm: "node-a",
               expected_pubkey: server.pub
             )
  end

  test "malformed signed challenges are rejected without raising" do
    identity = Identity.from_seed("node-b", "carrier-session")

    challenge =
      "node-b"
      |> challenge("replica:session")
      |> Session.sign_challenge(identity)
      |> Map.delete("server_nonce")

    assert {:error, :malformed_session} =
             Session.verify_challenge(challenge,
               expected_realm: "node-b",
               expected_pubkey: identity.pub,
               expected_server_nonce: @server_nonce,
               expected_wire_version: Wire.version()
             )
  end

  test "non-string signed challenge fields are malformed instead of raising" do
    identity = Identity.from_seed("node-b", "carrier-session")

    challenge =
      "node-b"
      |> challenge("replica:session")
      |> Session.sign_challenge(identity)

    for field <- ["pubkey", "signature"] do
      assert {:error, :malformed_session} =
               challenge
               |> Map.put(field, 42)
               |> Session.verify_challenge(
                 expected_realm: "node-b",
                 expected_pubkey: identity.pub,
                 expected_server_nonce: @server_nonce,
                 expected_wire_version: Wire.version()
               )
    end
  end

  test "non-string response fields are malformed instead of raising" do
    identity = Identity.from_seed("node-a", "carrier-session")
    challenge = challenge("server", "replica:session")
    response = Session.respond(challenge, identity, "node-a")

    for field <- ["pubkey", "signature"] do
      assert {:error, :malformed_session} =
               Session.verify_response(challenge, Map.put(response, field, 42),
                 expected_realm: "node-a",
                 expected_pubkey: identity.pub
               )
    end
  end

  test "consecutive challenges have distinct nonces" do
    nonces =
      for _ <- 1..100 do
        challenge("server", "replica:session")["nonce"]
      end

    assert MapSet.size(MapSet.new(nonces)) == 100
  end

  property "a response only verifies against its own challenge" do
    check all(
            realm <- member_of(["node-a", "node-b", "node-c"]),
            replica <- string(:alphanumeric, min_length: 1, max_length: 8)
          ) do
      identity = Identity.from_seed(realm, "carrier-session-property")
      challenge_a = challenge("server", "replica:#{replica}")
      challenge_b = challenge("server", "replica:#{replica}")
      response = Session.respond(challenge_a, identity, realm)

      assert challenge_a["nonce"] != challenge_b["nonce"]

      assert {:error, :bad_signature} =
               Session.verify_response(challenge_b, response,
                 expected_realm: realm,
                 expected_pubkey: identity.pub
               )
    end
  end

  defp challenge(local_realm, replica) do
    Session.challenge(local_realm, replica,
      server_nonce: @server_nonce,
      wire_version: Wire.version()
    )
  end
end
