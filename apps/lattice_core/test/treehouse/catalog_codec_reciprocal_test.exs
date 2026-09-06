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
    assert Base.encode64(TransportCatalog.rotation_bytes(rotation.rotation)) == vector["rotation_bytes"]
    assert Base.encode64(TransportCatalog.rotation_possession_bytes(rotation.rotation)) == vector["possession_bytes"]
    assert TransportCatalog.rotation_id(rotation) == vector["rotation_id"]
  end

  test "changed transition fields or purpose signatures cannot reuse the legitimate rotation" do
    vector = fixture()
    assert {:ok, envelope} = Wire.decode_value(vector["rotation_envelope_term"])
    key = Base.decode64!(vector["expected_old_key"])
    for changed <- [
      %{envelope | rotation: %{envelope.rotation | generation: 2}},
      %{envelope | old_signature: envelope.new_signature},
      %{envelope | new_signature: envelope.old_signature},
      %{envelope | rotation: %{envelope.rotation | nonce: envelope.rotation.parent}}
    ] do
      assert {:error, :invalid_rotation_signature} = TransportCatalog.verify_rotation(changed, key)
    end
    for malformed <- [Map.put(envelope, :extra, 1),
      %{envelope | rotation: %{envelope.rotation | cutoffs: []}},
      %{envelope | rotation: %{envelope.rotation | generation: 0}},
      %{envelope | rotation: Map.put(envelope.rotation, :service_key, key)}] do
      assert {:error, :malformed_catalog} = TransportCatalog.verify_rotation(malformed, key)
    end
  end

  defp fixture do
    Path.expand("../../../../clients/lattice-client/test/vectors/treehouse_catalog/ts_codec.json", __DIR__)
    |> File.read!()
    |> Jason.decode!()
  end
end
