defmodule LatticeCarrierServer.SecretTest do
  @moduledoc """
  Secret hygiene: wrapped identities and formatted process state never
  render private key material (plan 158: no identity in argv/logs).
  """

  use ExUnit.Case, async: true

  alias Lattice.{Identity, Log}
  alias LatticeCarrierServer.{Holder, Secret}

  test "wrapped secrets inspect as redacted" do
    identity = Identity.from_seed("town-node", "carrier-secret-inspect")
    secret = Secret.wrap(identity)

    rendered = inspect(secret, limit: :infinity)
    assert rendered == "#LatticeCarrierServer.Secret<redacted>"
    refute rendered =~ inspect(identity.priv)
    assert Secret.unwrap(secret) == identity
  end

  test "a running holder's formatted status redacts the private key" do
    identity = Identity.from_seed("town-node", "carrier-secret-status")

    holder =
      start_supervised!(
        {Holder,
         name: {:global, {__MODULE__, make_ref()}},
         identity: Secret.wrap(identity),
         source: {:log, Log.new("replica:carrier-secret:test")},
         relay_realms: []}
      )

    pid = GenServer.whereis(holder)
    status = :sys.get_status(pid)
    rendered = inspect(status, limit: :infinity)

    {:status, ^pid, {:module, :gen_server}, [_dictionary, _status, _parent, _debug, formatted]} =
      status

    [reported_state] =
      for {:data, entries} <- formatted,
          {~c"State", state} <- entries,
          do: state

    refute rendered =~ inspect(identity.priv)
    assert reported_state.identity.priv == :redacted
    assert reported_state.identity.pub == identity.pub
    assert reported_state.identity.realm_id == identity.realm_id
  end
end
