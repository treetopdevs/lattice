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
end
