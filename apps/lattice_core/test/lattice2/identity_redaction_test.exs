defmodule Lattice.IdentityRedactionTest do
  use ExUnit.Case, async: true

  alias Lattice.Identity

  test "inspecting an identity never renders private key bytes" do
    identity = Identity.from_seed("redaction", "identity-redaction-probe")
    rendered = inspect(identity)

    refute rendered =~ inspect(identity.priv),
           "inspect/1 must not render the private key"

    assert rendered =~ "redaction", "the realm id should still be visible for debugging"
  end

  test "an identity nested in a larger term is still redacted" do
    identity = Identity.from_seed("redaction", "identity-redaction-probe")
    rendered = inspect(%{connect_opts: [identity: identity, replica: "r"]})

    refute rendered =~ inspect(identity.priv)
  end
end
