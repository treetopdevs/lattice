defmodule LatticeCarrierServer.Operator.CatalogCeremony.Passphrase do
  @moduledoc false
  # The backup passphrase arrives only on stdin (or an injected reader in
  # tests), never in argv or the environment. The tool never reads a passphrase
  # from a terminal: it cannot turn echo off reliably from inside the BEAM, so
  # stdin must be a pipe or file (the runbook shows the shell recipe that reads
  # the passphrase silently and pipes it in). A passphrase is printable ASCII
  # (0x20-0x7E) only, so an independent recovery derives the key from the exact
  # same bytes whatever the locale or normalization.

  alias LatticeCarrierServer.Secret

  @minimum 20
  @maximum 1024
  @stdin "/dev/fd/0"

  @doc "Read the passphrase twice, require equality, printable ASCII and length."
  @spec confirmed(keyword()) :: {:ok, Secret.t()} | {:error, atom()}
  def confirmed(opts) do
    with {:ok, [first, second]} <- lines(opts, 2),
         :ok <- if(first == second, do: :ok, else: {:error, :passphrase_mismatch}),
         :ok <- ascii(first),
         :ok <- long_enough(first) do
      {:ok, Secret.wrap(first)}
    end
  end

  @doc "Read the passphrase once; the minimum length applies only when creating a backup."
  @spec single(keyword()) :: {:ok, Secret.t()} | {:error, atom()}
  def single(opts) do
    with {:ok, [line]} <- lines(opts, 1),
         :ok <- ascii(line) do
      {:ok, Secret.wrap(line)}
    end
  end

  @doc """
  Refuse a terminal: stdin (`/dev/fd/0`, links followed) must be a regular file
  or a pipe. `stat` is a test seam; the command line cannot set it.
  """
  @spec stdin_gate((Path.t() -> {:ok, File.Stat.t()} | {:error, term()})) ::
          :ok | {:error, :passphrase_stdin_is_terminal | :passphrase_unreadable}
  def stdin_gate(stat \\ &File.stat/1) do
    case stat.(@stdin) do
      {:ok, %File.Stat{type: type}} when type in [:regular, :other] -> :ok
      {:ok, %File.Stat{type: :device}} -> {:error, :passphrase_stdin_is_terminal}
      _ -> {:error, :passphrase_unreadable}
    end
  end

  defp ascii(passphrase) do
    if passphrase != "" and printable_ascii?(passphrase),
      do: :ok,
      else: {:error, :passphrase_not_ascii}
  end

  defp printable_ascii?(<<>>), do: true

  defp printable_ascii?(<<byte, rest::binary>>) when byte in 0x20..0x7E,
    do: printable_ascii?(rest)

  defp printable_ascii?(_), do: false

  defp long_enough(passphrase) do
    size = byte_size(passphrase)

    cond do
      size < @minimum -> {:error, :passphrase_too_short}
      size > @maximum -> {:error, :passphrase_too_long}
      true -> :ok
    end
  end

  defp lines(opts, count) do
    case opts[:passphrase_reader] do
      reader when is_function(reader, 0) ->
        collect(reader, count)

      nil ->
        with :ok <- stdin_gate(opts[:stdin_stat] || (&File.stat/1)) do
          collect(&stdin_line/0, count)
        end
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

  # Only the line terminator is removed: "\r\n" or "\n". Anything else,
  # including a lone "\r", is part of the passphrase and fails the ASCII rule.
  defp stdin_line do
    case IO.binread(:stdio, :line) do
      line when is_binary(line) -> {:ok, strip(line)}
      _ -> :error
    end
  end

  defp strip(line) do
    cond do
      String.ends_with?(line, "\r\n") -> binary_part(line, 0, byte_size(line) - 2)
      String.ends_with?(line, "\n") -> binary_part(line, 0, byte_size(line) - 1)
      true -> line
    end
  end
end
