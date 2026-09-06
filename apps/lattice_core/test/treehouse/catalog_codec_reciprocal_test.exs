defmodule Treehouse.CatalogCodecReciprocalTest do
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Wire
  alias Treehouse.TransportCatalog

  # Existing atoms in the exact closed protocol, never supplied to atom creation.
  @rotation_fields ~w(rotation old_signature new_signature version product space bootstrap parent prior_catalog generation new_catalog_key nonce inventory_digest cutoffs replica frontier log_digest)a

  test "TypeScript's independently signed planned rotation verifies both fixed purposes in BEAM" do
    vector = fixture()
    assert {:ok, rotation} = Wire.decode_value(vector["rotation_envelope_term"])
    assert Enum.sort(Map.keys(rotation.rotation)) ==
             Enum.sort(@rotation_fields -- [:rotation, :old_signature, :new_signature, :replica, :frontier, :log_digest])
    assert :ok = TransportCatalog.verify_rotation(rotation, Base.decode64!(vector["expected_old_key"]))
  end

  defp fixture do
    Path.expand("../../../../clients/lattice-client/test/vectors/treehouse_catalog/ts_codec.json", __DIR__)
    |> File.read!()
    |> Jason.decode!()
  end
end
