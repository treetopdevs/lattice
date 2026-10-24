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

  @spec activate(Path.t(), binary() | nil, ReleaseGate.owner(), map(), Path.t()) ::
          {:ok, map()} | {:error, term()}
  def activate(root, expected, owner, observation, ceremony_dir) do
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
         {:ok, binding} <- bound(record, manifest.instances, ceremony_dir),
         :ok <- service_bound(record, binding),
         :ok <- same(Journal.service_identity_current?(record["service"]), :stale_operator_intent),
         {:ok, admitted, candidate} <- identities_current(record, manifest.instances),
         {:ok, restored} <- logs_current(manifest.instances, logs),
         {:ok, reviewed} <-
           Staging.roster_current(record, admitted, restored, :roster_drift_since_staging),
         :ok <- bound_candidate(candidate, manifest.instances, restored, reviewed, binding),
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

  # The ceremony binding, read against the sealed instance serving the staged
  # reference's Space.
  defp bound(record, instances, ceremony_dir) do
    [reference] = Enum.filter(record["artifacts"], &(&1["kind"] == "reference"))

    with {:ok, path} <- Staging.space_log_path(instances, reference["replica"]),
         do: Staging.load_binding(ceremony_dir, path)
  end

  # The staged record's service realm and key are the ceremony's, re-derived
  # here: a journal edited after staging can never name a different service.
  defp service_bound(record, binding) do
    service = record["service"]

    same(
      service["realm"] == binding.realm and
        service["pub"] == Base.encode64(binding.record.service_key),
      :service_binding_mismatch
    )
  end

  # The bound-instance rule over the candidate manifest the restart would serve.
  # Sealed instances keep their files; the staged child is the one new log.
  defp bound_candidate(candidate, sealed, restored, reviewed, binding) do
    child = reviewed.child_log
    pairs = Enum.zip(sealed, restored)
    replicas = Map.new(pairs, fn {instance, log} -> {instance.log_file, log.replica} end)

    served =
      Enum.find(candidate, fn instance ->
        not Enum.any?(sealed, &(&1.name == instance.name))
      end)

    replicas = Map.put(replicas, served.log_file, child.replica)

    roots =
      Map.new(
        [{child.replica, Lattice.Authority.root(child)}] ++
          Enum.map(restored, &{&1.replica, Lattice.Authority.root(&1)})
      )

    Staging.check_bound(
      candidate,
      %{
        space_replica: reviewed.space.replica,
        replica_of: &Map.get(replicas, &1.log_file),
        roots: roots,
        roster: reviewed.roster,
        peer_error: :roster_drift_since_staging
      },
      binding
    )
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

  # The journal binds only the admitted instance's identity. Candidate and
  # sealed instances match by name: the one new name is the admitted instance,
  # and every sealed route must still be served from its sealed log. A
  # non-Treehouse route keeps its sealed key and realm; a Treehouse route may
  # have migrated to the bound values, which the bound-instance rule judges.
  defp identities_current(record, sealed) do
    [candidate] = Enum.filter(record["artifacts"], &(&1["kind"] == "manifest"))
    inventory = &Map.take(&1, [:name, :realm, :pub, :log_file])

    with {:ok, manifest} <- Manifest.load(candidate["path"]),
         true <- length(manifest.instances) == length(sealed) + 1,
         true <- Enum.all?(sealed, &route_kept?(&1, manifest.instances, inventory)),
         [admitted] <-
           Enum.reject(manifest.instances, &Enum.any?(sealed, fn s -> s.name == &1.name end)),
         true <- Base.encode64(admitted.pub) == record["service"]["pub"] do
      {:ok, admitted, manifest.instances}
    else
      _ -> {:error, :release_identity_changed}
    end
  end

  defp route_kept?(sealed, candidate, inventory) do
    case Enum.find(candidate, &(&1.name == sealed.name)) do
      nil -> false
      %{log_file: log_file} when log_file != sealed.log_file -> false
      proposed -> treehouse?(sealed.replica) or inventory.(proposed) == inventory.(sealed)
    end
  end

  defp treehouse?("replica:treehouse:" <> _), do: true
  defp treehouse?(_), do: false

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
