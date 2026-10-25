defmodule LatticeCarrierServer.Operator.CatalogCeremony.Cli do
  @moduledoc """
  Argument handling and output for `mix treehouse.catalog_ceremony`.

  `run/2` prints only public values to stdout and `refused: <atom>` to stderr,
  and returns `:ok` or `{:error, atom}`. Unknown options are refused without
  echoing them, so a secret pasted into argv never reaches the output.
  """

  alias LatticeCarrierServer.Operator.CatalogCeremony

  @switches [
    package: :string,
    confirm_catalog: :string,
    signer: :string,
    ceremony: :string,
    out: :string,
    backup: :string,
    restore_to: :string,
    space_log: :string,
    service_public_key: :string,
    service_id: :string,
    origin: :string,
    custodian: :string,
    passphrase_holder: :string,
    rotation_owner: :string
  ]

  # command => {function, required options, optional options}
  @commands %{
    "review-catalog" => {:review_catalog, [:ceremony, :package], []},
    "init-ledger" => {:init_catalog_ledger, [:ceremony, :space_log, :out], []},
    "catalog-status" => {:catalog_status, [:ceremony, :package, :out], []},
    "sign-catalog" => {:sign_catalog, [:ceremony, :package, :signer, :confirm_catalog, :out], []},
    "generate" => {:generate, [:signer, :ceremony], []},
    "import" => {:import_signer, [:signer, :ceremony], []},
    "backup" => {:backup, [:signer, :ceremony, :out], []},
    "verify-backup" => {:verify_backup, [:backup, :ceremony], [:restore_to]},
    "binding-payload" =>
      {:binding_payload, [:ceremony, :space_log, :service_public_key, :origin], [:service_id]},
    "verify-binding" => {:verify_binding, [:ceremony, :space_log], []},
    "report" => {:report, [:ceremony, :custodian, :passphrase_holder, :rotation_owner], []},
    "dry-run" => {:dry_run, [:ceremony], []}
  }

  @spec run([String.t()], keyword()) :: :ok | {:error, atom()}
  def run(argv, extra \\ []) do
    with {:ok, command, opts} <- parse(argv),
         {:ok, result} <- apply(CatalogCeremony, command, [Keyword.merge(opts, extra)]) do
      print(command, opts, result)
      :ok
    else
      {:error, reason} = refusal when is_atom(reason) ->
        IO.puts(:stderr, "refused: #{reason}")
        refusal
    end
  end

  @doc "The command names, for usage text."
  @spec commands() :: [String.t()]
  def commands, do: Map.keys(@commands) |> Enum.sort()

  defp parse(argv) do
    case OptionParser.parse(argv, strict: @switches) do
      {_, _, [_ | _]} -> {:error, :invalid_options}
      {opts, [name], []} -> command(name, opts)
      _ -> {:error, :unknown_command}
    end
  end

  defp command(name, opts) do
    with {:ok, {function, required, optional}} <- Map.fetch(@commands, name) |> known(),
         :ok <- allowed(opts, required ++ optional),
         :ok <- present(opts, required) do
      {:ok, function, opts}
    end
  end

  defp known({:ok, spec}), do: {:ok, spec}
  defp known(:error), do: {:error, :unknown_command}

  defp allowed(opts, permitted),
    do:
      if(Enum.all?(opts, fn {key, _} -> key in permitted end),
        do: :ok,
        else: {:error, :invalid_options}
      )

  defp present(opts, required),
    do:
      if(Enum.all?(required, &(opts[&1] not in [nil, ""])),
        do: :ok,
        else: {:error, :option_required}
      )

  defp print(command, opts, result) when command in [:generate, :import_signer] do
    show(Map.take(result, ~w(public_key_base64 public_key_hex fingerprint_sha256)))
    show(%{"signer_record" => artifact(opts, "signer.json")})
  end

  defp print(:backup, opts, result) do
    show(Map.take(result, ~w(sha256 bytes public_key_base64)))
    show(%{"backup_record" => artifact(opts, "backup.json")})
  end

  defp print(:verify_backup, opts, result) do
    show(Map.take(result, ~w(ok backup_sha256 public_key_base64 separate_host seed_restored)))
    show(%{"restore_record" => artifact(opts, "restore.json")})
  end

  defp print(:binding_payload, opts, result) do
    show(%{"binding_payload_sha256" => result["sha256"]})
    show(%{"payload" => artifact(opts, "binding-payload.json")})
    show(%{"review_sheet" => artifact(opts, "binding-review.txt")})
  end

  defp print(:verify_binding, opts, result) do
    show(Map.take(result, ~w(bootstrap_id record_sha256 space)))
    show(%{"binding_record" => artifact(opts, "binding.json")})
  end

  defp print(:report, _opts, result),
    do: show(%{"report" => result.path, "report_sha256" => result.sha256})

  defp print(:dry_run, _opts, result) do
    show(%{
      "ceremony" => result.ceremony,
      "marker" => result.marker,
      "binding_payload_sha256" => result.binding_payload_sha256,
      "bootstrap_id" => result.bootstrap_id,
      "report" => result.report,
      "report_sha256" => result.report_sha256
    })
  end

  defp print(:review_catalog, _opts, result), do: IO.puts(Jason.encode!(result, pretty: true))

  defp print(command, _opts, result)
       when command in [:init_catalog_ledger, :catalog_status, :sign_catalog],
       do: show(result)

  defp artifact(opts, name), do: opts[:ceremony] |> Path.expand() |> Path.join(name)

  defp show(map) do
    for {key, value} <- Enum.sort(map), do: IO.puts("#{key}: #{value}")
    :ok
  end
end
