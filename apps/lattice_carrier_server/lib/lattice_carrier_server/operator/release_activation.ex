defmodule LatticeCarrierServer.Operator.ReleaseActivation do
  @moduledoc """
  Local manifest activation for one sealed, controlled release (operator
  decision D1: route activation is local-only).

  Only a live stop-and-seal observation of this incarnation, taken for the
  pending record's own attempt over the exact manifest that record staged
  against, may ask the Python mutation owner to replace that manifest with the
  staged candidate. The owner rechecks every byte and remains the only writer.

  The owner's plan carries no gate binding: nothing yet stops a full
  application restart while it runs. A seal lost by the time it returns is
  reported, not hidden, and the journal then disagrees with the running
  incarnation until the next controlled restart.

  Activation does not reopen admission or restart a route: the sealed
  incarnation stays closed, and the new route set is served only after a full
  application restart. It signs nothing, generates no identity, resets no log,
  and is neither readiness, catalog publication nor catalog replacement.
  """
  alias LatticeCarrierServer.Operator.{Journal, Lock, ReleaseGate}
  alias Lattice.Log
  alias LatticeCarrierServer.{Durability, Manifest, Runtime}

  @spec activate(Path.t(), binary() | nil, ReleaseGate.owner(), map()) ::
          {:ok, map()} | {:error, term()}
  def activate(root, expected, owner, observation) do
    with :ok <- sealed(owner, observation),
         %{attempt: attempt, evidence: %{manifest: manifest, logs: logs}} = observation.receipt,
         {:ok, ^expected} <- current(root),
         {:ok, %{"phase" => "carrier_pending"} = record} <- pending(expected),
         :ok <- same(attempt == record["attempt"], :release_attempt_mismatch),
         digest = Base.encode16(manifest.manifest_digest, case: :lower),
         :ok <- same(digest == record["manifest_digest"], :release_manifest_mismatch),
         :ok <- same(Journal.service_identity_current?(record["service"]), :stale_operator_intent),
         :ok <- identities_current(record, manifest.instances),
         :ok <- logs_current(manifest.instances, logs),
         next = Map.put(record, "phase", "activated"),
         :ok <-
           Lock.activate(
             root,
             expected,
             attempt,
             %{path: manifest.manifest_path, sha256: digest},
             Enum.map(logs, &%{path: &1.path, sha256: &1.sha256}),
             Journal.encode(next)
           ),
         # The owner holds no gate binding, so a restart while it ran would
         # leave a new incarnation serving the replaced manifest's old bytes.
         :ok <- same(sealed(owner, observation) == :ok, :release_seal_lost_during_activation) do
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
    with %{owner: ^owner} <- Runtime.deployment(),
         true <- ReleaseGate.sealed?(owner, observation) do
      :ok
    else
      _ -> {:error, :release_not_sealed}
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
      :ok
    else
      _ -> {:error, :release_identity_changed}
    end
  end

  # Every sealed route log must still be the exact verified history the seal
  # captured; the owner rechecks the same digests around its replace.
  defp logs_current(instances, logs) do
    if length(logs) == length(instances) and
         Enum.all?(Enum.zip(instances, logs), fn {instance, sealed} ->
           log_current(instance, sealed)
         end),
       do: :ok,
       else: {:error, :release_bytes_changed}
  end

  defp log_current(instance, sealed) do
    case Durability.with_target_lock(
           instance.log_file,
           fn -> Log.restore_verified(instance.log_file) end,
           retries: 0
         ) do
      {:ok, %{log: log, sha256: sha256}} ->
        sealed.name == instance.name and sealed.path == instance.log_file and
          sealed.replica == instance.replica and log.replica == instance.replica and
          sealed.sha256 == sha256 and sealed.frontier == Enum.sort(Log.frontier(log))

      _ ->
        false
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
