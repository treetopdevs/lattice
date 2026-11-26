defmodule Mix.Tasks.Lattice.Township.Report do
  @moduledoc """
  Write a self-contained HTML auditor report for a Township audit bundle.

      mix lattice.township.report --dir artifacts/township [--out PATH]

  The default output is `<dir>.report.html` beside the bundle directory. An `--out`
  inside the bundle directory is refused, since it would corrupt the bundle's exact
  verifiable file set. The file is always written; a bundle that fails verification
  gets a NOT VERIFIED report and a non-zero exit.

  A verified report includes the role chronology, beacons, leases and election-evidence
  sections (rows 401 and 402); see `Township.AuditReport` for what each does not claim.

  The report is written to a new temporary file in the destination directory and
  renamed over `--out` (`Township.ReportFile`), so a link at `--out`, including one
  swapped in after the containment check, is replaced and never written through.
  """

  use Mix.Task

  alias Township.AuditReport

  @shortdoc "Write an HTML auditor report for a Township audit bundle"

  @impl Mix.Task
  def run(argv) do
    {opts, rest, invalid} = OptionParser.parse(argv, strict: [dir: :string, out: :string])

    dir = opts[:dir]
    out = opts[:out]

    if is_binary(dir) and dir != "" and rest == [] and invalid == [] do
      report(dir, if(out in [nil, ""], do: default_out(dir), else: out))
    else
      Mix.raise("usage: mix lattice.township.report --dir PATH [--out PATH]")
    end
  end

  defp default_out(dir) do
    dir = Path.expand(dir)
    Path.join(Path.dirname(dir), Path.basename(dir) <> ".report.html")
  end

  # Resolve symlinks component by component (a missing tail is kept as written), so a
  # destination alias into the bundle cannot bypass the containment check.
  defp resolve(path), do: resolve_parts(Path.split(path), "", 0)

  defp resolve_parts([], acc, _depth), do: acc

  defp resolve_parts([part | rest], acc, depth) do
    candidate = if acc == "", do: part, else: Path.join(acc, part)

    case File.read_link(candidate) do
      {:ok, _} when depth > 40 ->
        Mix.raise("too many symbolic links resolving: #{candidate}")

      {:ok, target} ->
        target = Path.expand(target, Path.dirname(candidate))
        resolve_parts(Path.split(target) ++ rest, "", depth + 1)

      {:error, _} ->
        resolve_parts(rest, candidate, depth)
    end
  end

  # Filesystem aliases (case-insensitive names, hard links) defeat a textual check, so
  # compare identities too: any existing ancestor of `out`, or `out` itself, that is the
  # bundle directory or one of its files means the write would land in the bundle.
  defp same_file_tree?(dir, out) do
    case file_id(dir) do
      nil -> false
      dir_id -> dir_id in ancestor_ids(out) or file_id(out) in bundle_file_ids(dir)
    end
  end

  defp ancestor_ids(path) do
    parent = Path.dirname(path)
    ids = if file_id(path), do: [file_id(path)], else: []
    if parent == path, do: ids, else: ids ++ ancestor_ids(parent)
  end

  defp bundle_file_ids(dir) do
    case File.ls(dir) do
      {:ok, names} -> names |> Enum.map(&file_id(Path.join(dir, &1))) |> Enum.reject(&is_nil/1)
      _ -> []
    end
  end

  defp file_id(path) do
    case File.stat(path) do
      {:ok, %{inode: inode, major_device: dev}} when inode != 0 -> {dev, inode}
      _ -> nil
    end
  end

  defp report(dir, out) do
    dir = resolve(Path.expand(dir))
    out = Path.expand(out)
    # The containment check follows a leaf symlink; the write replaces the leaf itself,
    # under its resolved parent, so a link at --out is never written through.
    resolved = resolve(out)
    out = Path.join(resolve(Path.dirname(out)), Path.basename(out))

    if Enum.any?([resolved, out], &inside_bundle?(dir, &1)) do
      Mix.raise("refusing --out inside the bundle directory: #{out}")
    end

    Mix.Task.run("app.start")
    File.mkdir_p!(Path.dirname(out))

    case AuditReport.render(dir) do
      {:ok, html, :verified} ->
        write_report!(out, html)
        Mix.shell().info("Township audit report written: #{out} (VERIFIED)")

      {:failed, html, errors} ->
        write_report!(out, html)

        Mix.raise(
          "Township audit bundle verification failed (report written to #{out}):\n- " <>
            Enum.join(errors, "\n- ")
        )
    end
  end

  defp inside_bundle?(dir, path) do
    path == dir or String.starts_with?(path, dir <> "/") or same_file_tree?(dir, path)
  end

  defp write_report!(out, html) do
    case Township.ReportFile.write(out, html) do
      :ok ->
        :ok

      {:error, reason} ->
        Mix.raise("could not write report #{out}: #{:file.format_error(reason)}")
    end
  end
end
