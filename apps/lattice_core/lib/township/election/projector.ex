defmodule Township.Election.Projector do
  @moduledoc false

  alias Lattice.{Authority, Canonical, Dag, Log, Op}
  alias Township.{Election, ElectionBoard}

  alias Township.Election.{
    ArtifactRef,
    BoardSnapshot,
    ProfileRef,
    Projection,
    SecurityProfile,
    Spec
  }

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

  @spec project(Spec.t(), BoardSnapshot.t(), map()) :: Projection.t()
  def project(spec, snapshot, resolved_artifacts) do
    case foundation_view(spec, snapshot, resolved_artifacts) do
      {:ok, view} ->
        status =
          case view.findings do
            [] -> {:pending, sort_terms([:profile_unselected | view.requirements])}
            invalid -> {:invalid, invalid}
          end

        projection(view.link.election_id, status, view.rejected)

      {:error, reason} ->
        invalid_projection(reason)
    end
  rescue
    _ -> invalid_projection(:malformed_projection_input)
  end

  @doc false
  @spec foundation_view(Spec.t(), BoardSnapshot.t(), map()) :: {:ok, map()} | {:error, atom()}
  def foundation_view(%Spec{} = asserted_spec, %BoardSnapshot{} = snapshot, resolved_artifacts)
      when is_map(resolved_artifacts) do
    with {:ok, spec} <- Spec.new(Map.from_struct(asserted_spec)),
         :ok <- validate_snapshot(snapshot),
         {:ok, link} <-
           Election.verify_link(spec, snapshot.matter_log, snapshot.matter_link_op_id),
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

  def foundation_view(_spec, _snapshot, _resolved_artifacts),
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

  defp valid_op?(op) do
    Op.valid?(op)
  rescue
    _ -> false
  end

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

  defp invalid_projection(reason) do
    projection(nil, {:invalid, [%{reason: reason}]}, [])
  end

  defp sort_terms(terms), do: Enum.sort_by(terms, &Canonical.term/1)
  defp printable_id(id) when is_binary(id), do: id
  defp printable_id(id), do: inspect(id)
end
