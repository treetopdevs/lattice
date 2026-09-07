defmodule Treehouse.MemberContinuityAuthoring do
  @moduledoc """
  Authenticated continuity review and ordinary-operation assembly.

  Unsigned intents are private full-judge inputs only. The signer receives bytes
  only after fresh review, certificate verification and the ordinary judgment;
  only an authenticated, publicly rejudged signed frame can leave assembly.
  The caller owns durable frontier/session serialization and enqueue. Retries
  reuse the returned signed frame; this helper never silently refreshes consent.
  """
  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Carrier.Wire
  alias Treehouse.{MemberContinuity, Space}
  alias Treehouse.MemberContinuityCertificate, as: Certificate

  @request_fields ~w(old_pub old_admission new_pub old_membership nonce voucher_admissions author cap_id)a

  @spec review(Log.t(), map()) :: {:ok, map()} | {:error, atom()}
  def review(log, request) do
    with :ok <- request_shape(request),
         {:ok, observed} <- MemberContinuity.observe(log),
         analysis = Authority.analyze(Space, log),
         {:ok, vouchers} <- vouchers(log, analysis, request.voucher_admissions),
         {:ok, epoch, basis} <- epoch(analysis.valid_beacons),
         parents = parent_heads(observed, request.old_pub),
         true <- length(parents) <= 16,
         {:ok, claim} <- claim(log, request, vouchers, epoch, basis, parents),
         candidate = intent(claim, placeholder(claim), request.author, request.cap_id),
         :ok <- envelope_status(candidate),
         :ok <- review_preflight(log, candidate) do
      {:ok,
       %{
         request: request,
         claim: claim,
         claim_id: Certificate.claim_id(claim),
         claim_bytes: Certificate.claim_bytes(claim),
         possession_bytes: Certificate.possession_bytes(claim),
         author: candidate.author,
         cap_id: candidate.cap,
         verified_frontier: claim.deps
       }}
    else
      false -> {:error, :capacity_stop}
      {:error, :invalid_member_continuity} -> {:error, :application_invalid_continuity}
      {:error, reason} -> {:error, reason}
    end
  end

  @spec assemble(Log.t(), map(), map(), Identity.t() | map()) :: {:ok, map()} | {:error, atom()}
  def assemble(log, previous, certificate, signer) do
    with {:ok, request} <- saved_request(previous),
         {:ok, current} <- fresh_review(log, request),
         true <- previous === current,
         :ok <- verify_certificate(certificate, current.claim),
         {:ok, sign} <- signer(signer, current.author),
         candidate = intent(current.claim, certificate, current.author, current.cap_id),
         :ok <- envelope_status(candidate),
         :ok <- preflight(log, candidate),
         {:ok, signature} <- sign(sign, Op.canonical_encoding(candidate)),
         signed = %{candidate | sig: signature},
         :ok <- signed_valid(signed),
         :ok <- envelope_status(signed),
         {:ok, accepted} <- Log.accept(log, signed),
         {:ok, observed} <- MemberContinuity.observe(accepted),
         :ok <- honored(observed, signed.id) do
      {:ok, %{frame: Wire.encode_op(signed), op: signed, claim_id: current.claim_id}}
    else
      false -> {:error, :stale_verified_state}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :invalid_signed_operation}
    end
  end

  @doc "Measure the exact ordinary one-push envelope, including its actual signature bytes."
  @spec envelope_status(Op.t()) :: :ok | {:error, :capacity_stop}
  def envelope_status(%Op{} = op) do
    if byte_size(Jason.encode!(%{"type" => "push", "ops" => [Wire.encode_op(op)]})) <= 64_000,
      do: :ok,
      else: {:error, :capacity_stop}
  end

  defp request_shape(request) when is_map(request) do
    if Enum.sort(Map.keys(request)) == Enum.sort(@request_fields) and
         key?(request.author) and key?(request.old_pub) and key?(request.new_pub) and
         request.old_pub != request.new_pub and key?(request.nonce) and
         id?(request.old_admission) and request.old_membership in [:active, :removed] and
         id?(request.cap_id) and
         is_list(request.voucher_admissions) and length(request.voucher_admissions) == 2 and
         length(Enum.uniq(request.voucher_admissions)) == 2 and
         Enum.all?(request.voucher_admissions, &id?/1),
       do: :ok,
       else: {:error, :application_invalid_continuity}
  end

  defp request_shape(_), do: {:error, :application_invalid_continuity}

  defp vouchers(log, analysis, ids) do
    cond do
      Enum.any?(ids, &(not Map.has_key?(log.ops, &1))) ->
        {:error, :application_target_not_visible}

      Enum.any?(ids, &Map.has_key?(analysis.reasons, &1)) ->
        {:error, :application_target_quarantined}

      true ->
        decode_vouchers(log, ids)
    end
  end

  defp decode_vouchers(log, ids) do
    result =
      Enum.map(ids, fn id ->
        case log.ops[id] do
          %Op{kind: :command, body: {:admit_member, [_, recipient, _, _]}} ->
            with {:ok, pub} <- Base.decode64(recipient),
                 true <- byte_size(pub) == 32 and Base.encode64(pub) == recipient do
              %{member: pub, admission: id}
            else
              _ -> :wrong_target
            end

          _ ->
            :wrong_target
        end
      end)

    if :wrong_target in result,
      do: {:error, :application_wrong_target},
      else: {:ok, Enum.sort_by(result, & &1.member)}
  end

  defp epoch([]), do: {:error, :application_continuity_invalid_epoch}

  defp epoch(beacons) do
    epoch = beacons |> Enum.map(& &1.epoch) |> Enum.max()

    if epoch <= 9_007_199_254_740_991 do
      basis = for %{op_id: id, epoch: value} <- beacons, value == epoch, do: id
      {:ok, epoch, Enum.sort(basis)}
    else
      {:error, :application_continuity_invalid_epoch}
    end
  end

  defp parent_heads(observed, old) do
    case Enum.find(observed.links, &(&1.old_pub == old)) do
      nil -> []
      link -> link.heads
    end
  end

  defp claim(log, request, vouchers, epoch, basis, parents) do
    Certificate.normalize_claim(%{
      version: 1,
      product: :treehouse,
      space: log.replica,
      old_pub: request.old_pub,
      old_admission: request.old_admission,
      new_pub: request.new_pub,
      old_membership: request.old_membership,
      nonce: request.nonce,
      vouchers: vouchers,
      epoch: epoch,
      epoch_basis: basis,
      parents: parents,
      deps: Log.frontier(log)
    })
  end

  defp placeholder(claim),
    do: %{
      claim: claim,
      possession: <<0::512>>,
      vouches: Enum.map(claim.vouchers, &%{member: &1.member, signature: <<0::512>>})
    }

  defp intent(claim, cert, author, cap) do
    op = %Op{
      id: "",
      replica: claim.space,
      author: author,
      deps: claim.deps,
      kind: :command,
      body: {:attest_member_key_v1, [claim, cert.possession, cert.vouches]},
      cap: cap,
      sig: <<0::512>>
    }

    %{op | id: Op.recompute_id(op)}
  end

  # Only the existing full judge consumes this private unsigned intent. Never
  # append/accept it or pass this synthetic scope to an authenticated public API.
  defp intent_reason(log, op) do
    scope = %{log | ops: Map.put(log.ops, op.id, op)}
    Authority.analyze(Space, scope).reasons[op.id]
  end

  defp review_preflight(log, op) do
    case intent_reason(log, op) do
      :application_continuity_invalid_certificate -> :ok
      reason -> {:error, reason || :invalid_review_intent}
    end
  end

  defp preflight(log, op) do
    case intent_reason(log, op) do
      nil -> :ok
      reason -> {:error, reason}
    end
  end

  defp saved_request(%{request: request}), do: {:ok, request}
  defp saved_request(_), do: {:error, :stale_verified_state}

  defp fresh_review(log, request) do
    case review(log, request) do
      {:ok, review} -> {:ok, review}
      {:error, :invalid_verified_history} = error -> error
      {:error, :capacity_stop} = error -> error
      _ -> {:error, :stale_verified_state}
    end
  end

  defp verify_certificate(certificate, claim) do
    with {:ok, certificate} <- Certificate.normalize_certificate(certificate) do
      case Certificate.verify_certificate(certificate, claim) do
        :ok -> :ok
        _ -> {:error, :application_continuity_invalid_certificate}
      end
    else
      _ -> {:error, :application_invalid_continuity}
    end
  end

  defp signer(%Identity{pub: author} = identity, author),
    do: {:ok, &Identity.sign(identity, &1)}

  defp signer(%{pub: author, sign: sign}, author) when is_function(sign, 1), do: {:ok, sign}
  defp signer(_, _), do: {:error, :wrong_signer}

  defp sign(sign, bytes) do
    case sign.(bytes) do
      signature when is_binary(signature) and byte_size(signature) == 64 ->
        {:ok, signature}

      {:ok, signature} when is_binary(signature) and byte_size(signature) == 64 ->
        {:ok, signature}

      _ ->
        {:error, :invalid_signer_signature}
    end
  rescue
    _ -> {:error, :signer_failed}
  catch
    _, _ -> {:error, :signer_failed}
  end

  defp signed_valid(op) do
    if Op.valid?(op), do: :ok, else: {:error, :invalid_signer_signature}
  end

  defp honored(observed, id) do
    case Enum.find(observed.quarantine, &(&1.op_id == id)) do
      nil -> :ok
      %{reason: reason} -> {:error, reason}
    end
  end

  defp key?(value), do: is_binary(value) and byte_size(value) == 32

  defp id?(value) when is_binary(value) and byte_size(value) == 43 do
    case Base.url_decode64(value, padding: false) do
      {:ok, decoded} ->
        byte_size(decoded) == 32 and Base.url_encode64(decoded, padding: false) == value

      _ ->
        false
    end
  end

  defp id?(_), do: false
end
