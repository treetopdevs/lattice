defmodule Township.ElectionArtifactTest do
  use ExUnit.Case, async: true

  alias Township.Election.ArtifactRef
  alias Township.Election.ArtifactStore.Memory

  @max_bytes 1_024

  test "artifact references bind exact bytes, codec, and profile in canonical primitive form" do
    {:ok, ref} = artifact_ref("opaque ballot bytes")

    assert byte_size(ref.digest) == 43
    assert ref.byte_size == byte_size("opaque ballot bytes")
    assert Lattice.Canonical.signable?(ArtifactRef.to_canonical_term(ref))

    alternatives = [
      {"changed bytes", [codec: "township-artifact-v1", profile: "research-profile"]},
      {"opaque ballot bytes", [codec: "township-artifact-v2", profile: "research-profile"]},
      {"opaque ballot bytes", [codec: "township-artifact-v1", profile: "other-profile"]}
    ]

    for {bytes, opts} <- alternatives do
      {:ok, changed} = ArtifactRef.new(bytes, Keyword.put(opts, :max_byte_size, @max_bytes))
      refute changed.digest == ref.digest
    end
  end

  test "artifact construction enforces the supplied bound and canonical metadata" do
    assert {:error, :artifact_too_large} =
             ArtifactRef.new(String.duplicate("x", @max_bytes + 1),
               codec: "township-artifact-v1",
               profile: "research-profile",
               max_byte_size: @max_bytes
             )

    assert {:error, :invalid_artifact_bound} =
             ArtifactRef.new("bytes",
               codec: "township-artifact-v1",
               profile: "research-profile",
               max_byte_size: 0
             )

    assert {:error, :noncanonical_artifact} =
             ArtifactRef.new("bytes",
               codec: "township-artifact-v1",
               profile: "research-profile",
               max_byte_size: @max_bytes,
               availability_certificate: make_ref()
             )
  end

  test "the in-memory resolver is idempotent and an availability certificate is not availability" do
    {:ok, ref} = artifact_ref("manifest", availability_certificate: "operator-claim")
    store = Memory.new()

    assert {:error, :artifact_unavailable} =
             Memory.resolve(store, ref, max_byte_size: @max_bytes)

    assert {:ok, stored} = Memory.put(store, ref, "manifest", max_byte_size: @max_bytes)
    assert {:ok, same} = Memory.put(stored, ref, "manifest", max_byte_size: @max_bytes)
    assert same == stored
    assert {:ok, "manifest"} = Memory.resolve(same, ref, max_byte_size: @max_bytes)
  end

  test "resolution fails closed for altered bytes, size metadata, and malformed refs" do
    {:ok, ref} = artifact_ref("trustee transcript")

    corrupt_store = %Memory{bytes: %{ref.digest => "altered transcript"}}

    assert {:error, :artifact_digest_mismatch} =
             Memory.resolve(corrupt_store, ref, max_byte_size: @max_bytes)

    valid_store = %Memory{bytes: %{ref.digest => "trustee transcript"}}

    assert {:error, :artifact_size_mismatch} =
             Memory.resolve(valid_store, %{ref | byte_size: ref.byte_size + 1},
               max_byte_size: @max_bytes
             )

    assert {:error, :noncanonical_artifact} =
             Memory.resolve(valid_store, %{ref | codec: make_ref()}, max_byte_size: @max_bytes)

    assert {:error, :noncanonical_artifact} =
             Memory.resolve(valid_store, %{ref | digest: String.duplicate("!", 43)},
               max_byte_size: @max_bytes
             )
  end

  defp artifact_ref(bytes, extra_opts \\ []) do
    ArtifactRef.new(
      bytes,
      Keyword.merge(
        [
          codec: "township-artifact-v1",
          profile: "research-profile",
          max_byte_size: @max_bytes
        ],
        extra_opts
      )
    )
  end
end
