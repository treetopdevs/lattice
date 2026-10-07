defmodule Township.Election do
  @moduledoc """
  Public interface for the research-safe Township election foundation.

  `replay/3` verifies the Matter link, the board, and the supplied artifact
  bytes. A successful replay carries a projection that stays in `:setup`. This
  module does not implement a cryptographic election profile and makes no
  coercion-resistance claim.
  """

  alias Lattice.{Authority, Canonical, Dag, Log, Op}
  alias Township.{ElectionBoard, Matter}

  alias Township.Election.{
    ArtifactRef,
    BoardSnapshot,
    Link,
    ProfileRef,
    Projection,
    Replay,
    SecurityProfile,
    Spec
  }

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

  @doc """
  Partial foundation replay over a supplied board and artifact set.

  `{:ok, replay}` carries a projection that stays in `:setup`. `{:error, reason}`
  carries no projection and no board detail. A final projection is a later gate.
  """
  @spec replay(Spec.t(), BoardSnapshot.t(), map()) :: {:ok, Replay.t()} | {:error, atom()}
  def replay(spec, snapshot, resolved_artifacts) do
    with {:ok, walked} <- walk(spec, snapshot, resolved_artifacts) do
      status =
        case walked.findings do
          [] -> {:pending, sort_terms([:profile_unselected | walked.requirements])}
          invalid -> {:invalid, invalid}
        end

      {:ok,
       %Replay{
         projection: projection(walked.link.election_id, status, walked.rejected),
         spec: walked.spec,
         link: walked.link,
         safe_log: walked.safe_log,
         commands: walked.commands,
         artifact_records: walked.artifact_records,
         requirements: walked.requirements,
         findings: walked.findings,
         rejected: walked.rejected
       }}
    end
  rescue
    _ -> {:error, :malformed_projection_input}
  end

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

  @artifact_argument %{
    configure_election: 1,
    publish_setup: 1,
    publish_roster: 1,
    submit_ballot: 1,
    publish_box_seal: 1,
    propose_close: 1,
    publish_protocol_artifact: 5,
    publish_tally: 3
  }

  defp walk(%Spec{} = asserted_spec, %BoardSnapshot{} = snapshot, resolved_artifacts)
       when is_map(resolved_artifacts) do
    with {:ok, spec} <- Spec.new(Map.from_struct(asserted_spec)),
         :ok <- validate_snapshot(snapshot),
         {:ok, link} <- verify_link(spec, snapshot.matter_log, snapshot.matter_link_op_id),
         {:ok, safe_log, structural_rejected} <- validate_board_log(snapshot.board_log),
         :ok <- verify_board_root(spec, safe_log),
         {:ok, commands, command_rejected} <- honored_commands(spec, link.election_id, safe_log),
         {requirements, findings, artifact_rejected, artifact_records} <-
           resolve_artifacts(
             commands,
             resolved_artifacts,
             snapshot.max_artifact_byte_size,
             spec.profile
           ) do
      {:ok,
       %{
         spec: spec,
         link: link,
         safe_log: safe_log,
         commands: commands,
         artifact_records: artifact_records,
         requirements: sort_terms(requirements),
         findings: sort_terms(findings),
         rejected: sort_terms(structural_rejected ++ command_rejected ++ artifact_rejected)
       }}
    end
  rescue
    _ -> {:error, :malformed_projection_input}
  end

  defp walk(_spec, _snapshot, _resolved_artifacts),
    do: {:error, :malformed_projection_input}

  defp validate_snapshot(%BoardSnapshot{
         matter_log: %Log{},
         matter_link_op_id: link_id,
         board_log: %Log{},
         max_artifact_byte_size: max
       })
       when is_binary(link_id) and is_integer(max) and max > 0,
       do: :ok

  defp validate_snapshot(_snapshot), do: {:error, :invalid_board_snapshot}

  defp validate_board_log(%Log{} = log) do
    with {:ok, quarantined} <- verified_board_quarantine(log) do
      ops = Log.ops(log)

      {basic_valid, basic_rejected} =
        ops
        |> Enum.sort_by(fn {id, _op} -> printable_id(id) end)
        |> Enum.reduce({%{}, []}, fn {id, op}, {valid, rejected} ->
          if basic_valid_op?(id, op, log.replica) do
            {Map.put(valid, id, op), rejected}
          else
            {valid, [%{op_id: printable_id(id), reason: :invalid_structure} | rejected]}
          end
        end)

      {verified_ids, closure_rejected} =
        basic_valid
        |> Dag.topo_sort()
        |> Enum.reduce({MapSet.new(), []}, fn op, {verified, rejected} ->
          if Enum.all?(op.deps, &MapSet.member?(verified, &1)) do
            {MapSet.put(verified, op.id), rejected}
          else
            {verified, [%{op_id: op.id, reason: :invalid_structure} | rejected]}
          end
        end)

      valid = Map.take(basic_valid, MapSet.to_list(verified_ids))

      {:ok, Log.from_ops(log.replica, valid),
       sort_terms(basic_rejected ++ closure_rejected ++ quarantined)}
    end
  end

  defp verified_board_quarantine(log) do
    case Log.verified_quarantine(log) do
      {:ok, findings} -> {:ok, sort_terms(findings)}
      {:error, :invalid_structural_quarantine} -> {:error, :invalid_board_quarantine}
    end
  end

  defp basic_valid_op?(id, %Op{} = op, replica) do
    op.id == id and op.replica == replica and proper_binary_list?(op.deps) and valid_op?(op)
  rescue
    _ -> false
  end

  defp basic_valid_op?(_id, _op, _replica), do: false

  defp proper_binary_list?([]), do: true

  defp proper_binary_list?([head | tail]) when is_binary(head),
    do: proper_binary_list?(tail)

  defp proper_binary_list?(_other), do: false

  defp verify_board_root(%Spec{supervisor: supervisor}, log) do
    if Authority.root(log) == supervisor,
      do: :ok,
      else: {:error, :wrong_board_root}
  rescue
    _ -> {:error, :invalid_board_authority}
  end

  defp honored_commands(spec, election_id, log) do
    analysis = Authority.analyze(ElectionBoard, log)

    {commands, rejected} =
      log
      |> Log.topo_ops()
      |> Enum.filter(&(&1.kind == :command))
      |> Enum.reduce({[], []}, fn op, {commands, rejected} ->
        case command_verdict(op, analysis, spec, election_id) do
          {:ok, command, args} -> {[{op, command, args} | commands], rejected}
          {:error, reason} -> {commands, [%{op_id: op.id, reason: reason} | rejected]}
        end
      end)

    {:ok, Enum.reverse(commands), sort_terms(rejected)}
  rescue
    _ -> {:error, :invalid_board_authority}
  end

  defp command_verdict(%Op{} = op, analysis, spec, election_id) do
    with :ok <- authority_verdict(op, analysis),
         {:ok, command, args} <- canonical_command(op),
         :ok <- election_verdict(args, election_id),
         :ok <- publisher_verdict(spec, command, args, op.author) do
      {:ok, command, args}
    end
  end

  defp authority_verdict(%Op{id: id}, analysis) do
    if MapSet.member?(analysis.quarantine, id),
      do: {:error, Map.get(analysis.reasons, id, :unauthorized_publisher)},
      else: :ok
  end

  defp canonical_command(%Op{body: {command, args} = body})
       when is_atom(command) and is_list(args) do
    case ElectionBoard.command_body(command, args) do
      {:ok, ^body} -> {:ok, command, args}
      _other -> {:error, :noncanonical_artifact}
    end
  rescue
    _ -> {:error, :noncanonical_artifact}
  end

  defp canonical_command(_op), do: {:error, :noncanonical_artifact}

  defp election_verdict([election_id | _rest], election_id), do: :ok
  defp election_verdict(_args, _election_id), do: {:error, :wrong_election}

  defp publisher_verdict(spec, :publish_protocol_artifact, args, author) do
    if publisher_allowed?(spec, :publish_protocol_artifact, author) and
         Enum.at(args, 4) == author do
      :ok
    else
      {:error, :unauthorized_publisher}
    end
  end

  defp publisher_verdict(spec, command, _args, author),
    do:
      if(publisher_allowed?(spec, command, author),
        do: :ok,
        else: {:error, :unauthorized_publisher}
      )

  defp publisher_allowed?(spec, command, author)

  defp publisher_allowed?(%Spec{supervisor: author}, command, author)
       when command in [:configure_election, :open_election, :abort_election],
       do: true

  defp publisher_allowed?(%Spec{registration_tellers: tellers}, :publish_roster, author),
    do: author in tellers

  defp publisher_allowed?(%Spec{trustees: trustees}, command, author)
       when command in [:publish_setup, :publish_protocol_artifact, :publish_tally],
       do: author in trustees

  defp publisher_allowed?(%Spec{ballot_boxes: boxes}, command, author)
       when command in [
              :submit_ballot,
              :publish_box_seal,
              :propose_close,
              :attest_close,
              :certify_close
            ],
       do: author in boxes

  defp publisher_allowed?(_spec, _command, _author), do: false

  defp resolve_artifacts(commands, resolved_artifacts, max_byte_size, profile) do
    commands
    |> Enum.flat_map(&artifact_reference/1)
    |> Enum.reduce(
      {[], [], [], []},
      fn {op_id, ref_term}, {requirements, findings, rejected, records} ->
        case ArtifactRef.from_canonical_term(ref_term, max_byte_size: max_byte_size) do
          {:ok, ref} ->
            case artifact_contract(ref, profile) do
              :ok ->
                verify_resolved_artifact(
                  op_id,
                  ref,
                  resolved_artifacts,
                  max_byte_size,
                  requirements,
                  findings,
                  rejected,
                  records
                )

              {:error, reason} ->
                finding = %{op_id: op_id, reason: reason, digest: ref.digest}
                {requirements, [finding | findings], [finding | rejected], records}
            end

          {:error, reason} ->
            finding = %{op_id: op_id, reason: reason}
            {requirements, [finding | findings], [finding | rejected], records}
        end
      end
    )
    |> then(fn {requirements, findings, rejected, records} ->
      {sort_terms(Enum.uniq(requirements)), sort_terms(Enum.uniq(findings)),
       sort_terms(Enum.uniq(rejected)), Enum.sort_by(records, & &1.op_id)}
    end)
  end

  defp artifact_contract(%ArtifactRef{} = ref, %ProfileRef{} = profile) do
    cond do
      ref.profile != ProfileRef.artifact_id(profile) -> {:error, :unsupported_profile}
      ref.codec != ArtifactRef.foundation_codec() -> {:error, :noncanonical_artifact}
      true -> :ok
    end
  end

  defp artifact_reference({%Op{id: op_id}, command, args}) do
    case Map.fetch(@artifact_argument, command) do
      {:ok, index} -> [{op_id, Enum.at(args, index)}]
      :error -> []
    end
  end

  defp verify_resolved_artifact(
         op_id,
         ref,
         resolved_artifacts,
         max_byte_size,
         requirements,
         findings,
         rejected,
         records
       ) do
    case Map.fetch(resolved_artifacts, ref.digest) do
      :error ->
        {[{:artifact_unavailable, ref.digest} | requirements], findings, rejected,
         [%{op_id: op_id, ref: ref, bytes: nil} | records]}

      {:ok, bytes} ->
        case ArtifactRef.verify_bytes(ref, bytes, max_byte_size: max_byte_size) do
          :ok ->
            {requirements, findings, rejected,
             [%{op_id: op_id, ref: ref, bytes: bytes} | records]}

          {:error, reason} ->
            finding = %{op_id: op_id, reason: reason, digest: ref.digest}
            {requirements, [finding | findings], [finding | rejected], records}
        end
    end
  end

  defp projection(election_id, status, rejected) do
    %Projection{
      election_id: election_id,
      phase: :setup,
      status: status,
      close_id: nil,
      rejected: rejected,
      faults: [],
      claim_set_id: SecurityProfile.claim_set_id()
    }
  end

  defp sort_terms(terms), do: Enum.sort_by(terms, &Canonical.term/1)
  defp printable_id(id) when is_binary(id), do: id
  defp printable_id(id), do: inspect(id)
end
