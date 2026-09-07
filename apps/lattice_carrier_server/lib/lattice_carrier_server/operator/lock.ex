defmodule LatticeCarrierServer.Operator.Lock do
  @moduledoc """
  Private client of the Linux Python3 mutation owner.

  Python's standard-library helper owns flock and every filesystem write through
  fsync and reopen. BEAM callbacks only inspect staged bytes; keeper death cannot
  leave a BEAM rename running after lock release. Missing Python3/helper refuses.
  The helper must be deployed with the operator checkout; no release installation
  or supported-host availability is asserted by this primitive.
  """
  @helper Path.expand("../../../../../scripts/treehouse_operator_mutation.py", __DIR__)
  @external_resource @helper
  @timeout 10_000

  @spec commit(Path.t(), binary() | nil, binary()) :: :ok | {:error, term()}
  def commit(root, expected, record) do
    run(root, plan("journal", expected, record, nil, nil, nil), nil)
  end

  @spec stage(Path.t(), binary() | nil, binary(), [map()], [map()], (-> term())) :: term()
  def stage(root, expected, attempt, checks, artifacts, inspect_staged) do
    run(root, plan("stage", expected, nil, attempt, checks, artifacts), inspect_staged)
  end

  defp plan(kind, expected, record, attempt, checks, artifacts) do
    %{
      version: 1,
      kind: kind,
      expected: expected,
      record: record,
      attempt: attempt,
      checks: checks,
      artifacts: artifacts
    }
  end

  defp run(root, plan, inspect_staged) do
    with true <- :os.type() == {:unix, :linux},
         python when is_binary(python) <- System.find_executable("python3"),
         true <- File.regular?(@helper) do
      port =
        Port.open({:spawn_executable, python}, [
          :binary,
          :exit_status,
          :stderr_to_stdout,
          {:line, 1024},
          args: [@helper, Path.expand(root)]
        ])

      try do
        true = Port.command(port, Jason.encode!(plan) <> "\n")

        case response(port) do
          {:ok, %{"staged" => true}} when is_function(inspect_staged, 0) ->
            case inspect_staged.() do
              {:ok, record} ->
                true = Port.command(port, Jason.encode!(%{commit: Jason.encode!(record)}) <> "\n")
                with :ok <- completed(port), do: {:ok, record}

              {:error, _} = error ->
                error
            end

          {:ok, %{"ok" => true}} ->
            exited(port)

          {:error, _} = error ->
            error

          _ ->
            {:error, :invalid_operator_response}
        end
      after
        close(port)
      end
    else
      _ -> {:error, :unsupported_operator_platform}
    end
  rescue
    _ -> {:error, :operator_mutation_failed}
  catch
    :exit, _ -> {:error, :operator_mutation_failed}
  end

  defp completed(port) do
    case response(port) do
      {:ok, %{"ok" => true}} -> exited(port)
      {:error, _} = error -> error
      _ -> {:error, :invalid_operator_response}
    end
  end

  defp response(port) do
    receive do
      {^port, {:data, {:eol, bytes}}} ->
        case Jason.decode(bytes) do
          {:ok, %{"error" => reason} = value} when map_size(value) == 1 and is_binary(reason) ->
            {:error, {:operator_refused, reason}}

          {:ok, value} when value in [%{"ok" => true}, %{"staged" => true}] ->
            {:ok, value}

          _ ->
            {:error, :invalid_operator_response}
        end

      {^port, {:exit_status, _}} ->
        {:error, :operator_mutation_failed}

      {^port, {:data, _}} ->
        {:error, :invalid_operator_response}
    after
      @timeout -> {:error, :operator_mutation_timeout}
    end
  end

  defp exited(port) do
    receive do
      {^port, {:exit_status, 0}} -> :ok
      {^port, {:exit_status, _}} -> {:error, :operator_mutation_failed}
    after
      @timeout -> {:error, :operator_mutation_timeout}
    end
  end

  defp close(port) do
    if Port.info(port) != nil, do: Port.close(port)
    :ok
  rescue
    ArgumentError -> :ok
  end
end
