# M2 Real Carrier Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the plan-010 WebSocket carrier spike into the hardened M2 carrier substrate for non-BEAM/browser realms while preserving the existing Lattice 2.0 log, authority, and reduction invariants.

**Architecture:** Keep `Lattice.Carrier` as the sync seam from ADR 0005, but harden the layers around it: versioned canonical bytes, explicit wire frames, authenticated sessions, retry/backoff, partial sync shapes with dependency closure, bounded batches, membership acknowledgements for future compaction GC, and browser-side persistence hooks. `Lattice.Sim` and the existing node spike remain the oracle: every real carrier path must converge to byte-identical state and identical quarantine reports for the same op set.

**Tech Stack:** Elixir 1.19 / OTP 28, Cowboy WebSocket carrier, Ed25519 identities, SHA-256 content ids, a small in-repo deterministic CBOR subset encoder, ExUnit and StreamData.

---

## Current Branch Evaluation: `feat/atomvm-browser-realm`

This branch is not complete enough to merge toward the AtomVM/WASM browser tab realm yet.

Useful pieces to salvage:

- `apps/lattice_tab/lib/lattice/tab/protocol.ex`, `realm.ex`, `codec.ex`, `bridge.ex`, and `main.ex` are a good host-testable shape for a tab realm reducer and AtomVM entry loop.
- `apps/lattice_tab/test/lattice/tab/*_test.exs` passed in isolation: `22 tests, 0 failures, 1 excluded`.
- `apps/lattice_server/test/atomvm_static_test.exs` passed in isolation: `4 tests, 0 failures`.
- `apps/lattice_stress/test/atomvm_tab_denial_test.exs` passed in isolation: `2 tests, 0 failures`.
- The design docs identify the right security line: the browser BEAM must stay behind JSON/WebSocket gateway semantics, not distribution.

Blockers before it can become an integration branch:

- Root umbrella commands fail because the branch adds `apps/lattice_core 2/mix.exs`, a duplicate `:lattice_core` app in a mismatched directory. `mix deps.get && mix test ...` exits with: `Umbrella app :lattice_core is located at directory lattice_core 2`.
- The branch checks in `apps/lattice_core.zip`, copied app trees, and `output/` screenshots/artifacts. These should not land in source as-is.
- `apps/lattice_tab/build_avm.sh` fails after building AtomVM libs because it writes to `.atomvm_build/beams/emscripten.bea#` without creating the beams directory first.
- The AtomVM pack step warns that `json:decode/1` and `json:encode/1` are unavailable on AtomVM, undercutting the branch's "BEAM owns JSON decode/encode" assumption.
- The real browser smoke/E2E cannot be trusted until the build script stages `AtomVM-web-*.js`, `AtomVM-web-*.wasm`, `lattice_tab.avm`, `atomvmlib.avm`, and `exavmlib.avm` reproducibly.

Decision: do not merge the branch as-is. Rebuild the useful `apps/lattice_tab` pieces after Task 1-3 below, because canonical cross-runtime bytes and stable carrier wire frames are prerequisites for a meaningful browser realm.

---

## File Structure

- Create `apps/lattice_core/lib/lattice/canonical.ex`: deterministic, versioned canonical encoder for the allowed Lattice term subset.
- Modify `apps/lattice_core/lib/lattice/op.ex`: route op id/signature bytes through `Lattice.Canonical`.
- Modify `apps/lattice_core/lib/lattice/authority/delegation.ex`: route delegation id/signature bytes through `Lattice.Canonical`.
- Create `apps/lattice_core/lib/lattice/carrier/wire.ex`: versioned wire encoding/decoding for ops, reports, frontier adverts, live payloads, and protocol errors.
- Modify `apps/lattice_node_spike/lib/lattice_node_spike/wire.ex`: delegate to `Lattice.Carrier.Wire` and delete BEAM-term transport assumptions.
- Modify `apps/lattice_node_spike/lib/lattice_node_spike/ws_carrier.ex` and `ws_handler.ex`: use the shared carrier wire, bounded batches, and session handshake.
- Create `apps/lattice_core/lib/lattice/carrier/session.ex`: signed session challenge/response helpers.
- Create `apps/lattice_core/lib/lattice/carrier/backoff.ex`: deterministic capped exponential backoff with jitter.
- Create `apps/lattice_core/lib/lattice/sync/shape.ex`: partial-sync shape definitions plus dependency closure.
- Modify `apps/lattice_core/lib/lattice/sync.ex`: add `missing/3` and leave `missing/2` as `all`.
- Create `apps/lattice_core/lib/lattice/carrier/batch.ex`: split op transfers by encoded byte budget and merge reports.
- Create `apps/lattice_core/lib/lattice/carrier/membership.ex`: peer membership, frontier acknowledgement, and stable-frontier helper for compaction.
- Create `apps/lattice_core/lib/lattice/browser_log_store.ex`: a storage behaviour for browser/remote realm log persistence.
- Create `examples/atomvm_tab/log-store.js`: IndexedDB implementation of the browser storage behaviour's JSON contract.
- Modify `docs/adr/0001-canonical-encoding.md`, `docs/adr/0005-carrier-interface.md`, `docs/path_to_real.md`, and `docs/threat_model_v2.md`: update the M2 boundary and remove stale term-format-only carrier claims.
- Tests: add focused tests beside each new module and extend `apps/lattice_node_spike/test/node_carrier_spike_test.exs`.

---

## Task 1: Canonical Bytes For Cross-Runtime Ops

**Files:**
- Create: `apps/lattice_core/lib/lattice/canonical.ex`
- Modify: `apps/lattice_core/lib/lattice/op.ex`
- Modify: `apps/lattice_core/lib/lattice/authority/delegation.ex`
- Test: `apps/lattice_core/test/lattice2/canonical_encoding_test.exs`

- [ ] **Step 1: Write failing canonical tests**

Create `apps/lattice_core/test/lattice2/canonical_encoding_test.exs`:

```elixir
defmodule Lattice.CanonicalEncodingTest do
  use ExUnit.Case, async: true

  alias Lattice.{Canonical, Identity, Op}
  alias Lattice.Authority.Delegation

  test "map insertion order does not change canonical bytes" do
    left = %{b: 2, a: 1, nested: %{z: "z", a: "a"}}
    right = %{nested: %{a: "a", z: "z"}, a: 1, b: 2}

    assert Canonical.term(left) == Canonical.term(right)
  end

  test "unsupported local terms are rejected before signing" do
    assert_raise ArgumentError, ~r/unsupported canonical term/, fn ->
      Canonical.term({:bad, self()})
    end

    assert_raise ArgumentError, ~r/unsupported canonical term/, fn ->
      Canonical.term({:bad, make_ref()})
    end
  end

  test "op id and signature use canonical bytes" do
    id = Identity.from_seed("alice", "m2-canonical")
    op = Op.new(id, "replica:m2", ["b", "a", "a"], :command, {:post, "hi"}, cap: %{d: "cap"})

    assert op.deps == ["a", "b"]
    assert Op.valid?(op)
    assert Op.canonical_encoding(op) == Canonical.op_payload(op)
    assert Op.recompute_id(op) == op.id
  end

  test "delegation id and signature use canonical bytes" do
    issuer = Identity.from_seed("issuer", "m2-canonical")
    audience = Identity.from_seed("audience", "m2-canonical")

    d1 = Delegation.new(issuer, "replica:m2", audience.pub, ops: [:post, :join], roles: [:moderator])
    d2 = %{d1 | ops: MapSet.new([:join, :post]), roles: MapSet.new([:moderator])}

    assert Delegation.valid_sig?(d1)
    assert Delegation.valid_sig?(d2)
    assert d1.id == d2.id
  end
end
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
~/.asdf/shims/mix test apps/lattice_core/test/lattice2/canonical_encoding_test.exs
```

Expected: compile failure because `Lattice.Canonical` does not exist.

- [ ] **Step 3: Implement `Lattice.Canonical`**

Create `apps/lattice_core/lib/lattice/canonical.ex`:

```elixir
defmodule Lattice.Canonical do
  @moduledoc """
  Deterministic canonical bytes for signed Lattice values.

  This is a deliberately small CBOR-shaped subset for the Lattice term domain:
  nil, booleans, non-negative integers, binaries, atoms, lists, tuples, and maps.
  Maps sort by their fully encoded key bytes. Local BEAM terms such as pid/ref/fun,
  floats, ports, and negative integers are rejected before signing.
  """

  @suite "lattice-cbor-v1"
  @op_tag "lattice-op-v2"
  @delegation_tag "lattice-delegation-v2"

  def suite, do: @suite

  def op_payload(%Lattice.Op{} = op) do
    op_bytes(op.replica, op.author, Lattice.Op.normalize_deps(op.deps), op.kind, op.body, op.cap)
  end

  def op_bytes(replica, author, deps, kind, body, cap) do
    term([@op_tag, replica, author, deps, kind, body, cap])
  end

  def delegation_payload(%Lattice.Authority.Delegation{} = d) do
    delegation_bytes(d.replica, d.issuer, d.audience, d.parent_id, d.ops, d.roles, d.live)
  end

  def delegation_bytes(replica, issuer, audience, parent_id, ops, roles, live) do
    term([@delegation_tag, replica, issuer, audience, parent_id, Enum.sort(ops), Enum.sort(roles), live])
  end

  def term(value), do: encode(value)

  defp encode(nil), do: <<0xF6>>
  defp encode(false), do: <<0xF4>>
  defp encode(true), do: <<0xF5>>
  defp encode(int) when is_integer(int) and int >= 0, do: major(0, int)
  defp encode(bin) when is_binary(bin), do: major(2, byte_size(bin)) <> bin
  defp encode(atom) when is_atom(atom), do: encode_tagged("atom", Atom.to_string(atom))

  defp encode(list) when is_list(list) do
    major(4, length(list)) <> IO.iodata_to_binary(Enum.map(list, &encode/1))
  end

  defp encode(tuple) when is_tuple(tuple) do
    tuple |> Tuple.to_list() |> then(&encode_tagged("tuple", &1))
  end

  defp encode(%MapSet{} = set), do: set |> MapSet.to_list() |> Enum.sort() |> encode()

  defp encode(map) when is_map(map) do
    pairs =
      map
      |> Enum.map(fn {k, v} -> {encode(k), encode(v)} end)
      |> Enum.sort_by(fn {k, _v} -> k end)

    major(5, length(pairs)) <> IO.iodata_to_binary(Enum.map(pairs, fn {k, v} -> k <> v end))
  end

  defp encode(other) do
    raise ArgumentError, "unsupported canonical term: #{inspect(other)}"
  end

  defp encode_tagged(tag, value), do: encode([tag, value])

  defp major(major, n) when n < 24, do: <<major::3, n::5>>
  defp major(major, n) when n < 256, do: <<major::3, 24::5, n>>
  defp major(major, n) when n < 65_536, do: <<major::3, 25::5, n::16>>
  defp major(major, n) when n < 4_294_967_296, do: <<major::3, 26::5, n::32>>
  defp major(major, n), do: <<major::3, 27::5, n::64>>
end
```

- [ ] **Step 4: Route op and delegation signing through `Lattice.Canonical`**

In `apps/lattice_core/lib/lattice/op.ex`, replace the private `canonical_bytes/6` body with:

```elixir
defp canonical_bytes(replica, author, deps, kind, body, cap) do
  Lattice.Canonical.op_bytes(replica, author, deps, kind, body, cap)
end
```

In `apps/lattice_core/lib/lattice/authority/delegation.ex`, replace the private `encode/7` body with:

```elixir
defp encode(replica, issuer, audience, parent_id, ops, roles, live) do
  Lattice.Canonical.delegation_bytes(replica, issuer, audience, parent_id, ops, roles, live)
end
```

- [ ] **Step 5: Run focused and regression tests**

Run:

```bash
~/.asdf/shims/mix test apps/lattice_core/test/lattice2/canonical_encoding_test.exs \
  apps/lattice_core/test/lattice2/authority_test.exs \
  apps/lattice_core/test/lattice2/convergence_property_test.exs
```

Expected: all pass. If existing fixture ids changed, update only tests that hard-coded old ids; do not weaken signature/id validity assertions.

- [ ] **Step 6: Commit**

```bash
git add apps/lattice_core/lib/lattice/canonical.ex \
  apps/lattice_core/lib/lattice/op.ex \
  apps/lattice_core/lib/lattice/authority/delegation.ex \
  apps/lattice_core/test/lattice2/canonical_encoding_test.exs
git commit -m "feat(carrier): add canonical cross-runtime bytes"
```

---

## Task 2: Shared Carrier Wire Frames

**Files:**
- Create: `apps/lattice_core/lib/lattice/carrier/wire.ex`
- Test: `apps/lattice_core/test/lattice2/carrier_wire_test.exs`
- Modify: `apps/lattice_node_spike/lib/lattice_node_spike/wire.ex`
- Modify: `apps/lattice_node_spike/lib/lattice_node_spike/ws_carrier.ex`
- Modify: `apps/lattice_node_spike/lib/lattice_node_spike/ws_handler.ex`

- [ ] **Step 1: Write failing wire tests**

Create `apps/lattice_core/test/lattice2/carrier_wire_test.exs`:

```elixir
defmodule Lattice.CarrierWireTest do
  use ExUnit.Case, async: true

  alias Lattice.{Carrier.Wire, Identity, Op, Sync}

  test "op frames round-trip without deciding integrity" do
    id = Identity.from_seed("alice", "carrier-wire")
    op = Op.new(id, "replica:wire", [], :command, {:post, "hello"})

    assert {:ok, ^op} = op |> Wire.encode_op() |> Wire.decode_op()
  end

  test "malformed op frame is rejected before Log.accept" do
    assert {:error, :malformed_op} = Wire.decode_op(%{"v" => 1, "kind" => "not_existing"})
    assert {:error, :malformed_op} = Wire.decode_op(%{"v" => 99})
  end

  test "reports round-trip with existing atoms only" do
    report = %{accepted: ["a"], quarantined: [{"b", :bad_signature}], rejected: [], pending: ["c"]}
    assert Wire.decode_report(Wire.encode_report(report)) == report
  end

  test "stats frame is JSON-safe" do
    report = %{accepted: [], quarantined: [], rejected: [], pending: []}
    frame = Wire.encode_push_result(report)

    assert frame["type"] == "push_result"
    assert frame["accepted"] == []
    assert frame["quarantined"] == []
  end
end
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_wire_test.exs
```

Expected: compile failure because `Lattice.Carrier.Wire` does not exist.

- [ ] **Step 3: Implement `Lattice.Carrier.Wire`**

Create `apps/lattice_core/lib/lattice/carrier/wire.ex` with these public functions:

```elixir
defmodule Lattice.Carrier.Wire do
  @moduledoc """
  Versioned carrier wire frames. This module serializes complete `%Lattice.Op{}`
  structs for transport; integrity is still decided by `Lattice.Log.accept/2`.
  """

  alias Lattice.Op
  alias Lattice.Authority.Delegation

  @version 1

  def encode_op(%Op{} = op) do
    %{
      "v" => @version,
      "id" => op.id,
      "replica" => op.replica,
      "author" => Base.encode64(op.author),
      "deps" => op.deps,
      "kind" => Atom.to_string(op.kind),
      "body" => encode_term(op.body),
      "cap" => encode_term(op.cap),
      "sig" => Base.encode64(op.sig)
    }
  end

  def decode_op(%{"v" => @version, "id" => id, "replica" => replica, "author" => author_b64, "deps" => deps, "kind" => kind, "body" => body, "cap" => cap, "sig" => sig_b64})
      when is_binary(id) and is_binary(replica) and is_list(deps) do
    with {:ok, author} <- Base.decode64(author_b64),
         {:ok, sig} <- Base.decode64(sig_b64),
         {:ok, kind} <- existing_atom(kind),
         {:ok, body} <- decode_term(body),
         {:ok, cap} <- decode_term(cap) do
      {:ok, %Op{id: id, replica: replica, author: author, deps: deps, kind: kind, body: body, cap: cap, sig: sig}}
    else
      _ -> {:error, :malformed_op}
    end
  end

  def decode_op(_), do: {:error, :malformed_op}

  def encode_ops(ops), do: Enum.map(ops, &encode_op/1)

  def decode_ops(list) when is_list(list) do
    Enum.reduce_while(list, {:ok, []}, fn item, {:ok, acc} ->
      case decode_op(item) do
        {:ok, op} -> {:cont, {:ok, [op | acc]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, ops} -> {:ok, Enum.reverse(ops)}
      {:error, _} = err -> err
    end
  end

  def decode_ops(_), do: {:error, :malformed_op}

  def encode_report(%{accepted: accepted, quarantined: quarantined, rejected: rejected, pending: pending}) do
    %{
      "accepted" => accepted,
      "quarantined" => encode_reason_pairs(quarantined),
      "rejected" => encode_reason_pairs(rejected),
      "pending" => pending
    }
  end

  def encode_push_result(report), do: Map.put(encode_report(report), "type", "push_result")

  def decode_report(%{"accepted" => accepted, "quarantined" => quarantined, "rejected" => rejected, "pending" => pending}) do
    %{
      accepted: accepted,
      quarantined: decode_reason_pairs(quarantined),
      rejected: decode_reason_pairs(rejected),
      pending: pending
    }
  end

  def version, do: @version

  defp encode_reason_pairs(pairs), do: Enum.map(pairs, fn {id, reason} -> [id, Atom.to_string(reason)] end)
  defp decode_reason_pairs(pairs), do: Enum.map(pairs, fn [id, reason] -> {id, String.to_existing_atom(reason)} end)

  defp encode_term(nil), do: ["nil"]
  defp encode_term(value) when is_boolean(value), do: ["bool", value]
  defp encode_term(value) when is_integer(value), do: ["int", value]
  defp encode_term(value) when is_binary(value), do: ["bin", Base.encode64(value)]
  defp encode_term(value) when is_atom(value), do: ["atom", Atom.to_string(value)]
  defp encode_term(value) when is_list(value), do: ["list", Enum.map(value, &encode_term/1)]
  defp encode_term(value) when is_tuple(value), do: ["tuple", value |> Tuple.to_list() |> Enum.map(&encode_term/1)]
  defp encode_term(%MapSet{} = value), do: ["mapset", value |> MapSet.to_list() |> Enum.sort() |> Enum.map(&encode_term/1)]
  defp encode_term(%Delegation{} = d), do: ["delegation", encode_delegation(d)]
  defp encode_term(value) when is_map(value), do: ["map", Enum.map(value, fn {k, v} -> [encode_term(k), encode_term(v)] end)]

  defp decode_term(["nil"]), do: {:ok, nil}
  defp decode_term(["bool", value]) when is_boolean(value), do: {:ok, value}
  defp decode_term(["int", value]) when is_integer(value), do: {:ok, value}
  defp decode_term(["bin", value]) when is_binary(value), do: Base.decode64(value)
  defp decode_term(["atom", value]) when is_binary(value), do: existing_atom(value)
  defp decode_term(["list", values]) when is_list(values), do: decode_list(values)
  defp decode_term(["tuple", values]) when is_list(values), do: with({:ok, values} <- decode_list(values), do: {:ok, List.to_tuple(values)})
  defp decode_term(["mapset", values]) when is_list(values), do: with({:ok, values} <- decode_list(values), do: {:ok, MapSet.new(values)})
  defp decode_term(["delegation", value]) when is_map(value), do: decode_delegation(value)
  defp decode_term(["map", pairs]) when is_list(pairs), do: decode_map(pairs)
  defp decode_term(_), do: {:error, :malformed_term}

  defp decode_list(values), do: reduce_decode(values, [])

  defp decode_map(pairs) do
    Enum.reduce_while(pairs, {:ok, %{}}, fn [k, v], {:ok, acc} ->
      with {:ok, k} <- decode_term(k), {:ok, v} <- decode_term(v) do
        {:cont, {:ok, Map.put(acc, k, v)}}
      else
        _ -> {:halt, {:error, :malformed_term}}
      end
    end)
  end

  defp reduce_decode([], acc), do: {:ok, Enum.reverse(acc)}
  defp reduce_decode([value | rest], acc), do: with({:ok, value} <- decode_term(value), do: reduce_decode(rest, [value | acc]))

  defp encode_delegation(%Delegation{} = d) do
    %{"id" => d.id, "replica" => d.replica, "issuer" => Base.encode64(d.issuer), "audience" => Base.encode64(d.audience), "parent_id" => d.parent_id, "ops" => Enum.map(d.ops, &Atom.to_string/1), "roles" => Enum.map(d.roles, &Atom.to_string/1), "live" => d.live, "sig" => Base.encode64(d.sig)}
  end

  defp decode_delegation(%{"id" => id, "replica" => replica, "issuer" => issuer_b64, "audience" => audience_b64, "ops" => ops, "roles" => roles, "live" => live, "sig" => sig_b64} = frame) do
    with {:ok, issuer} <- Base.decode64(issuer_b64),
         {:ok, audience} <- Base.decode64(audience_b64),
         {:ok, sig} <- Base.decode64(sig_b64),
         {:ok, ops} <- existing_atoms(ops),
         {:ok, roles} <- existing_atoms(roles) do
      {:ok, %Delegation{id: id, replica: replica, issuer: issuer, audience: audience, parent_id: Map.get(frame, "parent_id"), ops: MapSet.new(ops), roles: MapSet.new(roles), live: live, sig: sig}}
    end
  end

  defp existing_atoms(values), do: reduce_atoms(values, [])
  defp reduce_atoms([], acc), do: {:ok, Enum.reverse(acc)}
  defp reduce_atoms([value | rest], acc), do: with({:ok, atom} <- existing_atom(value), do: reduce_atoms(rest, [atom | acc]))

  defp existing_atom(value) when is_binary(value), do: {:ok, String.to_existing_atom(value)}
rescue
  ArgumentError -> {:error, :unknown_atom}
end
```

No `binary_to_term` is allowed in `Lattice.Carrier.Wire`; browser and AtomVM peers must be able to construct the same JSON-safe frame shape.

- [ ] **Step 4: Delegate the node spike wire to the shared module**

In `apps/lattice_node_spike/lib/lattice_node_spike/wire.ex`, replace the implementation with:

```elixir
defmodule LatticeNodeSpike.Wire do
  @moduledoc false

  alias Lattice.Carrier.Wire

  defdelegate encode(op), to: Wire, as: :encode_op
  defdelegate decode(encoded), to: Wire, as: :decode_op
  defdelegate decode_all(encoded), to: Wire, as: :decode_ops
end
```

- [ ] **Step 5: Run carrier tests**

Run:

```bash
~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_wire_test.exs \
  apps/lattice_core/test/lattice2/carrier_test.exs \
  apps/lattice_node_spike/test/node_carrier_spike_test.exs
```

Expected: all pass, including the node spike's tamper/quarantine assertion.

- [ ] **Step 6: Commit**

```bash
git add apps/lattice_core/lib/lattice/carrier/wire.ex \
  apps/lattice_core/test/lattice2/carrier_wire_test.exs \
  apps/lattice_node_spike/lib/lattice_node_spike/wire.ex
git commit -m "feat(carrier): centralize wire frames"
```

---

## Task 3: Authenticated Carrier Sessions

**Files:**
- Create: `apps/lattice_core/lib/lattice/carrier/session.ex`
- Test: `apps/lattice_core/test/lattice2/carrier_session_test.exs`
- Modify: `apps/lattice_node_spike/lib/lattice_node_spike/ws_carrier.ex`
- Modify: `apps/lattice_node_spike/lib/lattice_node_spike/ws_handler.ex`
- Modify: `apps/lattice_node_spike/priv/peer_node.exs`

- [ ] **Step 1: Write failing session tests**

Create `apps/lattice_core/test/lattice2/carrier_session_test.exs`:

```elixir
defmodule Lattice.CarrierSessionTest do
  use ExUnit.Case, async: true

  alias Lattice.{Carrier.Session, Identity}

  test "challenge response binds realm, replica, nonce, and wire version" do
    identity = Identity.from_seed("node-a", "carrier-session")
    challenge = Session.challenge("server", "replica:session", wire_version: 1)
    response = Session.respond(challenge, identity, "node-a")

    assert :ok = Session.verify_response(challenge, response, expected_realm: "node-a", expected_pubkey: identity.pub)
  end

  test "wrong realm or wrong key is rejected" do
    identity = Identity.from_seed("node-a", "carrier-session")
    other = Identity.from_seed("node-b", "carrier-session")
    challenge = Session.challenge("server", "replica:session", wire_version: 1)
    response = Session.respond(challenge, identity, "node-a")

    assert {:error, :wrong_realm} =
             Session.verify_response(challenge, response, expected_realm: "node-b", expected_pubkey: identity.pub)

    assert {:error, :bad_signature} =
             Session.verify_response(challenge, response, expected_realm: "node-a", expected_pubkey: other.pub)
  end
end
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_session_test.exs
```

Expected: compile failure because `Lattice.Carrier.Session` does not exist.

- [ ] **Step 3: Implement signed session helpers**

Create `apps/lattice_core/lib/lattice/carrier/session.ex`:

```elixir
defmodule Lattice.Carrier.Session do
  @moduledoc """
  Stateless signed challenge/response for carrier connection setup.
  Connection lifecycle stays transport-specific; this module only defines the
  transcript bytes and verification result.
  """

  alias Lattice.Identity

  def challenge(local_realm, replica, opts \\ []) do
    %{
      "type" => "carrier_challenge",
      "local_realm" => local_realm,
      "replica" => replica,
      "nonce" => Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false),
      "wire_version" => Keyword.fetch!(opts, :wire_version)
    }
  end

  def respond(%{} = challenge, %Identity{} = identity, realm) do
    bytes = transcript(challenge, realm, identity.pub)

    %{
      "type" => "carrier_hello",
      "realm" => realm,
      "pubkey" => Base.encode64(identity.pub),
      "signature" => identity |> Identity.sign(bytes) |> Base.encode64()
    }
  end

  def verify_response(challenge, response, opts) do
    expected_realm = Keyword.fetch!(opts, :expected_realm)
    expected_pubkey = Keyword.fetch!(opts, :expected_pubkey)

    with %{"realm" => ^expected_realm, "pubkey" => pub_b64, "signature" => sig_b64} <- response,
         {:ok, claimed_pubkey} <- Base.decode64(pub_b64),
         true <- claimed_pubkey == expected_pubkey,
         {:ok, sig} <- Base.decode64(sig_b64),
         true <- Identity.verify(expected_pubkey, transcript(challenge, expected_realm, expected_pubkey), sig) do
      :ok
    else
      %{"realm" => _other} -> {:error, :wrong_realm}
      false -> {:error, :bad_signature}
      _ -> {:error, :malformed_session}
    end
  end

  def transcript(challenge, realm, pubkey) do
    Lattice.Canonical.term([
      "carrier-session-v1",
      challenge["local_realm"],
      challenge["replica"],
      challenge["nonce"],
      challenge["wire_version"],
      realm,
      pubkey
    ])
  end
end
```

- [ ] **Step 4: Wire handshake into the node spike**

In `WsCarrier.connect/1`, accept `:identity`, `:realm`, `:peer_realm`, `:peer_pubkey`, and `:replica`. After opening `/carrier`, send a `"carrier_challenge"` request and verify the peer's `"carrier_hello"` response before returning `{:ok, %WsCarrier{}}`.

In `WsHandler`, handle `"carrier_challenge"` by responding with `Session.respond(challenge, peer_identity, peer_realm)`. Store the peer identity in `Peer` state by changing `Peer.start_link(realm: realm)` to accept `identity: Lattice.Identity.from_seed(realm, "carrier-spike")`.

Add a node-spike assertion:

```elixir
assert {:error, :bad_signature} =
         WsCarrier.connect(port: ws_port, realm: "node_b", peer_realm: "node_a", peer_pubkey: wrong_pubkey)
```

- [ ] **Step 5: Run tests**

Run:

```bash
~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_session_test.exs \
  apps/lattice_node_spike/test/node_carrier_spike_test.exs
```

Expected: all pass; wrong peer keys fail before sync callbacks run.

- [ ] **Step 6: Commit**

```bash
git add apps/lattice_core/lib/lattice/carrier/session.ex \
  apps/lattice_core/test/lattice2/carrier_session_test.exs \
  apps/lattice_node_spike/lib/lattice_node_spike/ws_carrier.ex \
  apps/lattice_node_spike/lib/lattice_node_spike/ws_handler.ex \
  apps/lattice_node_spike/priv/peer_node.exs \
  apps/lattice_node_spike/test/node_carrier_spike_test.exs
git commit -m "feat(carrier): authenticate carrier sessions"
```

---

## Task 4: Reconnect And Backoff Contract

**Files:**
- Create: `apps/lattice_core/lib/lattice/carrier/backoff.ex`
- Test: `apps/lattice_core/test/lattice2/carrier_backoff_test.exs`
- Modify: `apps/lattice_node_spike/test/node_carrier_spike_test.exs`

- [ ] **Step 1: Write failing backoff tests**

Create `apps/lattice_core/test/lattice2/carrier_backoff_test.exs`:

```elixir
defmodule Lattice.CarrierBackoffTest do
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Backoff

  test "capped exponential delays are deterministic for a seed" do
    b = Backoff.new(base_ms: 100, max_ms: 1_000, jitter_ms: 25, seed: "peer-a")

    assert Enum.map(0..5, &Backoff.delay_ms(b, &1)) == Enum.map(0..5, &Backoff.delay_ms(b, &1))
    assert Backoff.delay_ms(b, 0) in 75..125
    assert Backoff.delay_ms(b, 5) in 975..1_025
  end

  test "reset brings delay back to first attempt" do
    b = Backoff.new(base_ms: 50, max_ms: 500, jitter_ms: 0, seed: "peer-a")

    assert Backoff.delay_ms(b, 0) == 50
    assert Backoff.delay_ms(b, 4) == 500
    assert Backoff.delay_ms(b, Backoff.reset_attempt()) == 50
  end
end
```

- [ ] **Step 2: Implement `Lattice.Carrier.Backoff`**

Create `apps/lattice_core/lib/lattice/carrier/backoff.ex`:

```elixir
defmodule Lattice.Carrier.Backoff do
  @moduledoc "Deterministic capped exponential backoff for reconnect loops."

  @enforce_keys [:base_ms, :max_ms, :jitter_ms, :seed]
  defstruct [:base_ms, :max_ms, :jitter_ms, :seed]

  def new(opts) do
    %__MODULE__{
      base_ms: Keyword.fetch!(opts, :base_ms),
      max_ms: Keyword.fetch!(opts, :max_ms),
      jitter_ms: Keyword.get(opts, :jitter_ms, 0),
      seed: Keyword.fetch!(opts, :seed)
    }
  end

  def reset_attempt, do: 0

  def delay_ms(%__MODULE__{} = b, attempt) when attempt >= 0 do
    raw = min(b.max_ms, b.base_ms * Integer.pow(2, attempt))
    raw + jitter(b.seed, attempt, b.jitter_ms)
  end

  defp jitter(_seed, _attempt, 0), do: 0

  defp jitter(seed, attempt, bound) do
    bytes = :crypto.hash(:sha256, "#{seed}:#{attempt}")
    <<n::32, _::binary>> = bytes
    rem(n, bound * 2 + 1) - bound
  end
end
```

- [ ] **Step 3: Add node-spike reconnect assertion**

Extend the node spike with a test that closes the socket, attempts reconnect until the peer is `"diverged"`, and asserts no tight loop by checking at least one scheduled delay is non-zero using `Backoff.delay_ms/2`.

- [ ] **Step 4: Run tests**

```bash
~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_backoff_test.exs \
  apps/lattice_node_spike/test/node_carrier_spike_test.exs
```

- [ ] **Step 5: Commit**

```bash
git add apps/lattice_core/lib/lattice/carrier/backoff.ex \
  apps/lattice_core/test/lattice2/carrier_backoff_test.exs \
  apps/lattice_node_spike/test/node_carrier_spike_test.exs
git commit -m "feat(carrier): define reconnect backoff"
```

---

## Task 5: Partial Sync Shapes With Dependency Closure

**Files:**
- Create: `apps/lattice_core/lib/lattice/sync/shape.ex`
- Modify: `apps/lattice_core/lib/lattice/sync.ex`
- Test: `apps/lattice_core/test/lattice2/sync_shape_test.exs`

- [ ] **Step 1: Write failing shape tests**

Create `apps/lattice_core/test/lattice2/sync_shape_test.exs`:

```elixir
defmodule Lattice.SyncShapeTest do
  use ExUnit.Case, async: true

  alias Lattice.{Log, Sim, Sync}
  alias Lattice.Demo.Thread
  alias Lattice.Sync.Shape

  test "all shape preserves existing missing/2 behavior" do
    sim = Sim.new(Thread, "replica:shape", ["a", "b"], seed: "shape")
    {sim, _} = Sim.create_replica(sim, "a")
    {sim, _} = Sim.grant(sim, "a", "b", ops: [:post])
    sim = Sim.sync_all(sim)
    {sim, _} = Sim.command(sim, "a", :post, ["from a"])

    assert Sync.missing(Sim.log(sim, "a"), MapSet.new()) ==
             Sync.missing(Sim.log(sim, "a"), MapSet.new(), Shape.all())
  end

  test "command shape includes selected command ops and causal dependencies" do
    sim = Sim.new(Thread, "replica:shape", ["a", "b"], seed: "shape")
    {sim, genesis} = Sim.create_replica(sim, "a")
    {sim, grant} = Sim.grant(sim, "a", "b", ops: [:post, :set_title])
    sim = Sim.sync_all(sim)
    {sim, post} = Sim.command(sim, "b", :post, ["visible"])
    {sim, title} = Sim.command(sim, "b", :set_title, ["not selected"])

    ids = sim |> Sim.log("b") |> Sync.missing(MapSet.new(), Shape.commands([:post])) |> Enum.map(& &1.id)

    assert post.id in ids
    assert genesis.id in ids
    assert grant.id in ids
    refute title.id in ids
  end
end
```

- [ ] **Step 2: Implement `Shape` and `missing/3`**

Create `apps/lattice_core/lib/lattice/sync/shape.ex`:

```elixir
defmodule Lattice.Sync.Shape do
  @moduledoc "Partial-sync selectors. Selected ops are expanded to dependency closure."

  defstruct [:mode, args: []]

  def all, do: %__MODULE__{mode: :all}
  def commands(names) when is_list(names), do: %__MODULE__{mode: :commands, args: MapSet.new(names)}

  def selected?(%__MODULE__{mode: :all}, _op), do: true
  def selected?(%__MODULE__{mode: :commands, args: names}, %{kind: :command, body: {name, _args}}), do: MapSet.member?(names, name)
  def selected?(%__MODULE__{mode: :commands, args: names}, %{kind: :command, body: {name}}), do: MapSet.member?(names, name)
  def selected?(%__MODULE__{mode: :commands}, %{kind: :authority}), do: true
  def selected?(%__MODULE__{}, _op), do: false
end
```

Modify `apps/lattice_core/lib/lattice/sync.ex`:

```elixir
def missing(%Log{} = source, %MapSet{} = have), do: missing(source, have, Lattice.Sync.Shape.all())

def missing(%Log{} = source, %MapSet{} = have, %Lattice.Sync.Shape{} = shape) do
  selected_ids =
    source
    |> Log.topo_ops()
    |> Enum.filter(&Lattice.Sync.Shape.selected?(shape, &1))
    |> MapSet.new(& &1.id)

  closure = dependency_closure(source, selected_ids)

  source
  |> Log.topo_ops()
  |> Enum.filter(&(MapSet.member?(closure, &1.id) and not MapSet.member?(have, &1.id)))
end

defp dependency_closure(%Log{} = log, ids) do
  by_id = Log.ops(log)
  do_dependency_closure(by_id, MapSet.to_list(ids), MapSet.new())
end

defp do_dependency_closure(_by_id, [], acc), do: acc

defp do_dependency_closure(by_id, [id | rest], acc) do
  if MapSet.member?(acc, id) do
    do_dependency_closure(by_id, rest, acc)
  else
    case Map.fetch(by_id, id) do
      {:ok, op} -> do_dependency_closure(by_id, op.deps ++ rest, MapSet.put(acc, id))
      :error -> do_dependency_closure(by_id, rest, MapSet.put(acc, id))
    end
  end
end
```

- [ ] **Step 3: Run tests**

```bash
~/.asdf/shims/mix test apps/lattice_core/test/lattice2/sync_shape_test.exs \
  apps/lattice_core/test/lattice2/carrier_test.exs \
  apps/lattice_core/test/lattice2/convergence_property_test.exs
```

- [ ] **Step 4: Commit**

```bash
git add apps/lattice_core/lib/lattice/sync.ex \
  apps/lattice_core/lib/lattice/sync/shape.ex \
  apps/lattice_core/test/lattice2/sync_shape_test.exs
git commit -m "feat(sync): add partial sync shapes"
```

---

## Task 6: Batching And Backpressure

**Files:**
- Create: `apps/lattice_core/lib/lattice/carrier/batch.ex`
- Test: `apps/lattice_core/test/lattice2/carrier_batch_test.exs`
- Modify: `apps/lattice_node_spike/lib/lattice_node_spike/ws_carrier.ex`
- Modify: `apps/lattice_node_spike/lib/lattice_node_spike/ws_handler.ex`

- [ ] **Step 1: Write failing batch tests**

Create `apps/lattice_core/test/lattice2/carrier_batch_test.exs`:

```elixir
defmodule Lattice.CarrierBatchTest do
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Batch

  test "splits by max op count" do
    assert Batch.chunk([1, 2, 3, 4, 5], max_ops: 2, size_fun: fn _ -> 1 end, max_bytes: 100) ==
             [[1, 2], [3, 4], [5]]
  end

  test "splits by encoded bytes" do
    chunks = Batch.chunk(["aaaa", "bbbb", "c"], max_ops: 10, size_fun: &byte_size/1, max_bytes: 5)
    assert chunks == [["aaaa"], ["bbbb", "c"]]
  end

  test "merges sync reports preserving order" do
    reports = [
      %{accepted: ["a"], quarantined: [], rejected: [], pending: []},
      %{accepted: ["b"], quarantined: [{"c", :bad_signature}], rejected: [], pending: ["d"]}
    ]

    assert Batch.merge_reports(reports) == %{
             accepted: ["a", "b"],
             quarantined: [{"c", :bad_signature}],
             rejected: [],
             pending: ["d"]
           }
  end
end
```

- [ ] **Step 2: Implement `Batch`**

Create `apps/lattice_core/lib/lattice/carrier/batch.ex`:

```elixir
defmodule Lattice.Carrier.Batch do
  @moduledoc "Bounded transfer batches for carrier push/pull frames."

  def chunk(items, opts) do
    max_ops = Keyword.fetch!(opts, :max_ops)
    max_bytes = Keyword.fetch!(opts, :max_bytes)
    size_fun = Keyword.fetch!(opts, :size_fun)

    {chunks, current, _count, _bytes} =
      Enum.reduce(items, {[], [], 0, 0}, fn item, {chunks, current, count, bytes} ->
        size = size_fun.(item)

        if current != [] and (count >= max_ops or bytes + size > max_bytes) do
          {[Enum.reverse(current) | chunks], [item], 1, size}
        else
          {chunks, [item | current], count + 1, bytes + size}
        end
      end)

    (if current == [], do: chunks, else: [Enum.reverse(current) | chunks])
    |> Enum.reverse()
  end

  def merge_reports(reports) do
    Enum.reduce(reports, %{accepted: [], quarantined: [], rejected: [], pending: []}, fn report, acc ->
      %{
        accepted: acc.accepted ++ report.accepted,
        quarantined: acc.quarantined ++ report.quarantined,
        rejected: acc.rejected ++ report.rejected,
        pending: acc.pending ++ report.pending
      }
    end)
  end
end
```

- [ ] **Step 3: Use batches in `WsCarrier.push/2`**

In `apps/lattice_node_spike/lib/lattice_node_spike/ws_carrier.ex`, split `ops` before sending:

```elixir
batches =
  Lattice.Carrier.Batch.chunk(ops,
    max_ops: 64,
    max_bytes: 64_000,
    size_fun: fn op -> op |> Wire.encode() |> Jason.encode!() |> byte_size() end
  )
```

Send each batch as a separate `"push"` request, collect reports, and return `Batch.merge_reports(reports)`.

- [ ] **Step 4: Add node-spike large-transfer assertion**

Extend `node_carrier_spike_test.exs` with a scenario that authors at least 150 small posts on one side, syncs, and asserts the peer converges and no single push frame exceeds 65_536 bytes. Instrument `WsCarrier` in test mode by returning a `batch_count` in stats or by exposing `WsCarrier.last_push_batches/1`.

- [ ] **Step 5: Run tests**

```bash
~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_batch_test.exs \
  apps/lattice_node_spike/test/node_carrier_spike_test.exs
```

- [ ] **Step 6: Commit**

```bash
git add apps/lattice_core/lib/lattice/carrier/batch.ex \
  apps/lattice_core/test/lattice2/carrier_batch_test.exs \
  apps/lattice_node_spike/lib/lattice_node_spike/ws_carrier.ex \
  apps/lattice_node_spike/lib/lattice_node_spike/ws_handler.ex \
  apps/lattice_node_spike/test/node_carrier_spike_test.exs
git commit -m "feat(carrier): batch large transfers"
```

---

## Task 7: Membership Acknowledgements For Compaction GC

**Files:**
- Create: `apps/lattice_core/lib/lattice/carrier/membership.ex`
- Test: `apps/lattice_core/test/lattice2/carrier_membership_test.exs`
- Modify: `docs/adr/0006-compaction.md`

- [ ] **Step 1: Write failing membership tests**

Create `apps/lattice_core/test/lattice2/carrier_membership_test.exs`:

```elixir
defmodule Lattice.CarrierMembershipTest do
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Membership

  test "frontier is stable only after every current participant acknowledges it" do
    m =
      Membership.new(["a", "b", "c"])
      |> Membership.ack("a", ["f1", "f2"])
      |> Membership.ack("b", ["f2", "f1"])

    refute Membership.stable_frontier?(m, ["f1", "f2"])

    m = Membership.ack(m, "c", ["f1", "f2"])
    assert Membership.stable_frontier?(m, ["f2", "f1"])
  end

  test "leaving participant stops blocking future frontiers but is recorded" do
    m =
      Membership.new(["a", "b"])
      |> Membership.leave("b")
      |> Membership.ack("a", ["f"])

    assert Membership.stable_frontier?(m, ["f"])
    assert Membership.left(m) == MapSet.new(["b"])
  end
end
```

- [ ] **Step 2: Implement `Membership`**

Create `apps/lattice_core/lib/lattice/carrier/membership.ex`:

```elixir
defmodule Lattice.Carrier.Membership do
  @moduledoc """
  Minimal participant/frontier acknowledgement state for carrier-driven compaction GC.
  This does not compact logs; it answers whether a frontier has been acknowledged
  by every current participant.
  """

  defstruct current: MapSet.new(), left: MapSet.new(), acks: %{}

  def new(realms), do: %__MODULE__{current: MapSet.new(realms)}
  def left(%__MODULE__{left: left}), do: left

  def ack(%__MODULE__{} = m, realm, frontier) do
    %{m | acks: Map.put(m.acks, realm, normalize(frontier))}
  end

  def leave(%__MODULE__{} = m, realm) do
    %{m | current: MapSet.delete(m.current, realm), left: MapSet.put(m.left, realm)}
  end

  def stable_frontier?(%__MODULE__{} = m, frontier) do
    frontier = normalize(frontier)

    Enum.all?(m.current, fn realm ->
      Map.get(m.acks, realm) == frontier
    end)
  end

  defp normalize(frontier), do: frontier |> Enum.uniq() |> Enum.sort()
end
```

- [ ] **Step 3: Update compaction ADR**

In `docs/adr/0006-compaction.md`, add a short "M2 acknowledgement contract" section:

```markdown
## M2 acknowledgement contract

`Lattice.Carrier.Membership` is the production-facing acknowledgement primitive for the
GC rule above. A frontier may be considered carrier-stable only when every current
participant has acknowledged the same normalized frontier. Leaving participants stop
blocking future frontiers but remain recorded in membership history. This still does
not make snapshot-only bootstrap trusted; snapshot signatures/quorum remain separate.
```

- [ ] **Step 4: Run tests**

```bash
~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_membership_test.exs \
  apps/lattice_core/test/lattice2/compaction_spike_test.exs
```

- [ ] **Step 5: Commit**

```bash
git add apps/lattice_core/lib/lattice/carrier/membership.ex \
  apps/lattice_core/test/lattice2/carrier_membership_test.exs \
  docs/adr/0006-compaction.md
git commit -m "feat(carrier): add frontier acknowledgements"
```

---

## Task 8: Browser Log Persistence Contract

**Files:**
- Create: `apps/lattice_core/lib/lattice/browser_log_store.ex`
- Test: `apps/lattice_core/test/lattice2/browser_log_store_test.exs`
- Create: `examples/atomvm_tab/log-store.js`

- [ ] **Step 1: Write failing persistence tests**

Create `apps/lattice_core/test/lattice2/browser_log_store_test.exs`:

```elixir
defmodule Lattice.BrowserLogStoreTest do
  use ExUnit.Case, async: true

  alias Lattice.{BrowserLogStore, Log, Sim}
  alias Lattice.Demo.Thread

  test "snapshot payload is JSON-safe and restores a log" do
    sim = Sim.new(Thread, "replica:browser-store", ["tab"], seed: "browser-store")
    {sim, _} = Sim.create_replica(sim, "tab")
    {sim, _} = Sim.command(sim, "tab", :post, ["offline"])
    log = Sim.log(sim, "tab")

    payload = BrowserLogStore.dump_payload(log)

    assert payload["schema"] == "lattice-browser-log-v1"
    assert is_list(payload["ops"])
    assert {:ok, %Log{} = restored} = BrowserLogStore.restore_payload(payload)
    assert Log.op_ids(restored) == Log.op_ids(log)
  end
end
```

- [ ] **Step 2: Implement payload helpers**

Create `apps/lattice_core/lib/lattice/browser_log_store.ex`:

```elixir
defmodule Lattice.BrowserLogStore do
  @moduledoc "JSON-safe dump/restore payloads for browser-held Replica logs."

  alias Lattice.{Carrier.Wire, Log}

  @schema "lattice-browser-log-v1"

  def dump_payload(%Log{} = log) do
    %{
      "schema" => @schema,
      "replica" => log.replica,
      "ops" => log |> Log.topo_ops() |> Enum.map(&Wire.encode_op/1),
      "quarantine" => []
    }
  end

  def restore_payload(%{"schema" => @schema, "replica" => replica, "ops" => encoded}) when is_binary(replica) and is_list(encoded) do
    with {:ok, ops} <- Wire.decode_ops(encoded) do
      {log, _report} = Lattice.Sync.deliver(Log.new(replica), ops)
      {:ok, log}
    end
  end

  def restore_payload(_), do: {:error, :malformed_store}
end
```

- [ ] **Step 3: Add IndexedDB browser adapter**

Create `examples/atomvm_tab/log-store.js`:

```javascript
const DB = "lattice-browser-log-v1";
const STORE = "logs";

export async function saveLog(replica, payload) {
  const db = await openDb();
  await tx(db, "readwrite", (store) => store.put({ replica, payload, saved_at: Date.now() }));
}

export async function loadLog(replica) {
  const db = await openDb();
  const row = await tx(db, "readonly", (store) => store.get(replica));
  return row ? row.payload : null;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "replica" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const txn = db.transaction(STORE, mode);
    const req = fn(txn.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
```

- [ ] **Step 4: Run tests**

```bash
~/.asdf/shims/mix test apps/lattice_core/test/lattice2/browser_log_store_test.exs
```

- [ ] **Step 5: Commit**

```bash
git add apps/lattice_core/lib/lattice/browser_log_store.ex \
  apps/lattice_core/test/lattice2/browser_log_store_test.exs \
  examples/atomvm_tab/log-store.js
git commit -m "feat(browser): define log persistence payloads"
```

---

## Task 9: Documentation And M2 Gate

**Files:**
- Modify: `docs/adr/0001-canonical-encoding.md`
- Modify: `docs/adr/0005-carrier-interface.md`
- Modify: `docs/path_to_real.md`
- Modify: `docs/threat_model_v2.md`
- Modify: `plans/README.md`

- [ ] **Step 1: Update ADR 0001**

Change the status language from POC-only term encoding to versioned canonical bytes. Keep a caveat that full-op carrier frames still use a BEAM struct internally until the browser realm consumes the shared wire schema.

- [ ] **Step 2: Update ADR 0005**

Add a "M2 hardening delta" section listing:

- canonical signed bytes are no longer BEAM-term-only;
- full op wire frames are centralized in `Lattice.Carrier.Wire`;
- carrier sessions are authenticated by signed challenge/response;
- reconnect/backoff and batch budgets are explicit;
- partial sync shapes are dependency-closed;
- compaction GC now has a membership acknowledgement primitive.

- [ ] **Step 3: Update threat model**

In `docs/threat_model_v2.md`, record that M2 still does not provide confidentiality, consensus, or protection from compromised realm keys. It does add peer-authenticated sessions and bounded transfer behavior.

- [ ] **Step 4: Update plan index**

In `plans/README.md`, add an M2 row after 013:

```markdown
| M2 | Real carrier hardening | P1 | XL | 010, 013 | IN PROGRESS (canonical bytes, auth sessions, reconnect/backoff, partial sync, batching, acks) |
```

- [ ] **Step 5: Run full validation**

Run:

```bash
~/.asdf/shims/mix format --check-formatted
~/.asdf/shims/mix test
~/.asdf/shims/mix credo --strict
(cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit)
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add docs/adr/0001-canonical-encoding.md docs/adr/0005-carrier-interface.md \
  docs/path_to_real.md docs/threat_model_v2.md plans/README.md
git commit -m "docs(carrier): document M2 hardening boundary"
```

---

## Final M2 Acceptance Gate

Before declaring M2 complete, run:

```bash
~/.asdf/shims/mix test apps/lattice_core/test/lattice2 \
  apps/lattice_node_spike/test/node_carrier_spike_test.exs
~/.asdf/shims/mix test
~/.asdf/shims/mix credo --strict
(cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit)
```

Acceptance criteria:

- Op and delegation ids/signatures are derived from `Lattice.Canonical`, not direct `term_to_binary`.
- `Lattice.Carrier.sync/3` semantics remain unchanged for existing callers.
- Node spike still proves partition, divergence, heal, idempotency, tamper quarantine, and live ephemeral delivery over a real WebSocket.
- Carrier sessions fail closed on wrong realm/key before sync.
- Partial shapes include causal dependency closure and do not change `missing/2`.
- Large transfers are batched below the WebSocket frame budget.
- Membership acknowledgements can answer the compaction GC stable-frontier question without enabling production compaction yet.
- Browser persistence has a JSON-safe dump/restore contract and an IndexedDB adapter ready for the cleaned AtomVM browser branch.
