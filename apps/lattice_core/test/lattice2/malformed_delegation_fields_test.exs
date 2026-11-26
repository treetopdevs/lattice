defmodule Lattice2.MalformedDelegationFieldsTest do
  @moduledoc """
  Row 289 follow-up: the judge never raises on a delegation whose fields are not
  the shapes the wire decoder can produce. `malformed_delegation_test.exs` covers
  list-shaped `ops`/`roles`; this file covers every other field.

  `Lattice.Canonical` sorts any enumerable of names, so a delegation whose `ops` or
  `roles` is a list encodes to the same bytes, id and signature as the MapSet form.
  Such a term can only exist locally (a hand-built struct or an unverified dump):
  `Lattice.Carrier.Wire` always rebuilds MapSets, so a peer that pulls the op over the
  carrier honours the well-formed form. Locally, the judge treats the malformed term
  as a bad-signature introduction.
  """
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Canonical, Identity, Log, Op, Sim}
  alias Lattice.Authority.Delegation
  alias Lattice.Carrier.Wire
  alias Treehouse.ContinuationFixtures, as: F

  @module Lattice.Demo.Thread

  defp setup_thread do
    sim = Sim.new(@module, "replica:thread:row289", ["server", "tab"], seed: "row289")
    {sim, genesis} = Sim.create_replica(sim, "server")
    {:genesis, root_delegation, _policies} = genesis.body
    {sim, Sim.identity(sim, "server"), Sim.identity(sim, "tab"), root_delegation}
  end

  defp grant(sim, root, tab, parent, opts \\ []) do
    Delegation.new(
      root,
      sim.replica,
      tab.pub,
      Keyword.merge([ops: [:post], parent_id: parent.id], opts)
    )
  end

  # Signs a delegation with arbitrary field values, so the signature verifies over the
  # malformed term's own canonical bytes.
  defp resign(sim, root, tab, parent, fields) do
    base = %{
      replica: sim.replica,
      issuer: root.pub,
      audience: tab.pub,
      parent_id: parent.id,
      ops: MapSet.new([:post]),
      roles: MapSet.new(),
      live: false,
      expires_epoch: nil
    }

    d = Map.merge(base, fields)

    bytes =
      Canonical.delegation_bytes(
        d.replica,
        d.issuer,
        d.audience,
        d.parent_id,
        d.ops,
        d.roles,
        d.live,
        d.expires_epoch
      )

    struct!(
      Delegation,
      Map.merge(d, %{
        id: :crypto.hash(:sha256, bytes) |> Base.url_encode64(padding: false),
        sig: Identity.sign(root, bytes)
      })
    )
  end

  # Appends `{:grant, delegation}` from the root, then a post citing it from the tab.
  defp grant_then_post(sim, delegation) do
    {sim, grant_op} = Sim.append(sim, "server", :authority, {:grant, delegation})
    sim = Sim.sync_all(sim)
    {sim, post_op} = Sim.append(sim, "tab", :command, {:post, ["hi"]}, cap: delegation.id)
    {Sim.sync_all(sim), grant_op, post_op}
  end

  defp analyze(sim), do: Authority.analyze(@module, Sim.log(sim, "server"))

  defp continuation_ready do
    {sim, _genesis} = F.new(kind: :thread, label: "row289")
    {sim, pin, profile} = F.pin(sim)
    {sim, epoch} = Sim.beacon(sim, "founder", 0)
    {Sim.sync_all(sim), pin, profile, epoch}
  end

  describe "correctly signed delegations with out-of-domain fields" do
    test "signed fields outside the wire domain never raise and are refused" do
      {sim, root, tab, parent} = setup_thread()

      for fields <- [
            %{live: "yes"},
            %{live: nil},
            %{parent_id: 5},
            %{audience: 7},
            %{audience: :tab}
          ] do
        odd = resign(sim, root, tab, parent, fields)
        refute Delegation.valid_sig?(odd), inspect(fields)

        {branch, grant_op, post_op} = grant_then_post(sim, odd)
        assert Op.valid?(grant_op), inspect(fields)

        analysis = analyze(branch)
        assert analysis.reasons[grant_op.id] == :bad_delegation_sig, inspect(fields)
        assert analysis.reasons[post_op.id] == :invalid_capability, inspect(fields)
      end
    end
  end

  describe "unsignable terms reached through a tampered log" do
    test "the judge refuses them without raising" do
      for patch <- [
            %{expires_epoch: -1},
            %{expires_epoch: "x"},
            %{ops: nil},
            %{ops: %{__struct__: MapSet, map: :junk}},
            %{ops: %{post: true}},
            %{ops: MapSet.new([%{__struct__: MapSet, map: :junk}])},
            %{roles: MapSet.new([{:post}])},
            %{id: 1},
            %{sig: nil},
            %{replica: :other}
          ] do
        {sim, root, tab, parent} = setup_thread()
        normal = grant(sim, root, tab, parent)
        {sim, grant_op, post_op} = grant_then_post(sim, normal)

        log = Sim.log(sim, "server")
        tampered = %{grant_op | body: {:grant, struct(normal, patch)}}
        log = %{log | ops: Map.put(log.ops, grant_op.id, tampered)}

        refute Delegation.valid_sig?(struct(normal, patch)), inspect(patch)
        analysis = Authority.analyze(@module, log)
        assert analysis.reasons[grant_op.id] == :bad_delegation_sig, inspect(patch)
        # With a tampered id no introduction carries the cited id at all.
        expected = if Map.has_key?(patch, :id), do: :no_capability, else: :invalid_capability
        assert analysis.reasons[post_op.id] == expected, inspect(patch)
      end
    end
  end

  test "valid_sig? and attenuates? refuse a struct missing any key, not raise" do
    {sim, root, tab, parent} = setup_thread()
    normal = grant(sim, root, tab, parent)

    for key <- Map.keys(normal) -- [:__struct__] do
      partial = Map.delete(normal, key)
      refute Delegation.valid_sig?(partial), inspect(key)
      refute Delegation.attenuates?(partial, parent), inspect(key)
      refute Delegation.attenuates?(normal, Map.delete(parent, key)), inspect(key)
    end
  end

  test "a legacy struct without the lease key is refused by the judge, not raised" do
    {sim, root, tab, parent} = setup_thread()
    normal = grant(sim, root, tab, parent)
    {sim, grant_op, post_op} = grant_then_post(sim, normal)
    legacy = Map.delete(normal, :expires_epoch)

    log = Sim.log(sim, "server")
    log = %{log | ops: Map.put(log.ops, grant_op.id, %{grant_op | body: {:grant, legacy}})}
    analysis = Authority.analyze(@module, log)
    assert analysis.reasons[grant_op.id] == :bad_delegation_sig
    assert analysis.reasons[post_op.id] == :invalid_capability
  end

  @tag :tmp_dir
  test "a dumped delegation missing keys restores as nil fields the judge refuses", %{
    tmp_dir: dir
  } do
    {sim, root, tab, parent} = setup_thread()
    normal = grant(sim, root, tab, parent)
    {sim, grant_op, post_op} = grant_then_post(sim, normal)

    for key <- [:live, :ops, :audience, :id, :sig] do
      log = Sim.log(sim, "server")
      partial = Map.delete(normal, key)
      log = %{log | ops: Map.put(log.ops, grant_op.id, %{grant_op | body: {:grant, partial}})}
      path = Path.join(dir, "#{key}.dump")
      bytes = :erlang.term_to_binary({:lattice_log_dump_v1, log})
      File.write!(path, bytes)

      assert {:ok, restored} = Log.restore(path)
      {:grant, upgraded} = restored.ops[grant_op.id].body
      assert Map.fetch!(upgraded, key) == nil

      analysis = Authority.analyze(@module, restored)
      assert analysis.reasons[grant_op.id] == :bad_delegation_sig, inspect(key)
      expected = if key == :id, do: :no_capability, else: :invalid_capability
      assert analysis.reasons[post_op.id] == expected, inspect(key)
    end
  end

  test "a forged genesis with a non-binary audience that sorts first is refused, not raised" do
    {sim, _root, tab, root_delegation} = setup_thread()

    {:genesis, _d, policies} =
      sim |> Sim.log("server") |> Log.topo_ops() |> hd() |> Map.get(:body)

    forged = %{root_delegation | audience: 5}
    log = Sim.log(sim, "server")

    # Vary the policies until the forgery is first in canonical order, ahead of the root.
    {op, log} =
      Enum.find_value(1..200, fn n ->
        op =
          Op.new(tab, sim.replica, [], :authority, {:genesis, forged, Map.put(policies, :n, n)})

        candidate = Log.append!(log, op)
        if hd(Log.topo_ops(candidate)).id == op.id, do: {op, candidate}
      end)

    analysis = Authority.analyze(@module, log)
    assert analysis.reasons[op.id] == :bad_delegation_sig
    assert Authority.root(log) == root_delegation.audience
  end

  test "verify_chain refuses a genesis with non-binary keys without raising" do
    {sim, _root, _tab, root_delegation} = setup_thread()
    odd = %{root_delegation | issuer: 5, audience: 5}
    assert {:error, _reason} = Authority.verify_chain([odd], sim.replica)
  end

  describe "the carrier boundary" do
    test "a list-form grant is well-formed once it crosses the wire" do
      for field <- [:ops, :roles] do
        {sim, root, tab, parent} = setup_thread()
        normal = grant(sim, root, tab, parent)
        listed = Map.put(normal, field, normal |> Map.fetch!(field) |> MapSet.to_list())
        {sim, grant_op, post_op} = grant_then_post(sim, listed)

        {:ok, decoded} = grant_op |> Wire.encode_op() |> Wire.decode_op()
        assert decoded.id == grant_op.id
        assert {:grant, %Delegation{ops: %MapSet{}} = wired} = decoded.body
        assert wired == normal
        assert Op.valid?(decoded)

        log = Sim.log(sim, "server")
        log = %{log | ops: Map.put(log.ops, grant_op.id, decoded)}
        analysis = Authority.analyze(@module, log)
        refute Map.has_key?(analysis.reasons, grant_op.id)
        refute Map.has_key?(analysis.reasons, post_op.id)
      end
    end
  end

  test "Verdict renders a grant whose carried id is not a UTF-8 binary" do
    for id <- [{:a, 1}, <<255, 254>>, 7] do
      {sim, root, tab, parent} = setup_thread()
      odd = %{grant(sim, root, tab, parent) | id: id}
      {sim, grant_op} = Sim.append(sim, "server", :authority, {:grant, odd})
      log = sim |> Sim.sync_all() |> Sim.log("server")

      {:quarantined, record} = Lattice.Verdict.explain(@module, log, grant_op.id)
      assert record.reason == :bad_delegation_sig, inspect(id)
      assert record.cited_delegation_id == nil, inspect(id)
      assert %{"cited_delegation_id" => nil} = Jason.decode!(Lattice.Verdict.to_json(record))
    end
  end

  describe "the live chain path" do
    test "verify_chain and attenuates? refuse malformed links without raising" do
      {sim, root, tab, parent} = setup_thread()
      normal = grant(sim, root, tab, parent)

      for odd <- [
            %{normal | ops: [:post]},
            %{normal | roles: []},
            %{normal | live: "yes"},
            %{normal | expires_epoch: -1}
          ] do
        assert Authority.verify_chain([parent, odd], sim.replica) == {:error, :bad_signature}
        refute Delegation.attenuates?(odd, parent)
        refute Delegation.attenuates?(normal, %{parent | ops: [:post]})
      end

      assert Authority.verify_chain([parent, normal], sim.replica) == :ok
    end
  end

  describe "bounded continuation" do
    test "a continuation claim whose delegation lacks any key is refused, not raised" do
      {sim, pin, profile, epoch} = continuation_ready()
      {_, candidate} = F.continue(sim, "nominee", pin, profile, epoch_basis: [epoch.id])
      {:succeed, role, d, proof} = candidate.body

      # Only the lease key is optional in canonical bytes, so a keyless claim is
      # signable; any other missing key reaches the judge through a tampered log.
      {branch, op} =
        Sim.append(
          sim,
          "nominee",
          :authority,
          {:succeed, role, Map.delete(d, :expires_epoch), proof}
        )

      assert Op.valid?(op)
      assert Sim.quarantined(branch, "nominee", op.id) == {true, :malformed_term}

      log = Sim.log(sim, "nominee")
      log = Log.from_ops(log.replica, Map.put(log.ops, candidate.id, candidate))

      # `:id` is read by the judge's own passes first; a struct missing a key is
      # in-process only (Log.restore/1 fills nil), so that is out of scope here.
      for key <- Map.keys(d) -- [:__struct__, :id] do
        odd = %{candidate | body: {:succeed, role, Map.delete(d, key), proof}}
        tampered = Log.from_ops(log.replica, Map.put(log.ops, candidate.id, odd))
        analysis = Authority.analyze(sim.module, tampered)
        assert analysis.reasons[candidate.id] == :malformed_term, inspect(key)
        refute Authority.holder_epoch(sim.module, tampered, role).op_id == candidate.id
      end
    end
  end
end
