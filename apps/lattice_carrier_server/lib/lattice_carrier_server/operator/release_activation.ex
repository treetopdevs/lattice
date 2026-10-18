defmodule LatticeCarrierServer.Operator.ReleaseActivation do
  @moduledoc """
  Local manifest activation for one sealed, controlled release (operator
  decision D1: route activation is local-only).

  Only a live stop-and-seal observation of this incarnation, taken for the
  pending record's own attempt over the exact manifest that record staged
  against, may ask the Python mutation owner to replace that manifest with the
  staged candidate. The owner rechecks every byte and remains the only writer.

  The plan carries the incarnation marker the sealed boot received from the
  owner (`Runtime.prepare_owned/4` with an operator root), and the owner
  refuses it unless that boot is still the latest controlled boot. A restart
  that completed first wrote a new marker; one that begins while the owner
  holds the lock refuses to boot. A boot that finds the candidate already
  active under this pending record (the owner died between the replace and
  the commit) records it activated itself, so no new seal is needed.
  A release booted without an operator root has no marker and never activates.

  Staging reviewed the Space roster at stage time; activation re-reviews it
  from the sealed, verified Space log and refuses `:roster_drift_since_staging`
  unless the staged child's reviewed grant recipients and the admitted
  instance's bootstrap peers (that roster plus the child root) still match it.

  Activation does not reopen admission or restart a route: the sealed
  incarnation stays closed, and the new route set is served only after a full
  application restart. It signs nothing, generates no identity, resets no log,
  and is neither readiness, catalog publication nor catalog replacement.
  """
  alias LatticeCarrierServer.Operator.{Journal, Lock, ReleaseGate, Staging}
  alias Lattice.Log
  alias LatticeCarrierServer.{Durability, Manifest, Runtime}

  @spec activate(Path.t(), binary() | nil, ReleaseGate.owner(), map()) ::
          {:ok, map()} | {:error, term()}
  def activate(root, expected, owner, observation) do
    # One deployment snapshot supplies both the sealed owner and the marker,
    # so a restart between the two can never lend this seal a newer boot's
    # marker; it makes the captured one stale instead.
    with {:ok, deployment} <- sealed(owner, observation),
         {:ok, incarnation} <- guarded(root, deployment),
         %{attempt: attempt, evidence: %{manifest: manifest, logs: logs}} = observation.receipt,
         {:ok, ^expected} <- current(root),
         {:ok, %{"phase" => "carrier_pending"} = record} <- pending(expected),
         :ok <- same(attempt == record["attempt"], :release_attempt_mismatch),
         digest = Base.encode16(manifest.manifest_digest, case: :lower),
         :ok <- same(digest == record["manifest_digest"], :release_manifest_mismatch),
         :ok <- same(Journal.service_identity_current?(record["service"]), :stale_operator_intent),
         {:ok, admitted} <- identities_current(record, manifest.instances),
         {:ok, restored} <- logs_current(manifest.instances, logs),
         :ok <- roster_current(record, admitted, restored),
         next = Map.put(record, "phase", "activated"),
         :ok <-
           Lock.activate(
             root,
             expected,
             attempt,
             %{path: manifest.manifest_path, sha256: digest},
             Enum.map(logs, &%{path: &1.path, sha256: &1.sha256}),
             Journal.encode(next),
             incarnation
           ) do
      {:ok, next}
    else
      {:ok, _other} -> {:error, :stale_operator_intent}
      {:error, _} = refusal -> refusal
      _ -> {:error, :release_activation_refused}
    end
  rescue
    _ -> {:error, :release_activation_refused}
  catch
    :exit, _ -> {:error, :release_activation_refused}
  end

  defp sealed(owner, observation) do
    with %{owner: ^owner} = deployment <- Runtime.deployment(),
         true <- ReleaseGate.sealed?(owner, observation) do
      {:ok, deployment}
    else
      _ -> {:error, :release_not_sealed}
    end
  end

  defp guarded(root, deployment) do
    with %{operator_root: guarded_root, incarnation: incarnation} when is_binary(incarnation) <-
           deployment,
         true <- guarded_root == Path.expand(root) do
      {:ok, incarnation}
    else
      _ -> {:error, :release_boot_unguarded}
    end
  end

  # The journal binds only the admitted instance's identity. Every route the
  # seal captured must still derive its sealed key from the candidate's
  # identity files, or the restarted release would serve a different key.
  defp identities_current(record, sealed) do
    [candidate] = Enum.filter(record["artifacts"], &(&1["kind"] == "manifest"))
    inventory = &Map.take(&1, [:name, :realm, :pub, :log_file])

    with {:ok, manifest} <- Manifest.load(candidate["path"]),
         served = Enum.map(manifest.instances, inventory),
         [admitted] <- served -- Enum.map(sealed, inventory),
         true <- Base.encode64(admitted.pub) == record["service"]["pub"] do
      {:ok, Enum.find(manifest.instances, &(inventory.(&1) == admitted))}
    else
      _ -> {:error, :release_identity_changed}
    end
  end

  # Every sealed route log must still be the exact verified history the seal
  # captured; the owner rechecks the same digests around its replace. The
  # verified logs are returned so the roster re-review reads no file again.
  defp logs_current(instances, logs) when length(logs) == length(instances) do
    Enum.zip(instances, logs)
    |> Enum.reduce_while({:ok, []}, fn {instance, sealed}, {:ok, restored} ->
      case log_current(instance, sealed) do
        {:ok, log} -> {:cont, {:ok, restored ++ [log]}}
        _ -> {:halt, {:error, :release_bytes_changed}}
      end
    end)
  end

  defp logs_current(_instances, _logs), do: {:error, :release_bytes_changed}

  defp log_current(instance, sealed) do
    case Durability.with_target_lock(
           instance.log_file,
           fn -> Log.restore_verified(instance.log_file) end,
           retries: 0
         ) do
      {:ok, %{log: log, sha256: sha256}} ->
        if sealed.name == instance.name and sealed.path == instance.log_file and
             sealed.replica == instance.replica and log.replica == instance.replica and
             sealed.sha256 == sha256 and sealed.frontier == Enum.sort(Log.frontier(log)),
           do: {:ok, log},
           else: :changed

      _ ->
        :changed
    end
  end

  # The roster staging reviewed must still be the sealed Space's roster: the
  # child grants exactly its members and the admitted instance bootstraps
  # exactly them plus the child root. The manifest digest binds the instance
  # set, so a Space no longer served by exactly one sealed log is also drift.
  # Child bytes stay the owner's to recheck, as the candidate manifest's are.
  defp roster_current(record, admitted, restored) do
    [reference] = Enum.filter(record["artifacts"], &(&1["kind"] == "reference"))
    [child] = Enum.filter(record["artifacts"], &(&1["kind"] == "log"))

    with {:ok, child_log} <- staged_child(child),
         [space] <- Enum.filter(restored, &(&1.replica == reference["replica"])),
         roster = Staging.roster(space),
         true <- Enum.sort(Enum.map(child["review"]["grants"], & &1["recipient"])) == roster,
         true <- Staging.bootstrap_peers_exact?(admitted, roster, child_log) do
      :ok
    else
      {:error, _} = refusal -> refusal
      _ -> {:error, :roster_drift_since_staging}
    end
  end

  defp staged_child(child) do
    replica = child["replica"]

    case Log.restore_verified(child["path"]) do
      {:ok, %{log: %{replica: ^replica} = log}} -> {:ok, log}
      _ -> {:error, :invalid_staged_signed_artifact}
    end
  end

  defp current(root) do
    case Journal.read(root) do
      {:ok, raw} when is_binary(raw) -> {:ok, raw}
      {:ok, nil} -> {:error, :stale_operator_intent}
      {:error, _} = error -> error
    end
  end

  defp pending(raw) do
    case Journal.decode(raw) do
      {:ok, %{"phase" => "carrier_pending"}} = ok -> ok
      {:ok, _} -> {:error, :operator_journal_not_pending}
      error -> error
    end
  end

  defp same(true, _reason), do: :ok
  defp same(_, reason), do: {:error, reason}
end
