defmodule Township.Election.ClosePolicy.UnanimousBoxesV1 do
  @moduledoc """
  Pure verifier for the conservative unanimous-box close contract.

  The supplied open certificate id is an asserted administrative prerequisite;
  this module does not verify setup, roster, or a cryptographic construction and
  its evidence is never promoted to election finality by the research projector.
  """

  alias Lattice.{Canonical, Dag, Identity, Log, Op}

  alias Township.Election.{
    ArtifactCodec,
    ArtifactRef,
    BoardSnapshot,
    CloseEvidence,
    Projector,
    Spec
  }

  @seal_schema "township-election-box-seal-v1"
  @manifest_schema "township-election-close-manifest-v1"
  @certificate_schema "township-election-close-certificate-v1"
  @signature_domain "township-election-close-signature-v1"

  @type verdict ::
          {:ok, CloseEvidence.t()}
          | {:pending, [term()]}
          | {:invalid, [map()]}
          | {:forked, [map()]}

  @spec verify(Spec.t(), BoardSnapshot.t(), map(), String.t()) :: verdict()
  def verify(%Spec{} = spec, %BoardSnapshot{} = snapshot, artifacts, open_certificate_id)
      when is_map(artifacts) and is_binary(open_certificate_id) and
             byte_size(open_certificate_id) > 0 do
    case Projector.foundation_view(spec, snapshot, artifacts) do
      {:ok, %{findings: [_ | _] = findings}} ->
        {:invalid, sort_terms(findings)}

      {:ok, %{requirements: [_ | _] = requirements}} ->
        {:pending, sort_terms(requirements)}

      {:ok, view} ->
        verify_view(view, snapshot, open_certificate_id)

      {:error, reason} ->
        {:invalid, [%{reason: reason}]}
    end
  rescue
    _ -> {:invalid, [%{reason: :noncanonical_artifact}]}
  end

  def verify(_spec, _snapshot, _artifacts, _open_certificate_id),
    do: {:invalid, [%{reason: :noncanonical_artifact}]}

  @spec box_id(binary()) :: String.t()
  def box_id(public_key) when is_binary(public_key),
    do: Base.url_encode64(public_key, padding: false)

  @spec signature_payload(String.t(), String.t()) :: binary()
  def signature_payload(election_id, manifest_digest)
      when is_binary(election_id) and is_binary(manifest_digest) do
    Canonical.term([@signature_domain, election_id, manifest_digest])
  end

  @spec seal_document(String.t(), binary(), String.t(), [map()]) :: map()
  def seal_document(election_id, box_public_key, open_certificate_id, ballots) do
    raw_seal_document(
      election_id,
      box_id(box_public_key),
      open_certificate_id,
      Enum.map(ballots, &ballot_entry/1)
    )
  end

  @spec manifest_document(String.t(), String.t(), [map()], [map()]) :: map()
  def manifest_document(election_id, open_certificate_id, seals, ballots) do
    raw_manifest_document(
      election_id,
      open_certificate_id,
      Enum.map(seals, &seal_entry/1),
      Enum.map(ballots, &ballot_entry/1)
    )
  end

  @spec certificate_document(String.t(), ArtifactRef.t(), [{binary(), binary()}]) :: map()
  def certificate_document(election_id, %ArtifactRef{} = manifest_ref, signatures) do
    %{
      "schema" => @certificate_schema,
      "election_id" => election_id,
      "manifest_ref" => ArtifactRef.to_canonical_term(manifest_ref),
      "signatures" =>
        signatures
        |> Enum.map(fn {public_key, signature} ->
          %{"box_id" => box_id(public_key), "signature" => signature}
        end)
        |> sort_terms()
    }
  end

  defp verify_view(view, snapshot, open_certificate_id) do
    records = Map.new(view.artifact_records, &{&1.op_id, &1})
    ballots = collect_ballots(view.commands, records)

    with {:ok, seals, seal_rejected} <-
           collect_seals(
             view.commands,
             records,
             ballots,
             view.safe_log,
             view.link.election_id,
             open_certificate_id
           ),
         :ok <- require_all_boxes(view.spec.ballot_boxes, seals, seal_rejected),
         {:ok, manifests, manifest_rejected} <-
           collect_manifests(
             view.commands,
             records,
             seals,
             view.safe_log,
             view.link.election_id,
             open_certificate_id,
             view.spec.ballot_boxes
           ),
         protocol_rejected = seal_rejected ++ manifest_rejected,
         :ok <- require_manifest(manifests, protocol_rejected),
         {:ok, attests, attest_rejected} <-
           collect_attests(
             view.commands,
             manifests,
             view.safe_log,
             view.link.election_id,
             view.spec.ballot_boxes
           ),
         {:ok, candidates, pending, rejected} <-
           collect_candidates(
             view.commands,
             manifests,
             attests,
             view.safe_log,
             view.spec,
             snapshot.max_artifact_byte_size
           ) do
      decide(
        candidates,
        pending,
        protocol_rejected ++ attest_rejected ++ rejected,
        attests,
        box_seal_equivocation?(seals),
        view,
        open_certificate_id
      )
    else
      {:pending, requirements} -> {:pending, sort_terms(requirements)}
      {:invalid, findings} -> {:invalid, sort_terms(findings)}
    end
  end

  defp collect_ballots(commands, records) do
    for {%Op{} = op, :submit_ballot, _args} <- commands,
        %{ref: ref, bytes: bytes} <- [Map.fetch!(records, op.id)] do
      %{op: op, ref: ref, bytes: bytes}
    end
  end

  defp collect_seals(commands, records, ballots, log, election_id, open_id) do
    {valid, findings} =
      for(
        {%Op{} = op, :publish_box_seal, _args} <- commands,
        do: {op, Map.fetch!(records, op.id)}
      )
      |> Enum.reduce({[], []}, fn {op, record}, {valid, findings} ->
        ancestors = Dag.ancestors(Log.ops(log), op.id)

        expected_ballots =
          Enum.filter(ballots, fn ballot ->
            ballot.op.author == op.author and MapSet.member?(ancestors, ballot.op.id)
          end)

        expected = seal_document(election_id, op.author, open_id, expected_ballots)

        case ArtifactCodec.decode(record.bytes) do
          {:ok, ^expected} ->
            seal = %{
              op: op,
              ref: record.ref,
              box_public_key: op.author,
              box_id: box_id(op.author),
              ballot_entries: expected["ballots"]
            }

            {[seal | valid], findings}

          {:ok, _other} ->
            {valid, [%{op_id: op.id, reason: :checkpoint_incomplete} | findings]}

          {:error, reason} ->
            {valid, [%{op_id: op.id, reason: reason} | findings]}
        end
      end)

    {:ok, group_seals(valid), sort_terms(findings)}
  end

  defp group_seals(seals) do
    seals
    |> Enum.group_by(&{&1.box_id, &1.ref.digest})
    |> Enum.map(fn {{box_id, digest}, entries} ->
      first = hd(entries)

      %{
        box_id: box_id,
        box_public_key: first.box_public_key,
        digest: digest,
        ballot_entries: first.ballot_entries,
        op_ids: entries |> Enum.map(& &1.op.id) |> Enum.sort()
      }
    end)
    |> Enum.sort_by(&{&1.box_id, &1.digest})
  end

  defp require_all_boxes(boxes, seals, rejected) do
    missing =
      boxes
      |> Enum.map(&box_id/1)
      |> Enum.reject(fn id -> Enum.any?(seals, &(&1.box_id == id)) end)
      |> Enum.map(&{:box_seal_missing, &1})

    cond do
      missing == [] -> :ok
      rejected == [] -> {:pending, missing}
      true -> {:invalid, rejected}
    end
  end

  defp collect_manifests(commands, records, seals, log, election_id, open_id, boxes) do
    {valid, findings} =
      for({%Op{} = op, :propose_close, _args} <- commands, do: {op, Map.fetch!(records, op.id)})
      |> Enum.reduce({[], []}, fn {op, record}, {valid, findings} ->
        case ArtifactCodec.decode(record.bytes) do
          {:ok, document} ->
            case validate_manifest(
                   document,
                   op,
                   record.ref,
                   seals,
                   log,
                   election_id,
                   open_id,
                   boxes
                 ) do
              {:ok, manifest} -> {[manifest | valid], findings}
              {:error, reason} -> {valid, [%{op_id: op.id, reason: reason} | findings]}
            end

          {:error, reason} ->
            {valid, [%{op_id: op.id, reason: reason} | findings]}
        end
      end)

    manifests =
      valid
      |> Enum.group_by(& &1.ref.digest)
      |> Map.new(fn {digest, entries} ->
        first = hd(entries)

        {digest,
         %{
           first
           | proposal_op_ids: entries |> Enum.map(& &1.op.id) |> Enum.sort(),
             refs: entries |> Enum.map(& &1.ref) |> Enum.uniq()
         }}
      end)

    {:ok, manifests, sort_terms(findings)}
  end

  defp validate_manifest(document, proposal_op, ref, seals, log, election_id, open_id, boxes) do
    with %{
           "schema" => @manifest_schema,
           "election_id" => ^election_id,
           "open_certificate_id" => ^open_id,
           "seals" => seal_entries,
           "ballots" => ballot_entries
         } <- document,
         true <- map_size(document) == 5,
         true <- is_list(seal_entries) and is_list(ballot_entries),
         {:ok, selected} <- select_seals(seal_entries, seals, boxes),
         true <- selected_seals_visible?(selected, proposal_op, log),
         expected_ballots =
           selected |> Enum.flat_map(& &1.ballot_entries) |> Enum.uniq() |> sort_terms(),
         expected =
           raw_manifest_document(election_id, open_id, seal_entries, expected_ballots),
         true <- document == expected do
      {:ok,
       %{
         op: proposal_op,
         ref: ref,
         document: document,
         selected_seals: selected,
         ballot_entries: expected_ballots,
         proposal_op_ids: [proposal_op.id],
         refs: [ref]
       }}
    else
      _ -> {:error, :checkpoint_incomplete}
    end
  end

  defp select_seals(entries, seals, required_boxes) do
    boxes = entries |> Enum.map(&Map.get(&1, "box_id"))
    required_ids = required_boxes |> Enum.map(&box_id/1) |> Enum.sort()

    selected =
      Enum.map(entries, fn
        %{"box_id" => box, "seal_digest" => digest} = entry when map_size(entry) == 2 ->
          Enum.find(seals, &(&1.box_id == box and &1.digest == digest))

        _other ->
          nil
      end)

    cond do
      entries != sort_terms(entries) -> {:error, :checkpoint_incomplete}
      length(entries) != length(Enum.uniq(boxes)) -> {:error, :checkpoint_incomplete}
      Enum.sort(boxes) != required_ids -> {:error, :checkpoint_incomplete}
      Enum.any?(selected, &is_nil/1) -> {:error, :checkpoint_incomplete}
      true -> {:ok, selected}
    end
  end

  defp selected_seals_visible?(selected, proposal_op, log) do
    ancestors = Dag.ancestors(Log.ops(log), proposal_op.id)
    Enum.all?(selected, fn seal -> Enum.any?(seal.op_ids, &MapSet.member?(ancestors, &1)) end)
  end

  defp require_manifest(manifests, []) when map_size(manifests) == 0,
    do: {:pending, [:close_manifest_missing]}

  defp require_manifest(manifests, rejected) when map_size(manifests) == 0,
    do: {:invalid, rejected}

  defp require_manifest(_manifests, _rejected), do: :ok

  defp collect_attests(commands, manifests, log, election_id, boxes) do
    box_set = MapSet.new(boxes)

    {valid, findings} =
      for(
        {%Op{} = op, :attest_close, [_election_id, digest, signature]} <- commands,
        do: {op, digest, signature}
      )
      |> Enum.reduce({[], []}, fn {op, digest, signature}, {valid, findings} ->
        manifest = Map.get(manifests, digest)
        ancestors = Dag.ancestors(Log.ops(log), op.id)

        valid_attest? =
          is_binary(digest) and is_binary(signature) and
            MapSet.member?(box_set, op.author) and is_map(manifest) and
            Enum.any?(manifest.proposal_op_ids, &MapSet.member?(ancestors, &1)) and
            Identity.verify(op.author, signature_payload(election_id, digest), signature)

        if valid_attest? do
          {[%{op: op, digest: digest, signature: signature, box_id: box_id(op.author)} | valid],
           findings}
        else
          {valid, [%{op_id: op.id, reason: :invalid_role_signature} | findings]}
        end
      end)

    {:ok, valid, sort_terms(findings)}
  end

  defp collect_candidates(commands, manifests, attests, log, spec, max_byte_size) do
    cert_commands =
      for {%Op{} = op, :certify_close, [_election_id, certificate]} <- commands,
          do: {op, certificate}

    if cert_commands == [] do
      {:ok, [], [:close_certificate_missing], []}
    else
      {candidates, pending, rejected} =
        Enum.reduce(cert_commands, {[], [], []}, fn {op, certificate}, acc ->
          collect_candidate(op, certificate, manifests, attests, log, spec, max_byte_size, acc)
        end)

      {:ok, candidates, Enum.uniq(pending), rejected}
    end
  end

  defp collect_candidate(
         op,
         certificate,
         manifests,
         attests,
         log,
         spec,
         max_byte_size,
         {candidates, pending, rejected}
       ) do
    case validate_certificate(certificate, op, manifests, attests, log, spec, max_byte_size) do
      {:ok, candidate} -> {[candidate | candidates], pending, rejected}
      {:pending, requirements} -> {candidates, requirements ++ pending, rejected}
      {:error, reason} -> {candidates, pending, [%{op_id: op.id, reason: reason} | rejected]}
    end
  end

  defp validate_certificate(certificate, op, manifests, attests, log, spec, max_byte_size) do
    with %{
           "schema" => @certificate_schema,
           "election_id" => election_id,
           "manifest_ref" => ref_term,
           "signatures" => signature_entries
         } <- certificate,
         true <- map_size(certificate) == 4,
         ^election_id <- hd(elem(op.body, 1)),
         {:ok, manifest_ref} <-
           ArtifactRef.from_canonical_term(ref_term, max_byte_size: max_byte_size),
         {:ok, manifest} <- fetch_manifest(manifests, manifest_ref),
         {:ok, signatures} <- validate_signature_entries(signature_entries, spec.ballot_boxes),
         :ok <-
           validate_certificate_signatures(signatures, manifest, attests, op, log, election_id),
         expected =
           certificate_document(
             election_id,
             manifest_ref,
             Enum.map(signatures, fn {pub, signature} -> {pub, signature} end)
           ),
         true <- certificate == expected do
      {:ok, %{op: op, manifest: manifest}}
    else
      {:pending, _requirements} = pending -> pending
      {:error, reason} -> {:error, reason}
      _ -> {:error, :invalid_role_signature}
    end
  rescue
    _ -> {:error, :noncanonical_artifact}
  end

  defp fetch_manifest(manifests, %ArtifactRef{} = ref) do
    case Map.fetch(manifests, ref.digest) do
      {:ok, manifest} ->
        if Enum.any?(manifest.refs, &same_artifact_identity?(&1, ref)),
          do: {:ok, %{manifest | ref: ref}},
          else: {:error, :artifact_digest_mismatch}

      :error ->
        {:pending, [{:manifest_proposal_missing, ref.digest}]}
    end
  end

  defp same_artifact_identity?(%ArtifactRef{} = left, %ArtifactRef{} = right) do
    left.digest == right.digest and left.byte_size == right.byte_size and
      left.codec == right.codec and left.profile == right.profile
  end

  defp validate_signature_entries(entries, boxes) when is_list(entries) do
    by_id = Map.new(boxes, &{box_id(&1), &1})

    parsed =
      Enum.map(entries, fn
        %{"box_id" => id, "signature" => signature} = entry when map_size(entry) == 2 ->
          case Map.fetch(by_id, id) do
            {:ok, pub} when is_binary(signature) -> {pub, signature}
            _ -> nil
          end

        _other ->
          nil
      end)

    missing =
      boxes
      |> Enum.reject(fn pub -> Enum.any?(parsed, &match?({^pub, _signature}, &1)) end)
      |> Enum.map(&{:close_signature_missing, box_id(&1)})

    cond do
      missing != [] -> {:pending, missing}
      length(entries) != length(boxes) -> {:error, :invalid_role_signature}
      Enum.any?(parsed, &is_nil/1) -> {:error, :invalid_role_signature}
      true -> {:ok, parsed}
    end
  end

  defp validate_signature_entries(_entries, _boxes), do: {:error, :invalid_role_signature}

  defp validate_certificate_signatures(signatures, manifest, attests, certificate_op, log, eid) do
    ancestors = Dag.ancestors(Log.ops(log), certificate_op.id)

    valid? =
      Enum.all?(signatures, fn {pub, signature} ->
        Identity.verify(pub, signature_payload(eid, manifest.ref.digest), signature) and
          Enum.any?(attests, fn attest ->
            attest.op.author == pub and attest.digest == manifest.ref.digest and
              attest.signature == signature and MapSet.member?(ancestors, attest.op.id)
          end)
      end)

    if valid?, do: :ok, else: {:error, :invalid_role_signature}
  end

  defp decide(candidates, pending, rejected, attests, seal_equivocation?, view, open_id) do
    grouped = Enum.group_by(candidates, & &1.manifest.ref.digest)

    cond do
      map_size(grouped) > 1 ->
        digests = grouped |> Map.keys() |> Enum.sort()
        {:forked, [%{reason: :forked_close, manifest_digests: digests}]}

      seal_equivocation? ->
        {:invalid, [%{reason: :box_equivocation}]}

      map_size(grouped) == 0 ->
        if rejected == [] do
          {:pending,
           sort_terms(if(pending == [], do: [:close_certificate_missing], else: pending))}
        else
          {:invalid, sort_terms(rejected)}
        end

      box_equivocation?(attests) ->
        {:invalid, [%{reason: :box_equivocation}]}

      true ->
        [{digest, entries}] = Map.to_list(grouped)
        manifest = hd(entries).manifest

        evidence = %CloseEvidence{
          election_id: view.link.election_id,
          open_certificate_id: open_id,
          manifest_digest: digest,
          ballot_wrapper_ids: manifest.ballot_entries |> Enum.map(& &1["op_id"]) |> Enum.sort(),
          ballot_digests:
            manifest.ballot_entries
            |> Enum.map(& &1["artifact_digest"])
            |> Enum.uniq()
            |> Enum.sort(),
          seal_digests: manifest.selected_seals |> Enum.map(& &1.digest) |> Enum.sort(),
          certificate_op_ids: entries |> Enum.map(& &1.op.id) |> Enum.sort(),
          prerequisite: :administrative_open_asserted,
          rejected: sort_terms(view.rejected ++ rejected)
        }

        {:ok, evidence}
    end
  end

  defp box_equivocation?(attests) do
    attests
    |> Enum.group_by(& &1.box_id, & &1.digest)
    |> Enum.any?(fn {_box, digests} -> length(Enum.uniq(digests)) > 1 end)
  end

  defp box_seal_equivocation?(seals) do
    seals
    |> Enum.group_by(& &1.box_id, & &1.digest)
    |> Enum.any?(fn {_box, digests} -> length(Enum.uniq(digests)) > 1 end)
  end

  defp ballot_entry(%{op: %Op{id: op_id}, ref: %ArtifactRef{digest: digest}}) do
    %{"op_id" => op_id, "artifact_digest" => digest}
  end

  defp seal_entry(%{box_pub: pub, ref: %ArtifactRef{digest: digest}}),
    do: %{"box_id" => box_id(pub), "seal_digest" => digest}

  defp raw_seal_document(election_id, box, open_id, ballots) do
    %{
      "schema" => @seal_schema,
      "election_id" => election_id,
      "box_id" => box,
      "open_certificate_id" => open_id,
      "ballots" => ballots |> Enum.uniq() |> sort_terms()
    }
  end

  defp raw_manifest_document(election_id, open_id, seals, ballots) do
    %{
      "schema" => @manifest_schema,
      "election_id" => election_id,
      "open_certificate_id" => open_id,
      "seals" => seals |> Enum.uniq() |> sort_terms(),
      "ballots" => ballots |> Enum.uniq() |> sort_terms()
    }
  end

  defp sort_terms(terms), do: Enum.sort_by(terms, &Canonical.term/1)
end
