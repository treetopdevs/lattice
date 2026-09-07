# Run with MIX_ENV=test mix run --no-compile --no-start FILE.exs FIXTURE.json.
# This read-only checker authenticates every signed frame before comparing the BEAM oracle.
[fixture_path] = System.argv()
for module <- [Treehouse.Space, Lattice.Authority, Lattice.Authority.Delegation, Lattice.Log],
    do: Code.ensure_loaded!(module)

observe = fn replica, frames ->
  {:ok, ops} = Lattice.Carrier.Wire.decode_ops(frames)
  true = Enum.all?(ops, &Lattice.Op.valid?/1)
  {log, %{pending: []}} = Lattice.Sync.deliver(Lattice.Log.new(replica), ops)
  :ok = Lattice.Log.verify_authenticity(log)
  {:ok, observed} = Treehouse.MemberContinuity.observe(log)

  %{
    links: Enum.map(observed.links, fn link ->
      %{oldPub: Base.encode64(link.old_pub), heads: link.heads, status: link.status,
        affectedWrappers: Enum.map(link.affected_wrappers, &%{opId: &1.op_id, reason: &1.reason})}
    end),
    quarantine: Enum.map(observed.quarantine, &%{opId: &1.op_id, reason: &1.reason})
  }
  |> Jason.encode!()
  |> Jason.decode!()
end

fixture = fixture_path |> File.read!() |> Jason.decode!()
for item <- fixture["cases"] do
  parent_frames = Enum.reject(item["frames"], &(&1["id"] == item["child"]))
  for {frames, expected} <- [{parent_frames, item["expected_parent"]}, {item["frames"], item["expected_child"]}],
      ordered <- [frames, Enum.reverse(frames)] do
    actual = observe.(item["replica"], ordered)
    if actual != expected, do: raise("BEAM parity mismatch #{item["name"]}: #{inspect(actual)}")
  end
  IO.puts("BEAM_CLAIM_SHAPE_OK #{item["name"]}")
end
