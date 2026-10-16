defmodule Lattice.WireAtomVocabularyTest do
  # Plan 190, Step 4 (the V-01 proof): the five plan 185 vectors name atoms that only the vector
  # exporter's source spells. A fresh peer VM that has never seen them must still decode, judge
  # and reduce each vector exactly as this VM does, and both must match the oracle.
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Wire
  alias Mix.Tasks.Lattice.ExportVectors.PolicyFixture

  @vectors Path.expand("../../../../clients/lattice-client/test/vectors", __DIR__)

  @cold_vectors %{
    "township_authority_unattenuated_transfer" => "seize_records",
    "township_authority_undeclared_role_tick" => "ghost",
    "township_beacon_witnessed_certificate_metadata" => "nested",
    "township_beacon_witnessed_policy_metadata" => "nested",
    "township_policy_target_reason_taxonomy" => "malformed"
  }

  @peer_absent ["seize_records", "ghost", "nested", "malformed"]

  # The replica prefix picks the module; the vector's schema name must agree with it.
  @schemas %{
    "replica:matter:" => {Township.Matter, "Township.Matter"},
    "replica:policy:" => {PolicyFixture, "PolicyFixture"}
  }

  # The browser's judge (`browser/lib/judge.ex`) after decode, run verbatim in both VMs. Decode
  # runs first, as its own call: compiling this source loads the exporter module (for
  # `state_json/3`), and with it the vector-only atoms, so it must not run before decode.
  @judge """
  alias Lattice.{Authority, Log, Reduce, Sync}

  [first | _] = ops
  {log, report} = Sync.deliver(Log.new(first.replica), ops)
  analysis = Authority.analyze(module, log)
  reduced = Reduce.reduce(module, log, quarantine: analysis.quarantine)

  pairs =
    analysis.reasons
    |> Enum.map(fn {id, reason} -> [id, Atom.to_string(reason)] end)
    |> Enum.sort()

  state = Mix.Tasks.Lattice.ExportVectors.state_json(module, log, realms)
  %{count: length(ops), size: Log.size(log), report: report, pairs: pairs, reduced: reduced, state: state}
  """

  for {vector_name, atom_name} <- @cold_vectors do
    test "#{vector_name} is judged identically by a VM that lacks the atoms and by this VM" do
      vector =
        @vectors |> Path.join(unquote(vector_name) <> ".json") |> File.read!() |> Jason.decode!()

      {module, schema_name} = schema_for(vector["replica"])
      assert vector["schema"]["name"] == schema_name

      frames = vector["oracleCarrierOps"]

      realms =
        Map.new(vector["realmByPubkey"], fn {b64, realm} -> {Base.decode64!(b64), realm} end)

      {:ok, peer, _node} =
        :peer.start_link(%{connection: :standard_io, args: [~c"-pa" | :code.get_path()]})

      # Immediately before decode the peer holds none of the vector-only atoms, and nothing that
      # spells them (the exporter) is loaded.
      refute :peer.call(peer, :code, :is_loaded, [Mix.Tasks.Lattice.ExportVectors])

      for name <- @peer_absent do
        catch_error(:peer.call(peer, String, :to_existing_atom, [name]))
      end

      assert {:ok, remote_ops} = :peer.call(peer, Wire, :decode_ops, [frames])
      assert {:ok, local_ops} = Wire.decode_ops(frames)
      assert remote_ops == local_ops

      # The peer created the vector's atoms itself, from the closed vocabulary alone.
      refute :peer.call(peer, :code, :is_loaded, [Mix.Tasks.Lattice.ExportVectors])
      assert is_atom(:peer.call(peer, String, :to_existing_atom, [unquote(atom_name)]))

      bindings = [module: module, ops: local_ops, realms: realms]
      {remote, _} = :peer.call(peer, Code, :eval_string, [@judge, bindings], 120_000)
      {local, _} = Code.eval_string(@judge, bindings)

      assert remote == local

      # Every op is admitted structurally; refusals live in the authority verdict.
      assert local.count == length(frames)
      assert local.size == local.count
      assert %{quarantined: [], rejected: [], pending: []} = local.report

      expected = vector["expectAtFullFrontier"]
      assert local.pairs == expected["authorityQuarantine"]
      assert normalize(local.state) == expected["state"]
      assert normalize(remote.state) == expected["state"]
    end
  end

  defp schema_for(replica) do
    {_prefix, schema} =
      Enum.find(@schemas, fn {prefix, _} -> String.starts_with?(replica, prefix) end)

    schema
  end

  defp normalize(value), do: value |> Jason.encode!() |> Jason.decode!()
end
