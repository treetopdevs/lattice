defmodule LatticeCarrierServer.Operator.CatalogCli do
  @moduledoc """
  Local operator command adapter, executed inside the already guarded relay VM.

  Invoke through the release's existing local rpc command or its console. This
  adapter starts no application/listener and accepts no seed or signing key.
  Expected journal bytes come from a preserved intent file, never inferred from
  the live journal after the user reviewed it. Command files contain closed JSON
  argv data, not executable expressions.
  """
  alias LatticeCarrierServer.Operator.{PublicArtifact, ReleaseCatalog}
  alias LatticeCarrierServer.Operator.CatalogCeremony.Store

  @switches [
    root: :string,
    expected: :string,
    ceremony: :string,
    probe: :string,
    status: :string,
    out: :string,
    package: :string,
    envelope: :string
  ]

  @spec run([String.t()]) :: :ok | {:error, atom()}
  def run(argv) do
    result = with {:ok, command, opts} <- parse(argv), do: execute(command, opts)

    case result do
      {:ok, public} ->
        IO.puts(Jason.encode!(public, pretty: true))
        :ok

      {:error, reason} when is_atom(reason) ->
        IO.puts(:stderr, "refused: #{reason}")
        {:error, reason}

      _ ->
        IO.puts(:stderr, "refused: catalog_command_failed")
        {:error, :catalog_command_failed}
    end
  rescue
    _ ->
      IO.puts(:stderr, "refused: catalog_command_failed")
      {:error, :catalog_command_failed}
  catch
    _, _ ->
      IO.puts(:stderr, "refused: catalog_command_failed")
      {:error, :catalog_command_failed}
  end

  @spec run_file(Path.t()) :: :ok | {:error, atom()}
  def run_file(path) do
    with true <- is_binary(path),
         {:ok, %{"format" => "treehouse-catalog-command-v1", "args" => args} = doc} <-
           Store.read(Path.dirname(Path.expand(path)), Path.basename(path), ~w(args format)),
         true <- map_size(doc) == 2 and is_list(args) and length(args) <= 32,
         true <- Enum.all?(args, &(is_binary(&1) and byte_size(&1) <= 4096)) do
      run(args)
    else
      _ ->
        IO.puts(:stderr, "refused: invalid_catalog_command")
        {:error, :invalid_catalog_command}
    end
  rescue
    _ ->
      IO.puts(:stderr, "refused: invalid_catalog_command")
      {:error, :invalid_catalog_command}
  end

  defp parse(argv) do
    case OptionParser.parse(argv, strict: @switches) do
      {_, _, [_ | _]} ->
        {:error, :invalid_catalog_options}

      {opts, [command], []} when command in ["prepare", "commit"] ->
        required =
          [:root, :expected, :ceremony, :probe] ++
            if(command == "prepare", do: [:status, :out], else: [:package, :envelope])

        keys = Keyword.keys(opts)

        if Enum.sort(keys) == Enum.sort(required) and
             Enum.all?(opts, fn {_, value} -> is_binary(value) and value != "" end),
           do: {:ok, command, opts},
           else: {:error, :invalid_catalog_options}

      _ ->
        {:error, :invalid_catalog_command}
    end
  end

  defp execute("prepare", opts) do
    with {:ok, expected} <- read(opts[:expected], 1_048_576),
         {:ok, prepared} <-
           ReleaseCatalog.prepare(
             opts[:root],
             expected,
             opts[:ceremony],
             opts[:probe],
             opts[:status]
           ),
         :ok <- PublicArtifact.write(opts[:out], prepared.package) do
      {:ok,
       %{
         "package" => Path.expand(opts[:out]),
         "review" => prepared.sheet,
         "claim" => "Public signing candidate only; journal remains ready."
       }}
    end
  end

  defp execute("commit", opts) do
    with {:ok, expected} <- read(opts[:expected], 1_048_576),
         {:ok, record} <-
           ReleaseCatalog.commit(
             opts[:root],
             expected,
             opts[:ceremony],
             opts[:probe],
             opts[:package],
             opts[:envelope]
           ) do
      {:ok,
       %{
         "phase" => record["phase"],
         "catalog_id" => record["catalog_head"],
         "claim" => "Checked local catalog receipt; no listing or client trust installation."
       }}
    end
  end

  defp read(path, cap) when is_binary(path),
    do: Store.read_text(Path.dirname(Path.expand(path)), Path.basename(path), cap)

  defp read(_, _), do: {:error, :invalid_catalog_options}
end
