defmodule LatticeCarrierServer.Operator.ReferenceMode do
  @moduledoc """
  Closed reference observation modes for initial Treehouse provisioning.

  The review is an assertion of presence, never an authority verdict. Initial
  adoption additionally requires the staging owner to verify an empty catalog
  store under its lock. This module only verifies the signed history observation.
  """
  alias Lattice.{Authority, Log, Op}
  alias Lattice.Carrier.Wire

  @initial %{"mode" => "initial_existing"}

  @spec valid_review?(term()) :: boolean()
  def valid_review?(review), do: review == nil or review == @initial

  @spec initial?(term()) :: boolean()
  def initial?(review), do: review == @initial

  @doc "Every phase has an initial consumer; reference review metadata remains closed."
  @spec phase_allowed?(term(), [map()]) :: boolean()
  def phase_allowed?(_phase, artifacts) do
    Enum.all?(artifacts, &(&1["kind"] != "reference" or valid_review?(&1["review"])))
  end

  @doc "Verify the exact reference against an absent pending or present initial observation."
  @spec observe(map(), Log.t(), Log.t()) :: {:ok, Log.t()} | {:error, atom()}
  def observe(bundle, space, child_log), do: observe_reference(bundle, space, child_log, :staged)

  @doc "Judge exact absent/present pending references, or present-only initial references, for listing."
  @spec observe_listing(map(), Log.t(), Log.t()) :: {:ok, Log.t()} | {:error, atom()}
  def observe_listing(bundle, space, child_log),
    do: observe_reference(bundle, space, child_log, :listing)

  defp observe_reference(%{reference: reference, child: child}, space, child_log, policy) do
    with true <- valid_review?(reference.review),
         {:ok, frame} <- Jason.decode(reference.bytes),
         {:ok, op} <- Wire.decode_op(frame),
         true <- Wire.encode_op(op) == frame and Op.valid?(op),
         true <- op.id == reference.op_id and op.replica == reference.replica,
         :command <- op.kind,
         {:create_thread, [child_replica, title]} <- op.body,
         true <- is_binary(title) and child_replica == child.replica,
         {:ok, observed} <- presence(reference.review, op, space, policy),
         reasons = Authority.analyze(Treehouse.Space, observed).reasons,
         false <- Map.has_key?(reasons, op.id),
         :ok <- initial_competition(policy, reference.review, op, observed, reasons),
         true <- initial_scope?(reference.review, op, observed, reasons, child, child_log) do
      {:ok, observed}
    else
      {:error, :initial_reference_competing} = error -> error
      _ -> reference_refusal(policy)
    end
  rescue
    _ -> reference_refusal(policy)
  end

  defp reference_refusal(:listing), do: {:error, :reference_not_honored}
  defp reference_refusal(:staged), do: {:error, :invalid_staged_signed_artifact}

  defp initial_competition(:listing, @initial, op, space, reasons) do
    competing =
      Enum.any?(space.ops, fn {id, candidate} ->
        id != op.id and match?(%Op{kind: :command, body: {:create_thread, _}}, candidate) and
          not Map.has_key?(reasons, id)
      end)

    if competing, do: {:error, :initial_reference_competing}, else: :ok
  end

  defp initial_competition(_, _, _, _, _), do: :ok

  defp presence(nil, op, space, :listing) do
    case Map.fetch(space.ops, op.id) do
      {:ok, ^op} -> {:ok, space}
      :error -> Log.accept(space, op)
      _ -> :error
    end
  end

  defp presence(nil, op, space, :staged) do
    if Map.has_key?(space.ops, op.id), do: :error, else: Log.accept(space, op)
  end

  defp presence(@initial, op, space, _policy) do
    if Map.get(space.ops, op.id) == op, do: {:ok, space}, else: :error
  end

  defp initial_scope?(nil, _op, _space, _reasons, _child, _log), do: true

  defp initial_scope?(@initial, op, space, reasons, child, child_log) do
    {:create_thread, [_, title]} = op.body

    references =
      for {id, %Op{kind: :command, body: {:create_thread, _}}} <- space.ops,
          not Map.has_key?(reasons, id),
          do: id

    not Authority.tombstoned?(space) and references == [op.id] and
      child_log.replica == child.replica and
      match?(
        %Op{kind: :command, body: {:create_thread, [^title]}},
        child_log.ops[child.review["creation"]]
      )
  end
end
