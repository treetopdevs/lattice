defmodule Township.Election do
  @moduledoc """
  Public facade for the research-safe Township election foundation.

  This module currently verifies the Matter-side configuration binding. It does
  not implement a cryptographic election profile and makes no coercion-resistance
  claim.
  """

  alias Lattice.{Authority, Canonical, Log, Op}
  alias Township.Election.{BoardSnapshot, Link, Projection, Projector, Spec}
  alias Township.Matter

  @id_domain "township-election-id-v1"

  @spec election_id(String.t(), String.t()) :: String.t()
  def election_id(spec_digest, matter_link_op_id)
      when is_binary(spec_digest) and is_binary(matter_link_op_id) do
    [@id_domain, spec_digest, matter_link_op_id]
    |> Canonical.term()
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.url_encode64(padding: false)
  end

  @spec verify_link(Spec.t(), Log.t(), String.t()) :: {:ok, Link.t()} | {:error, atom()}
  def verify_link(%Spec{} = spec, %Log{} = matter_log, matter_link_op_id)
      when is_binary(matter_link_op_id) do
    with {:ok, spec} <- Spec.new(Map.from_struct(spec)),
         :ok <- verify_matter_quarantine(matter_log),
         :ok <- verify_subject(spec, matter_log),
         {:ok, op} <- fetch_link(matter_log, matter_link_op_id),
         :ok <- verify_link_structure(matter_log, op),
         spec_digest = Spec.digest(spec),
         :ok <- verify_link_body(op, spec_digest),
         :ok <- verify_link_authority(matter_log, op.id) do
      {:ok,
       %Link{
         election_id: election_id(spec_digest, op.id),
         spec_digest: spec_digest,
         matter_replica_id: matter_log.replica,
         matter_link_op_id: op.id
       }}
    end
  end

  def verify_link(_spec, _matter_log, _matter_link_op_id),
    do: {:error, :invalid_matter_link_context}

  @doc "Pure, total foundation replay over a supplied board and artifact set."
  @spec project(Spec.t(), BoardSnapshot.t(), map()) :: Projection.t()
  def project(spec, snapshot, resolved_artifacts),
    do: Projector.project(spec, snapshot, resolved_artifacts)

  defp verify_subject(%Spec{subject: subject}, %Log{replica: subject}), do: :ok
  defp verify_subject(_spec, _log), do: {:error, :wrong_matter}

  defp verify_matter_quarantine(log) do
    case Log.verified_quarantine(log) do
      {:ok, _findings} -> :ok
      {:error, :invalid_structural_quarantine} -> {:error, :invalid_matter_quarantine}
    end
  end

  defp fetch_link(log, op_id) do
    case Log.fetch(log, op_id) do
      {:ok, %Op{id: ^op_id} = op} -> {:ok, op}
      {:ok, _op} -> {:error, :invalid_matter_link_structure}
      :error -> {:error, :matter_link_missing}
    end
  end

  defp verify_link_structure(log, op) do
    case verify_structural_closure(op.id, log, MapSet.new(), MapSet.new()) do
      {:ok, _verified} -> :ok
      :error -> {:error, :invalid_matter_link_structure}
    end
  rescue
    _ -> {:error, :invalid_matter_link_structure}
  end

  defp verify_structural_closure(op_id, log, verified, visiting) do
    cond do
      MapSet.member?(verified, op_id) ->
        {:ok, verified}

      MapSet.member?(visiting, op_id) ->
        :error

      true ->
        with {:ok, %Op{} = op} <- Log.fetch(log, op_id),
             true <- op.id == op_id,
             true <- op.replica == log.replica,
             true <- valid_op?(op) do
          visiting = MapSet.put(visiting, op_id)

          case verify_dependencies(op.deps, log, verified, visiting) do
            {:ok, next} -> {:ok, MapSet.put(next, op_id)}
            :error -> :error
          end
        else
          _ -> :error
        end
    end
  end

  defp verify_dependencies(deps, log, verified, visiting) do
    Enum.reduce_while(deps, {:ok, verified}, fn dep_id, {:ok, acc} ->
      case verify_structural_closure(dep_id, log, acc, visiting) do
        {:ok, next} -> {:cont, {:ok, next}}
        :error -> {:halt, :error}
      end
    end)
  end

  defp verify_link_body(%{kind: :command, body: {:link_election, [digest]}}, digest), do: :ok
  defp verify_link_body(_op, _digest), do: {:error, :matter_link_mismatch}

  defp verify_link_authority(log, op_id) do
    if MapSet.member?(Authority.quarantine(Matter, log), op_id),
      do: {:error, :unauthorized_matter_link},
      else: :ok
  rescue
    _ -> {:error, :invalid_matter_link_structure}
  end

  defp valid_op?(op) do
    Op.valid?(op)
  rescue
    _ -> false
  end
end
