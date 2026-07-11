defmodule TownshipWeb.InstrumentSource.Bundle do
  @moduledoc """
  Loads a Township read model only after the complete audit bundle verifies.
  """

  @behaviour TownshipWeb.InstrumentSource

  alias Lattice.{Attestation, Identity, Log}
  alias Township.{AuditBundle, ReadModel}

  @impl true
  def load(opts) do
    bundle_dir = opts |> Keyword.fetch!(:bundle_dir) |> Path.expand()

    case AuditBundle.verify(bundle_dir) do
      :ok -> load_verified(bundle_dir)
      {:error, errors} -> {:error, {:bundle_unverified, errors}}
    end
  rescue
    error -> {:error, {:bundle_unverified, [Exception.message(error)]}}
  end

  # bundle_dir is application-config/test-only and filenames are literals, never request-derived.
  # sobelow_skip ["Traversal.FileModule"]
  defp load_verified(bundle_dir) do
    manifest_path = Path.join(bundle_dir, "manifest.json")
    matter_path = Path.join(bundle_dir, "matter.log")

    with {:ok, manifest_bytes} <- File.read(manifest_path),
         {:ok, %{"labels" => labels, "schema" => schema}} <- Jason.decode(manifest_bytes),
         {:ok, matter_bytes} <- File.read(matter_path),
         {:ok, log} <- Log.restore(matter_path) do
      {:ok,
       %{
         read_model: ReadModel.observe(log, labels: labels, vouches: demo_vouches()),
         causal_replay: ReadModel.replay(log),
         provenance: %{
           bundle_dir: bundle_dir,
           matter_sha256: sha256(matter_bytes),
           schema: schema,
           verified: true
         }
       }}
    else
      {:error, reason} -> {:error, {:bundle_unverified, [format_error(reason)]}}
      _invalid_manifest -> {:error, {:bundle_unverified, ["manifest.json contract mismatch"]}}
    end
  end

  defp demo_vouches do
    [
      {"realm:alice", <<9::256>>, :approve},
      {"realm:bob", <<10::256>>, :approve},
      {"realm:carol", <<11::256>>, :reject}
    ]
    |> Enum.map(fn {realm, seed, choice} ->
      identity = Identity.from_seed(realm, seed)
      {_token, body} = Attestation.cast_vouch(Attestation.Stub, identity, choice)
      body
    end)
  end

  defp sha256(bytes), do: :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)
  defp format_error(reason) when is_binary(reason), do: reason
  defp format_error(reason), do: inspect(reason)
end
