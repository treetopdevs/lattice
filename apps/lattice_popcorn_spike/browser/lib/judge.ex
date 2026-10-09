defmodule LatticeBrowser.Judge do
  @moduledoc """
  Plan 185 vector-verdict seam: run the exact shared `Authority.analyze/2` and
  `Reduce.reduce/3` over a list of signed carrier frames inside the browser BEAM.

  Schema names resolve through a fixed allowlist, never `String.to_atom/1`. Frames
  are decoded by the shared `Lattice.Carrier.Wire` (existing atoms only) and admitted
  through `Lattice.Sync.deliver/2`, so every op signature is rechecked by `:crypto`
  in this VM. The `state` field reproduces the vector exporter's `state_json/3`
  shaping (holders as realm names, the fingerprint when unknown) and is JSON text.
  """
  alias Lattice.{Authority, Identity, Log, Reduce, Sync}
  alias Lattice.Carrier.Wire
  alias Mix.Tasks.Lattice.ExportVectors.{DualAuthorityFixture, PolicyFixture}

  @schemas %{
    "Township.Matter" => Township.Matter,
    "Township.ElectionBoard" => Township.ElectionBoard,
    "Toolshed.Shed" => Toolshed.Shed,
    "Toolshed.Tool" => Toolshed.Tool,
    "Treehouse.Space" => Treehouse.Space,
    "Treehouse.Thread" => Treehouse.Thread,
    "Lattice.Demo.Thread" => Lattice.Demo.Thread,
    "DualAuthorityFixture" => DualAuthorityFixture,
    "PolicyFixture" => PolicyFixture
  }

  @spec schemas() :: [String.t()]
  def schemas, do: @schemas |> Map.keys() |> Enum.sort()

  @spec verdict(term(), term(), term()) :: map()
  def verdict(schema, frames, realms) when is_binary(schema) and is_list(frames) do
    with {:ok, module} <- Map.fetch(@schemas, schema),
         true <- is_nil(realms) or is_map(realms) do
      load_vocabulary()
      run(module, frames, realms || %{})
    else
      _ -> %{"ok" => false, "error" => "unknown_schema"}
    end
  end

  def verdict(_schema, _frames, _realms), do: %{"ok" => false, "error" => "invalid_vector"}

  defp run(module, frames, realms) do
    judge(module, frames, realms)
  rescue
    error -> %{"ok" => false, "error" => "judge_raised", "detail" => Exception.message(error)}
  end

  defp judge(module, frames, realms) do
    t0 = now()

    with {:ok, [first | _] = ops} <- Wire.decode_ops(frames) do
      t1 = now()
      {log, report} = Sync.deliver(Log.new(first.replica), ops)
      t2 = now()
      analysis = Authority.analyze(module, log)
      t3 = now()
      state = Reduce.reduce(module, log, quarantine: analysis.quarantine)
      t4 = now()

      %{
        "ok" => true,
        "op_count" => Log.size(log),
        "structural" => %{
          "rejected" => length(report.rejected),
          "quarantined" => length(report.quarantined),
          "pending" => length(report.pending)
        },
        "quarantine" =>
          Enum.sort(Enum.map(analysis.reasons, fn {id, r} -> [id, Atom.to_string(r)] end)),
        "quarantine_ids" => analysis.quarantine |> MapSet.to_list() |> Enum.sort(),
        "holders" =>
          Map.new(analysis.holders, fn {role, pub} -> {Atom.to_string(role), b64(pub)} end),
        "state" => Jason.encode!(state_json(module, state, analysis, realms)),
        "elapsed_us" => t4 - t0,
        "phases_us" => %{
          "decode" => t1 - t0,
          "deliver" => t2 - t1,
          "analyze" => t3 - t2,
          "reduce" => t4 - t3
        }
      }
    else
      {:ok, []} -> %{"ok" => false, "error" => "empty_vector"}
      {:error, reason} -> undecodable(module, frames, realms, reason)
    end
  end

  # Diagnostic only: which frames this VM refuses to decode, and the verdict over the
  # frames it can decode. Never counted as agreement by the harness.
  defp undecodable(module, frames, realms, reason) do
    indexed = Enum.with_index(frames)
    bad = for {frame, i} <- indexed, match?({:error, _}, Wire.decode_op(frame)), do: {frame, i}
    good = for frame <- frames, not match?({:error, _}, Wire.decode_op(frame)), do: frame

    %{
      "ok" => false,
      "error" => Atom.to_string(reason),
      "undecodable" =>
        Enum.map(bad, fn {frame, i} -> %{"index" => i, "id" => frame_id(frame)} end),
      "decodable_subset" => if(good == [], do: nil, else: judge(module, good, realms))
    }
  end

  defp frame_id(%{"id" => id}) when is_binary(id), do: id
  defp frame_id(_), do: nil

  # Mirrors `Mix.Tasks.Lattice.ExportVectors.state_json/3` field for field.
  defp state_json(Township.Matter, state, analysis, realms) do
    %{
      "title" => state.title,
      "summary" => state.summary,
      "posts" => state.posts,
      "members" => state.members,
      "clerk" => realm(realms, analysis.holders[:clerk]),
      "clerk_locked" => state.clerk_locked?
    }
  end

  defp state_json(Toolshed.Tool, state, analysis, realms) do
    %{
      "description" => state.description,
      "condition_notes" => state.condition_notes,
      "custody" => realm(realms, analysis.holders[:custody]),
      "holder" => realm(realms, state.holder)
    }
  end

  defp state_json(DualAuthorityFixture, state, analysis, realms) do
    %{
      "clerk" => realm(realms, analysis.holders[:clerk]),
      "clerk_locked" => state.clerk_locked?,
      "mayor" => realm(realms, analysis.holders[:mayor]),
      "mayor_locked" => state.mayor_locked?
    }
  end

  defp state_json(PolicyFixture, state, _analysis, _realms), do: %{"events" => state.events}

  defp state_json(module, state, analysis, realms)
       when module in [Treehouse.Space, Treehouse.Thread] do
    roles = for {_field, %{kind: :authority, role: role}} <- module.__lattice_fields__(), do: role
    base = Map.new(state, fn {field, value} -> {Atom.to_string(field), value} end)

    Enum.reduce(roles, base, fn role, acc ->
      Map.put(acc, Atom.to_string(role), realm(realms, analysis.holders[role]))
    end)
  end

  defp state_json(_module, state, _analysis, _realms),
    do: Map.new(state, fn {field, value} -> {Atom.to_string(field), value} end)

  defp realm(_realms, nil), do: nil

  defp realm(realms, pub) when is_binary(pub),
    do: Map.get_lazy(realms, Base.encode64(pub), fn -> Identity.fingerprint(pub) end)

  defp b64(nil), do: nil
  defp b64(pub), do: Base.encode64(pub)

  # The wire codec only accepts existing atoms. A cold VM has not loaded the
  # replica vocabulary yet, so load this application's own trusted modules once.
  defp load_vocabulary do
    unless :persistent_term.get({__MODULE__, :vocabulary}, false) do
      {:ok, modules} = :application.get_key(:lattice_browser, :modules)
      Enum.each(modules, &Code.ensure_loaded/1)
      :persistent_term.put({__MODULE__, :vocabulary}, true)
    end
  end

  defp now, do: System.monotonic_time(:microsecond)
end
