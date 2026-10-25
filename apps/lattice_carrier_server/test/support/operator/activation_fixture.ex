defmodule LatticeCarrierServer.Operator.ActivationFixture do
  @moduledoc false
  import ExUnit.Assertions
  alias Lattice.Log
  alias LatticeCarrierServer.{Manifest, Runtime}

  alias LatticeCarrierServer.Operator.{
    Journal,
    ReleaseActivation,
    ReleaseQuiesce,
    ReleaseStopSeal
  }

  def activated!(f) do
    Application.put_env(:lattice_carrier_server, :manifest, f.manifest)
    Application.put_env(:lattice_carrier_server, :operator_root, f.root)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
    deployment = Runtime.deployment()
    {:ok, manifest} = Manifest.load(f.manifest)
    replicas = Map.new(manifest.instances, &{&1.name, Log.restore_verified(&1.log_file)})

    expected = %{
      manifest_path: deployment.manifest_path,
      manifest_digest: deployment.manifest_digest,
      instances:
        Enum.map(deployment.instances, fn instance ->
          {:ok, %{log: log}} = replicas[instance.name]
          instance |> Map.take([:name, :realm, :pub, :log_file]) |> Map.put(:replica, log.replica)
        end)
    }

    assert {:ok, receipt} = ReleaseQuiesce.drain(f.request.attempt, expected)
    assert {:ok, observation} = ReleaseStopSeal.stop_and_seal(deployment.owner, receipt)

    assert {:ok, _} =
             ReleaseActivation.activate(
               f.root,
               f.journal,
               deployment.owner,
               observation,
               f.ceremony_dir
             )

    {:ok, activated} = Journal.read(f.root)
    activated
  end

  def restart! do
    assert :ok = Application.stop(:lattice_carrier_server)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
  end
end
