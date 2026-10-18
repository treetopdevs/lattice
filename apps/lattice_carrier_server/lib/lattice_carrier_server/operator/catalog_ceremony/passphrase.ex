defmodule LatticeCarrierServer.Operator.CatalogCeremony.Passphrase do
  @moduledoc false
  # The backup passphrase arrives only on stdin (or an injected reader in
  # tests), never in argv or the environment. On a terminal the echo is turned
  # off for the reads and restored afterwards.

  alias LatticeCarrierServer.Secret

  @minimum 20

  @doc "Read the passphrase twice, require equality and length."
  @spec confirmed(keyword()) :: {:ok, Secret.t()} | {:error, atom()}
  def confirmed(opts) do
    with {:ok, [first, second]} <- lines(opts, 2),
         :ok <- if(first == second, do: :ok, else: {:error, :passphrase_mismatch}),
         :ok <- long_enough(first) do
      {:ok, Secret.wrap(first)}
    end
  end

  @doc "Read the passphrase once; no length rule applies to an existing backup."
  @spec single(keyword()) :: {:ok, Secret.t()} | {:error, atom()}
  def single(opts) do
    with {:ok, [line]} <- lines(opts, 1), do: {:ok, Secret.wrap(line)}
  end

  defp long_enough(passphrase) do
    length =
      if String.valid?(passphrase), do: String.length(passphrase), else: byte_size(passphrase)

    if length >= @minimum, do: :ok, else: {:error, :passphrase_too_short}
  end

  defp lines(opts, count) do
    case opts[:passphrase_reader] do
      reader when is_function(reader, 0) -> collect(reader, count)
      nil -> quiet(fn -> collect(&stdin_line/0, count) end)
    end
  end

  defp collect(reader, count) do
    1..count
    |> Enum.reduce_while({:ok, []}, fn _, {:ok, acc} ->
      case reader.() do
        {:ok, line} when is_binary(line) -> {:cont, {:ok, [line | acc]}}
        _ -> {:halt, {:error, :passphrase_unreadable}}
      end
    end)
    |> case do
      {:ok, acc} -> {:ok, Enum.reverse(acc)}
      error -> error
    end
  end

  defp stdin_line do
    case IO.binread(:stdio, :line) do
      line when is_binary(line) ->
        {:ok, line |> String.trim_trailing("\n") |> String.trim_trailing("\r")}

      _ ->
        :error
    end
  end

  defp quiet(fun) do
    hidden? = tty("stty -echo")
    if hidden?, do: IO.write(:stderr, "Passphrase (input hidden): ")

    try do
      fun.()
    after
      if hidden? do
        tty("stty echo")
        IO.write(:stderr, "\n")
      end
    end
  end

  defp tty(command) do
    match?({_, 0}, System.cmd("sh", ["-c", command <> " < /dev/tty"], stderr_to_stdout: true))
  rescue
    _ -> false
  end
end
