defmodule Mix.Tasks.Lattice.Election.Report do
  @moduledoc """
  Render an offline election bundle as a research evidence report.

      mix lattice.election.report --bundle PATH --out PATH [--open-certificate ID]

  The bundle bytes are untrusted: the task reads at most one byte past
  `Township.Election.OfflineBundle.max_envelope_byte_size/0` and refuses a longer
  file before verifying, then `Township.Election.OfflineBundle.verify_bytes/1`
  replays them in full, and an unverifiable bundle gets no report at all.

  With `--open-certificate`, the task also recomputes unanimous-close evidence
  from the decoded bundle under that operator-asserted open certificate id. Only a
  verified `{:ok, evidence}` is accepted; any other verdict raises and writes
  nothing. The bundle format is unchanged.

  The report makes no security claim: every scope of the research manifest
  renders as explicitly not claimed.
  """

  use Mix.Task

  alias Township.Election.{BoardSnapshot, OfflineBundle, Report}
  alias Township.Election.ClosePolicy.UnanimousBoxesV1

  @shortdoc "Render an offline election bundle as a research evidence report (no security claim)"
  @usage "usage: mix lattice.election.report --bundle PATH --out PATH [--open-certificate ID]"

  @impl Mix.Task
  def run(argv) do
    {opts, rest, invalid} =
      OptionParser.parse(argv,
        strict: [bundle: :string, out: :string, open_certificate: :string]
      )

    case {opts[:bundle], opts[:out], opts[:open_certificate], rest, invalid} do
      {bundle, out, certificate, [], []}
      when is_binary(bundle) and bundle != "" and is_binary(out) and out != "" and
             (is_nil(certificate) or certificate != "") ->
        report(bundle, out, certificate)

      _other ->
        Mix.raise(@usage)
    end
  end

  defp report(bundle_path, out_path, certificate) do
    bytes = read_bounded!(bundle_path)

    projection =
      case OfflineBundle.verify_bytes(bytes) do
        {:ok, projection} -> projection
        {:error, reason} -> Mix.raise("offline bundle verification failed: #{inspect(reason)}")
      end

    close_evidence = close_evidence(bytes, certificate)
    html = Report.render(projection, close_evidence: close_evidence)

    out = Path.expand(out_path)
    refuse_bundle_overwrite!(bundle_path, out)
    File.mkdir_p!(Path.dirname(out))
    File.write!(out, html)

    shell = Mix.shell()
    shell.info("Election evidence report written: #{out}")
    shell.info("projection verified by offline replay")

    if close_evidence do
      shell.info(
        "close evidence verified under operator-asserted open certificate #{certificate}"
      )
    end

    :ok
  end

  # The bundle is untrusted, so the task reads at most one byte past the
  # verifier's envelope limit and refuses anything longer before verifying.
  defp read_bounded!(bundle_path) do
    limit = OfflineBundle.max_envelope_byte_size()

    result =
      File.open!(bundle_path, [:read, :binary], fn io -> :file.read(io, limit + 1) end)

    case result do
      {:ok, bytes} when byte_size(bytes) > limit ->
        Mix.raise("offline bundle exceeds #{limit} bytes: #{bundle_path}")

      {:ok, bytes} ->
        bytes

      :eof ->
        ""

      {:error, reason} ->
        Mix.raise("could not read offline bundle #{bundle_path}: #{inspect(reason)}")
    end
  end

  # The report must never replace the evidence it was rendered from, including
  # through a symlink or hard link to the bundle file.
  defp refuse_bundle_overwrite!(bundle_path, out) do
    same_path? = Path.expand(bundle_path) == out

    same_file? =
      with {:ok, bundle_stat} <- File.stat(bundle_path),
           {:ok, out_stat} <- File.stat(out) do
        {bundle_stat.major_device, bundle_stat.inode} == {out_stat.major_device, out_stat.inode}
      else
        _ -> false
      end

    if same_path? or same_file? do
      Mix.raise("--out must not be the --bundle file: #{out}")
    end
  end

  defp close_evidence(_bytes, nil), do: nil

  defp close_evidence(bytes, certificate) do
    with {:ok, bundle} <- OfflineBundle.decode(bytes),
         snapshot = %BoardSnapshot{
           matter_log: bundle.matter_log,
           matter_link_op_id: bundle.matter_link_op_id,
           board_log: bundle.board_log,
           max_artifact_byte_size: bundle.max_artifact_byte_size
         },
         {:ok, evidence} <-
           UnanimousBoxesV1.verify(bundle.spec, snapshot, bundle.artifacts, certificate) do
      evidence
    else
      other -> Mix.raise("close evidence not verified: #{inspect(other)}")
    end
  end
end
