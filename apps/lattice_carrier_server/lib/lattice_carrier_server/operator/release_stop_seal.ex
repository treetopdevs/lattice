defmodule LatticeCarrierServer.Operator.ReleaseStopSeal do
  @moduledoc """
  Private, incarnation-bound observation of a controlled stop. A drained receipt
  is required, but neither that receipt nor this observation activates a
  manifest or grants catalog authority. Any ambiguous termination stays closed.
  """

  alias Lattice.Log
  alias LatticeCarrierServer.{Durability, Manifest, Runtime}
  alias LatticeCarrierServer.Operator.ReleaseGate

  @spec stop_and_seal(ReleaseGate.owner(), map(), non_neg_integer()) ::
          {:ok, map()} | {:error, term()}
  def stop_and_seal(owner, receipt, timeout \\ 5_000) do
    deadline = System.monotonic_time(:millisecond) + timeout

    task = Task.async(fn -> controlled_stop(owner, receipt, deadline) end)

    case Task.yield(task, remaining(deadline)) do
      {:ok, result} ->
        result

      nil ->
        # The gate monitors this coordinator. Killing it prevents any late
        # seal, even if the supervisor finishes an already queued shutdown.
        Task.shutdown(task, :brutal_kill)
        {:error, :release_timeout}
    end
  end

  defp controlled_stop(owner, receipt, deadline) do
    with %{owner: ^owner} = deployment <- Runtime.deployment(),
         true <- not Map.get(deployment, :uncontrolled_routes?, false),
         {:ok, snapshot} <- ReleaseGate.begin_stop(owner, receipt),
         true <- snapshot.expected == receipt.evidence.manifest,
         :ok <- stop_routes(snapshot.expected.instances, deployment.health, deadline),
         :ok <- wait_stopped(snapshot.expected.instances, deployment.health, deadline),
         :ok <- verify_bytes(deployment, receipt),
         {:ok, observation} <- seal_when_stopped(owner, receipt, deadline) do
      {:ok, observation}
    else
      {:error, _} = refusal -> refusal
      _ -> {:error, :release_stop_refused}
    end
  rescue
    _ -> {:error, :release_stop_refused}
  catch
    :exit, _ -> {:error, :release_stop_refused}
  end

  defp stop_routes(instances, health, deadline) do
    ids = Enum.map(instances, &{LatticeCarrierServer, &1.name})
    ids = if health, do: ids ++ [LatticeCarrierServer.Health.child_spec(health).id], else: ids

    Enum.reduce_while(ids, :ok, fn id, :ok ->
      if remaining(deadline) == 0 do
        {:halt, {:error, :release_timeout}}
      else
        case Supervisor.terminate_child(LatticeCarrierServer.RuntimeSupervisor, id) do
          :ok -> {:cont, :ok}
          {:error, :not_found} -> {:halt, {:error, :release_stop_refused}}
          {:error, reason} -> {:halt, {:error, {:release_stop_failed, reason}}}
        end
      end
    end)
  end

  defp wait_stopped(instances, health, deadline) do
    with true <- remaining(deadline) > 0,
         {:ok, children} <- children(),
         true <- Enum.all?(instances, &stopped_child?(children, {LatticeCarrierServer, &1.name})),
         true <-
           health == nil or
             stopped_child?(children, LatticeCarrierServer.Health.child_spec(health).id) do
      # The gate processes monitored DOWNs asynchronously; its final seal
      # checks that every route, listener and holder departed normally.
      :ok
    else
      false -> {:error, :release_stop_refused}
      {:error, _} = error -> error
    end
  end

  defp seal_when_stopped(owner, receipt, deadline) do
    case ReleaseGate.seal(owner, receipt, %{routes: :stopped, deadline: deadline}) do
      {:error, :release_closed} = error ->
        if remaining(deadline) > 0 do
          Process.sleep(5)
          seal_when_stopped(owner, receipt, deadline)
        else
          error
        end

      result ->
        result
    end
  end

  defp children do
    {:ok, Supervisor.which_children(LatticeCarrierServer.RuntimeSupervisor)}
  end

  defp stopped_child?(children, id) do
    Enum.any?(children, fn
      {^id, :undefined, _, _} -> true
      _ -> false
    end)
  end

  defp verify_bytes(deployment, receipt) do
    expected = receipt.evidence.manifest

    with true <- Runtime.deployment() == deployment,
         true <- deployment.manifest_path == expected.manifest_path,
         {:ok, bytes} <- File.read(expected.manifest_path),
         true <- :crypto.hash(:sha256, bytes) == expected.manifest_digest,
         true <- deployment.manifest_digest == expected.manifest_digest,
         {:ok, manifest} <- Manifest.load(expected.manifest_path),
         true <- manifest.sha256 == expected.manifest_digest,
         true <-
           Enum.map(manifest.instances, &Map.take(&1, [:name, :realm, :pub, :log_file])) ==
             Enum.map(expected.instances, &Map.take(&1, [:name, :realm, :pub, :log_file])),
         true <- length(receipt.evidence.logs) == length(expected.instances),
         true <-
           Enum.zip(expected.instances, receipt.evidence.logs)
           |> Enum.all?(fn {instance, captured} -> verify_log(instance, captured) end) do
      :ok
    else
      _ -> {:error, :release_bytes_changed}
    end
  end

  defp verify_log(instance, captured) do
    case Durability.with_target_lock(
           instance.log_file,
           fn -> Log.restore_verified(instance.log_file) end,
           retries: 0
         ) do
      {:ok, %{log: log, sha256: sha256}} ->
        captured.name == instance.name and captured.path == instance.log_file and
          captured.replica == instance.replica and captured.sha256 == sha256 and
          log.replica == instance.replica and captured.frontier == Enum.sort(Log.frontier(log))

      _ ->
        false
    end
  end

  defp remaining(deadline), do: max(deadline - System.monotonic_time(:millisecond), 0)
end
