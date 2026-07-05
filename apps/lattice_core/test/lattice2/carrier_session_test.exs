defmodule Lattice.CarrierSessionTest do
  use ExUnit.Case, async: true

  alias Lattice.{Carrier.Session, Identity}

  test "challenge response binds realm, replica, nonce, and wire version" do
    identity = Identity.from_seed("node-a", "carrier-session")
    challenge = Session.challenge("server", "replica:session", wire_version: 1)
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
    challenge = Session.challenge("server", "replica:session", wire_version: 1)
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
    challenge = Session.challenge("server", "replica:session", wire_version: 1)
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
      |> Session.challenge("replica:session", wire_version: 1)
      |> Session.sign_challenge(identity)

    assert :ok =
             Session.verify_challenge(challenge,
               expected_realm: "node-b",
               expected_pubkey: identity.pub
             )
  end

  test "malformed signed challenges are rejected without raising" do
    identity = Identity.from_seed("node-b", "carrier-session")

    challenge =
      "node-b"
      |> Session.challenge("replica:session", wire_version: 1)
      |> Session.sign_challenge(identity)
      |> Map.put("wire_version", -1)

    assert {:error, :malformed_session} =
             Session.verify_challenge(challenge,
               expected_realm: "node-b",
               expected_pubkey: identity.pub
             )
  end

  test "non-string signed challenge fields are malformed instead of raising" do
    identity = Identity.from_seed("node-b", "carrier-session")

    challenge =
      "node-b"
      |> Session.challenge("replica:session", wire_version: 1)
      |> Session.sign_challenge(identity)

    for field <- ["pubkey", "signature"] do
      assert {:error, :malformed_session} =
               challenge
               |> Map.put(field, 42)
               |> Session.verify_challenge(
                 expected_realm: "node-b",
                 expected_pubkey: identity.pub
               )
    end
  end

  test "non-string response fields are malformed instead of raising" do
    identity = Identity.from_seed("node-a", "carrier-session")
    challenge = Session.challenge("server", "replica:session", wire_version: 1)
    response = Session.respond(challenge, identity, "node-a")

    for field <- ["pubkey", "signature"] do
      assert {:error, :malformed_session} =
               Session.verify_response(challenge, Map.put(response, field, 42),
                 expected_realm: "node-a",
                 expected_pubkey: identity.pub
               )
    end
  end
end
