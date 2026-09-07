defmodule LatticeCarrierServer.Operator.ReleaseQuiesce do
  @moduledoc """
  Private observation of one controlled release's closed admission and drained
  signed-byte holders. This does not stop a release, activate a manifest, or
  grant catalog authority. Timeouts and ambiguous process identity stay closed.
  """
  alias Lattice.Log
  alias LatticeCarrierServer.{Durability, Listener, Manifest, Runtime}
  alias LatticeCarrierServer.Operator.{Journal, ReleaseGate}

  @spec drain(binary(), map(), non_neg_integer()) :: {:ok, map()} | {:error, term()}
  def drain(attempt, expected, timeout \\ 5_000) do
    deadline = System.monotonic_time(:millisecond) + timeout

    with true <- Journal.nonce?(attempt),
         %{owner: owner} = deployment <- Runtime.deployment(),
         :ok <- validate_expected(expected, deployment),
         {:ok, _} <- ReleaseGate.close(owner, attempt, expected),
         {:ok, snapshot} <- wait_startups(owner, attempt, deadline),
         :ok <- validate_identities(snapshot, expected.instances),
         :ok <- suspend_listeners(expected.instances),
         {:ok, captures} <- capture_holders(owner, snapshot, expected.instances, deadline),
         :ok <- validate_expected(expected, Runtime.deployment()),
         {:ok, current} <- ReleaseGate.snapshot(owner, attempt),
         true <- current == snapshot and remaining(deadline) > 0,
         true <-
           Enum.all?(
             expected.instances,
             &(:ranch.get_status(Listener.ref(&1.name)) == :suspended)
           ),
         {:ok, receipt} <-
           ReleaseGate.commit(
             owner,
             attempt,
             current,
             %{manifest: expected, logs: captures},
             deadline
           ) do
      {:ok, receipt}
    else
      {:error, _} = refusal -> refusal
      _ -> {:error, :release_refused}
    end
  rescue
    _ -> {:error, :release_refused}
  catch
    :exit, _ -> {:error, :release_refused}
  end

  defp validate_expected(expected, deployment) do
    with true <- is_map(expected) and is_map(deployment),
         false <- Map.get(deployment, :uncontrolled_routes?, false),
         true <- Enum.sort(Map.keys(expected)) == [:instances, :manifest_digest, :manifest_path],
         true <- expected.manifest_path == deployment.manifest_path,
         {:ok, bytes} <- File.read(expected.manifest_path),
         true <- :crypto.hash(:sha256, bytes) == expected.manifest_digest,
         true <- expected.manifest_digest == deployment.manifest_digest,
         {:ok, manifest} <- Manifest.load(expected.manifest_path),
         true <- is_list(expected.instances),
         true <-
           Enum.map(expected.instances, &Map.delete(&1, :replica)) ==
             inventory(manifest.instances),
         true <- Enum.all?(expected.instances, &is_binary(&1.replica)),
         true <- inventory(manifest.instances) == inventory(deployment.instances) do
      :ok
    else
      _ -> {:error, :release_inventory_changed}
    end
  end

  defp inventory(instances),
    do: Enum.map(instances, &Map.take(&1, [:name, :realm, :pub, :log_file]))

  defp wait_startups(owner, attempt, deadline) do
    with true <- remaining(deadline) > 0,
         {:ok, snapshot} <- ReleaseGate.snapshot(owner, attempt) do
      if map_size(snapshot.leases) == 0 do
        {:ok, snapshot}
      else
        receive do
        after
          5 -> wait_startups(owner, attempt, deadline)
        end
      end
    else
      false -> {:error, :release_timeout}
      {:error, _} = error -> error
    end
  end

  defp validate_identities(snapshot, instances) do
    expected = [
      :preflight
      | for(
          instance <- instances,
          kind <- [:route, :holder, :listener],
          do: {kind, instance.name}
        )
    ]

    if MapSet.new(Map.keys(snapshot.identities)) == MapSet.new(expected),
      do: :ok,
      else: {:error, :release_inventory_changed}
  end

  defp suspend_listeners(instances) do
    Enum.reduce_while(instances, :ok, fn instance, :ok ->
      case :ranch.suspend_listener(Listener.ref(instance.name)) do
        :ok -> {:cont, :ok}
        {:error, reason} -> {:halt, {:error, {:listener_suspend_failed, reason}}}
      end
    end)
  end

  defp capture_holders(owner, snapshot, instances, deadline) do
    Enum.reduce_while(instances, {:ok, []}, fn instance, {:ok, results} ->
      {holder, _} = Map.fetch!(snapshot.identities, {:holder, instance.name})

      case capture_holder(owner, holder, instance, deadline) do
        {:ok, capture} -> {:cont, {:ok, results ++ [capture]}}
        {:error, _} = refusal -> {:halt, refusal}
      end
    end)
  end

  defp capture_holder(owner, holder, instance, deadline) do
    with true <- remaining(deadline) > 0,
         {:ok, held} <- GenServer.call(holder, {:drain_release, owner}, remaining(deadline)),
         true <- held.holder == holder and held.pub == instance.pub,
         true <- held.source == {:path, instance.log_file},
         {:ok, captured} <-
           Durability.with_target_lock(
             instance.log_file,
             fn -> Log.restore_verified(instance.log_file) end,
             retries: 0
           ),
         true <- captured.log == held.log and captured.log.replica == instance.replica do
      {:ok,
       %{
         name: instance.name,
         path: instance.log_file,
         replica: instance.replica,
         sha256: captured.sha256,
         frontier: Log.frontier(captured.log) |> Enum.sort()
       }}
    else
      _ -> {:error, :release_capture_refused}
    end
  end

  defp remaining(deadline), do: max(deadline - System.monotonic_time(:millisecond), 0)
end
