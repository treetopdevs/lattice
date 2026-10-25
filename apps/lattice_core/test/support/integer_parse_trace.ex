defmodule Lattice.IntegerParseTrace do
  @moduledoc "Test-only allocation-path observation for bounded integer readers."

  @spec capture((-> term())) :: {term(), [binary()]}
  def capture(fun) do
    parent = self()
    worker = spawn(fn -> run(parent, fun) end)
    :erlang.trace_pattern({Integer, :parse, 1}, true, [])
    :erlang.trace(worker, true, [:call, {:tracer, self()}])

    try do
      send(worker, :go)

      result =
        receive do
          {^worker, value} -> value
        after
          30_000 -> raise "integer reader worker did not complete"
        end

      ref = :erlang.trace_delivered(worker)
      calls = collect(worker, ref, [])

      case result do
        {:ok, value} -> {value, calls}
        {:raise, kind, reason, stack} -> :erlang.raise(kind, reason, stack)
      end
    after
      :erlang.trace_pattern({Integer, :parse, 1}, false, [])
      Process.exit(worker, :kill)
    end
  end

  defp run(parent, fun) do
    receive do
      :go ->
        result =
          try do
            {:ok, fun.()}
          catch
            kind, reason -> {:raise, kind, reason, __STACKTRACE__}
          end

        send(parent, {self(), result})
        receive do: (:stop -> :ok)
    end
  end

  defp collect(worker, ref, values) do
    receive do
      {:trace, ^worker, :call, {Integer, :parse, [value]}} ->
        collect(worker, ref, [value | values])

      {:trace_delivered, ^worker, ^ref} ->
        values
    after
      5_000 -> raise "integer parse trace was not delivered"
    end
  end
end
