# AtomVM Browser Realm — Deferred Build Execution Plan

> **For Claude:** Use /coordinated-build to execute this plan.

**Goal:** Land the real in-tab BEAM realm: `Bridge`/`Realm`/`Codec`/`Main`, ExAtomVM packaging, the authority-blind `shell.js`, a WASM smoke test, a Playwright E2E, and the Phase-2 over-WebSocket denial-parity test — all behind the unchanged server gateway.
**Design:** [docs/designs/2026-05-25-atomvm-browser-realm.md](../designs/2026-05-25-atomvm-browser-realm.md)
**Review:** [docs/reviews/2026-05-25-atomvm-browser-realm.md](../reviews/2026-05-25-atomvm-browser-realm.md)
**Phase-0 evidence:** [output/atomvm_spike/PHASE0.md](../../output/atomvm_spike/PHASE0.md) — every unknown resolved, all gates green.

**Architecture (locked by Phase-0):** The shell owns `/ws` + resume/JWT/sessionStorage (design non-goal "resume stays in the shell"). Every server frame is handed to the BEAM via `await Module.call("realm", frameJson)`; the Realm decodes (estdlib `:json`), runs the pure `Lattice.Tab.Protocol` reducer, and returns `{"out": [...], "render": [...]}` **as the promise result**. The shell `ws.send`s each `out` and applies each `render` to the DOM via a dumb `kind → DOM` map. **No envelope/codec bytes ever enter a `run_script` string** (`promise_resolve` is the data path; `run_script` is used only for constant DOM scripts) — the design's load-bearing security invariant, satisfied by construction (PHASE0 §OQ2). The server gateway/`envelope.ex`/WebSocket boundary are **untouched**.

**Bridge-contract realization (the design's §Interfaces explicitly deferred exact API names to "Phase-0 criterion 1"; PHASE0 resolved them).** This plan is the settled realization of that abstract contract — not a deviation. Name → mechanism mapping:

| Design §Interfaces (abstract) | Settled mechanism (PHASE0-proven) | Where |
|---|---|---|
| `Bridge.start(client_id, last_seq)` | first `Module.call("realm", {"__lattice__":"boot", client_id, last_seq})` | D2, A2 |
| `Bridge.deliver/1` (per-frame JS→BEAM) | `Module.call("realm", frameJson)` → `{:emscripten,{:call,promise,msg}}` | D2, A3 |
| pre-registered `latticeShell.send` / `latticeShell.render` (BEAM→JS) | the Realm returns `{out, render}` as the `promise_resolve` result; the shell iterates it | A3, D2 |

The design's security invariant ("never build a JS source string") is the *binding* requirement; the push-vs-pull shape was always Phase-0's to settle, and pull (`promise_resolve`) is strictly stronger (zero `run_script` on the data path).

**Decision — design Issue 7 (who owns the WebSocket), resolved on Phase-0 evidence:** **Path A (shell owns `/ws`)** is chosen over PHASE0's mild Path-B (BEAM-owned `websocket`) recommendation. Rationale: Path A already achieves the no-eval property (data crosses as `Module.call` args + `promise_resolve` results — never evaluated), **and** it preserves the hard non-goal "resume stays in the shell" (JWT/sessionStorage/seq stay in JS); Path B would pull resume/JWT into WASM. Path B (`websocket:new`/`send_utf8`, confirmed available in PHASE0 §C5) is the documented **future optimization** if we ever want server bytes to bypass the JS context entirely.

**Tech stack:** Elixir 1.19 / OTP 28 (host + AtomVM bytecode — PHASE0 §OQ4); AtomVM v0.7.0-alpha.1 web bundle (pinned + sha256); ExAtomVM `mix atomvm.packbeam`; estdlib `:json`; native `emscripten`/`websocket` AtomVM modules.

---

## Task Groups & file ownership

### Group A — BEAM realm (Elixir, host-testable + WASM loop)
Files owned:
- Create `apps/lattice_tab/lib/lattice/tab/codec.ex`
- Create `apps/lattice_tab/lib/lattice/tab/realm.ex`
- Create `apps/lattice_tab/lib/lattice/tab/main.ex`
- Create `apps/lattice_tab/test/lattice/tab/codec_test.exs`
- Create `apps/lattice_tab/test/lattice/tab/realm_test.exs`

### Group B — Bridge (Elixir, WASM I/O edge)
Files owned:
- Create `apps/lattice_tab/lib/lattice/tab/bridge.ex`

### Group C — Packaging (ExAtomVM + build script)
Files owned:
- Modify `apps/lattice_tab/mix.exs`
- Create `apps/lattice_tab/build_avm.sh`
- Modify `.gitignore`

### Group D — Shell + static serving
Files owned:
- Rewrite `examples/atomvm_tab/index.html`
- Create `examples/atomvm_tab/shell.js`
- Modify `apps/lattice_server/lib/lattice_server/static_handler.ex` (add one whitelist line)

### Group E — Evidence (tests)
Files owned:
- Create `apps/lattice_tab/test/lattice/tab/wasm_smoke_test.exs`
- Create `scripts/lattice_atomvm_tab_smoke.mjs`
- Create `scripts/lattice_atomvm_tab_e2e.mjs`
- Create `apps/lattice_stress/test/atomvm_tab_denial_test.exs`
- Modify `package.json` (add two npm scripts)

**Conflict check:**
- A ∩ B ∩ C ∩ D ∩ E = ∅ ✓ (no two groups touch the same file).
- **Compile/runtime dependency order (for /coordinated-build):** **B → A → C → E(smoke,e2e)**. `realm.ex` (A) calls `Bridge` (B) and `Codec` (A) and the existing `Protocol`; `main.ex` (A) calls `Realm`; C packs the `.avm` from A+B output; E's smoke/e2e need the packed `.avm`. **D** (shell/static) and **E's denial test** (server-only) have no BEAM-compile dependency and may run in parallel from the start.

---

## Group B — Bridge

### Task B1: `Lattice.Tab.Bridge` — the WASM I/O edge

**Goal:** A thin module wrapping the AtomVM `emscripten` interop so the Realm never references `:emscripten` directly, and the umbrella stays warnings-clean on the host (where `:emscripten` does not exist).

**Files:**
- Create: `apps/lattice_tab/lib/lattice/tab/bridge.ex`

**Context:** `:emscripten`/`:websocket` are AtomVM-only modules (PHASE0 §OQ1). Calls to them on the host BEAM would trip `mix compile --warnings-as-errors`; `@compile {:no_warn_undefined, ...}` suppresses exactly those warnings. Only `resolve/2` and `render/1` are used on the data/DOM path; `resolve/2` is the no-eval reply path (`emscripten:promise_resolve/2`, PHASE0 §C4).

**Step 1: Implement** (no host test — this is the WASM edge, exercised by the smoke test E1)

```elixir
# apps/lattice_tab/lib/lattice/tab/bridge.ex
defmodule Lattice.Tab.Bridge do
  @moduledoc """
  BEAM↔JS edge for the AtomVM tab. Wraps the AtomVM `emscripten` interop so the
  Realm stays free of direct `:emscripten` references.

  Security invariant (design Issue 1 / PHASE0 §OQ2): the data path is
  `resolve/2` (a structured `emscripten:promise_resolve` value). `run_script` is
  used ONLY for the constant ready-beacon string — never with interpolated
  envelope/codec bytes.
  """

  # :emscripten / :websocket exist only inside AtomVM-WASM, not on the host BEAM.
  @compile {:no_warn_undefined, [:emscripten, :websocket]}

  @doc "Resolve a `Module.call` promise with an iodata reply (the no-eval data path)."
  @spec resolve(reference() | binary(), iodata()) :: :ok
  def resolve(promise, iodata), do: :emscripten.promise_resolve(promise, iodata)

  @doc "Run a CONSTANT JS string on the main thread (DOM only — never interpolate data)."
  @spec run_constant(binary()) :: :ok
  def run_constant(script) when is_binary(script), do: :emscripten.run_script(script, [:main_thread])

  @doc "Emit the deterministic ready beacon once the Realm is registered."
  @spec ready_beacon() :: :ok
  def ready_beacon do
    run_constant(
      "document.getElementById('app') && " <>
        "document.getElementById('app').setAttribute('data-atomvm-ready','true');"
    )
  end
end
```

**Step 2: Verify compile clean**
Run: `~/.asdf/shims/mix compile --warnings-as-errors`
Expected: compiles, **no `:emscripten`/`:websocket` undefined-module warnings**.

**Acceptance Criteria:**
- [ ] `mix compile --warnings-as-errors` clean (the `@compile {:no_warn_undefined, …}` suppresses the AtomVM-module warnings).
- [ ] No `run_script` call anywhere takes a non-constant argument.

---

## Group A — BEAM realm

### Task A1: `Lattice.Tab.Codec` — JSON in BEAM

**Goal:** Decode inbound JSON envelopes to string-keyed maps and encode outbound terms, using the `:json` module present on both host OTP 28 and AtomVM estdlib (PHASE0 §OQ3).

**Files:**
- Create: `apps/lattice_tab/lib/lattice/tab/codec.ex`
- Test: `apps/lattice_tab/test/lattice/tab/codec_test.exs`

**Context:** `:json.decode/1` yields binary-keyed maps — exactly what `Protocol.handle/2` matches on. `:json.encode/1` returns iodata and stringifies atom keys/values, so the Protocol's atom-keyed render intents (`%{kind: "status", …}`) and string-keyed envelopes both encode.

**Step 1: Write failing test**

```elixir
# apps/lattice_tab/test/lattice/tab/codec_test.exs
defmodule Lattice.Tab.CodecTest do
  use ExUnit.Case, async: true
  alias Lattice.Tab.Codec

  describe "decode/1" do
    test "decodes a JSON object to a string-keyed map" do
      assert {:ok, %{"type" => "welcome", "tab_id" => "tab_9"}} =
               Codec.decode(~s({"type":"welcome","tab_id":"tab_9"}))
    end

    test "returns {:error, _} on malformed JSON" do
      assert {:error, _} = Codec.decode("not-json")
    end
  end

  describe "encode/1" do
    test "encodes a string-keyed envelope" do
      assert Codec.decode(Codec.encode(%{"type" => "hello", "client_id" => "c1"})) ==
               {:ok, %{"type" => "hello", "client_id" => "c1"}}
    end

    test "stringifies atom-keyed render intents" do
      {:ok, decoded} = Codec.decode(Codec.encode(%{kind: "status", text: "connected", tab_id: "t1"}))
      assert decoded == %{"kind" => "status", "text" => "connected", "tab_id" => "t1"}
    end

    test "encodes the {out, render} reply envelope" do
      reply = %{"out" => [%{"type" => "hello"}], "render" => [%{kind: "status", text: "connecting"}]}
      {:ok, decoded} = Codec.decode(Codec.encode(reply))
      assert decoded == %{"out" => [%{"type" => "hello"}], "render" => [%{"kind" => "status", "text" => "connecting"}]}
    end
  end
end
```

**Step 2: Verify fail**
Run: `~/.asdf/shims/mix test apps/lattice_tab/test/lattice/tab/codec_test.exs`
Expected: FAIL — `Lattice.Tab.Codec.decode/1 is undefined`.

**Step 3: Implement**

```elixir
# apps/lattice_tab/lib/lattice/tab/codec.ex
defmodule Lattice.Tab.Codec do
  @moduledoc """
  JSON codec for the tab realm. Uses the `:json` module (host OTP 28 + AtomVM
  estdlib — PHASE0 §OQ3). Decoding yields binary-keyed maps (what `Protocol`
  matches); encoding stringifies atom keys/values so Protocol render intents and
  string-keyed envelopes both serialize.
  """

  @spec decode(binary()) :: {:ok, map()} | {:error, term()}
  def decode(json) when is_binary(json) do
    {:ok, :json.decode(json)}
  rescue
    e -> {:error, e}
  catch
    kind, reason -> {:error, {kind, reason}}
  end

  @spec encode(term()) :: binary()
  def encode(term), do: IO.iodata_to_binary(:json.encode(term))
end
```

**Step 4: Verify pass**
Run: `~/.asdf/shims/mix test apps/lattice_tab/test/lattice/tab/codec_test.exs --trace`
Expected: 5 tests, 0 failures.
> If the atom-key test fails (older `:json` not stringifying atom keys), add a private `normalize/1` that walks the term converting atom keys/values to binaries before `:json.encode/1`, and re-run.

**Acceptance Criteria:**
- [ ] 5 tests pass.
- [ ] `decode/1` returns `{:error, _}` (never raises) on malformed input.

---

### Task A2: `Lattice.Tab.Realm` — pure step + boot reducer

**Goal:** The host-testable core that turns one inbound message (boot control or server envelope) into `{state, outbound_envelopes, render_intents}` by composing `Protocol`.

**Files:**
- Create: `apps/lattice_tab/lib/lattice/tab/realm.ex` (this task adds the pure functions; A3 adds the WASM loop in the same file)
- Test: `apps/lattice_tab/test/lattice/tab/realm_test.exs`

**Context:** `Lattice.Tab.Protocol` already implements `init/1`, `hello/1`, `handle/2`, `grant_request/2`, `call/3`, each returning `{state, [envelope], [render_intent]}` ([protocol.ex](../../apps/lattice_tab/lib/lattice/tab/protocol.ex)). The Realm adds the **boot control message** (`%{"__lattice__" => "boot", "client_id" => …}`) that the shell sends first, and a uniform `step/2`.

**Step 1: Write failing test**

```elixir
# apps/lattice_tab/test/lattice/tab/realm_test.exs
defmodule Lattice.Tab.RealmTest do
  use ExUnit.Case, async: true
  alias Lattice.Tab.Realm

  describe "step/2 — boot" do
    test "boot control initializes state and emits hello + connecting status" do
      {state, out, render} = Realm.step(nil, %{"__lattice__" => "boot", "client_id" => "c-1", "last_seq" => 0})
      assert state.client_id == "c-1"
      assert [%{"type" => "hello", "client_id" => "c-1"}] = out
      assert %{kind: "status", text: "connecting"} in render
    end
  end

  describe "step/2 — server envelopes (delegates to Protocol)" do
    setup do
      {state, _o, _r} = Realm.step(nil, %{"__lattice__" => "boot", "client_id" => "c-1", "last_seq" => 0})
      {:ok, state: state}
    end

    test "welcome -> state_request + connected status", %{state: state} do
      {state, out, render} =
        Realm.step(state, %{"type" => "welcome", "tab_id" => "tab_9", "session_id" => "s", "client_id" => "c-1"})

      assert state.tab_id == "tab_9"
      assert out == [%{"type" => "state_request"}]
      assert %{kind: "status", text: "connected", tab_id: "tab_9"} in render
    end

    test "tab_call -> real tab_render_result + pulse", %{state: state} do
      {state, _o, _r} =
        Realm.step(state, %{"type" => "welcome", "tab_id" => "tab_A", "session_id" => "s", "client_id" => "c-1"})

      {^state, out, render} =
        Realm.step(state, %{"type" => "tab_call", "request_id" => "r1", "from_tab_id" => "tab_B", "payload" => %{"op" => "render", "pulse" => "blue"}})

      assert [%{"type" => "tab_render_result", "request_id" => "r1", "result" => %{"realm" => "atomvm", "pulse" => "blue"}}] = out
      assert %{kind: "pulse", route: "bridge"} in render
    end

    test "unknown envelope is a no-op", %{state: state} do
      assert {^state, [], []} = Realm.step(state, %{"type" => "totally_unknown"})
    end
  end

  describe "reply/3 shaping" do
    test "wraps out + render into the JSON-ready reply map" do
      assert Realm.reply([%{"type" => "hello"}], [%{kind: "status"}]) ==
               %{"out" => [%{"type" => "hello"}], "render" => [%{kind: "status"}]}
    end
  end
end
```

**Step 2: Verify fail**
Run: `~/.asdf/shims/mix test apps/lattice_tab/test/lattice/tab/realm_test.exs`
Expected: FAIL — `Lattice.Tab.Realm.step/2 is undefined`.

**Step 3: Implement (pure functions only; the loop is A3)**

```elixir
# apps/lattice_tab/lib/lattice/tab/realm.ex
defmodule Lattice.Tab.Realm do
  @moduledoc """
  In-tab BEAM realm. Pure `step/2` composes `Lattice.Tab.Protocol` (host-testable,
  no WASM); `run/0` (Task A3) is the AtomVM receive loop driving it via the Bridge.
  """
  alias Lattice.Tab.{Bridge, Codec, Protocol}

  @type step :: {Protocol.t() | nil, [map()], [map()]}

  @doc "Reduce one inbound message (boot control or server envelope) to {state, out, render}."
  @spec step(Protocol.t() | nil, map()) :: step()
  def step(_state, %{"__lattice__" => "boot", "client_id" => client_id}) do
    Protocol.hello(Protocol.init(client_id))
  end

  def step(%Protocol{} = state, envelope), do: Protocol.handle(state, envelope)

  @doc "Shape outbound envelopes + render intents into the promise-reply map."
  @spec reply([map()], [map()]) :: map()
  def reply(out, render), do: %{"out" => out, "render" => render}

  # --- WASM loop added in Task A3 ---
end
```

**Step 4: Verify pass**
Run: `~/.asdf/shims/mix test apps/lattice_tab/test/lattice/tab/realm_test.exs --trace`
Expected: 6 tests, 0 failures.

**Acceptance Criteria:**
- [ ] 6 tests pass; `step/2` delegates server envelopes to `Protocol.handle/2` unchanged.
- [ ] No WASM/`:emscripten` reference in `step/2` or `reply/2` (pure).

---

### Task A3: `Lattice.Tab.Realm.run/0` — the AtomVM receive loop

**Goal:** Register the realm, fire the ready beacon, and serve `Module.call` requests by decoding → `step/2` → `resolve` with the encoded `{out, render}` reply.

**Files:**
- Modify: `apps/lattice_tab/lib/lattice/tab/realm.ex` (append the loop below the `--- WASM loop ---` marker)

**Context:** PHASE0 §C4: inbound `Module.call("realm", msg)` delivers `{:emscripten, {:call, promise, msg}}` to the process registered as `realm`; replying via `Bridge.resolve(promise, iodata)` returns the value to the awaiting JS with **no eval**. State is threaded across calls in the loop.

**Step 1: Implement (append to `realm.ex`)**

```elixir
  @doc "AtomVM entry: register, beacon, then serve Module.call requests forever."
  @spec run() :: no_return()
  def run do
    Process.register(self(), :realm)
    Bridge.ready_beacon()
    loop(nil)
  end

  defp loop(state) do
    receive do
      {:emscripten, {:call, promise, msg}} ->
        {state, reply} = handle_call(state, msg)
        Bridge.resolve(promise, reply)
        loop(state)

      {:emscripten, {:cast, _msg}} ->
        # one-way path is unused in the request/response model; ignore.
        loop(state)

      _other ->
        loop(state)
    end
  end

  # decode -> step -> encode the {out, render} reply (no eval anywhere)
  defp handle_call(state, msg) do
    case Codec.decode(msg) do
      {:ok, inbound} ->
        {state, out, render} = step(state, inbound)
        {state, Codec.encode(reply(out, render))}

      {:error, _} ->
        {state, Codec.encode(reply([], [%{kind: "error", text: "malformed"}]))}
    end
  end
```

**Step 2: Verify compile**
Run: `~/.asdf/shims/mix compile --warnings-as-errors`
Expected: clean (Realm now references `Bridge`, which exists from Group B).
> Not host-unit-tested (WASM receive loop). Exercised end-to-end by the E1 smoke test and E2 E2E.

**Acceptance Criteria:**
- [ ] Compiles warnings-clean.
- [ ] The loop threads `state` across calls and only ever calls `Bridge.resolve/2` (data) — never `run_script` with data.

---

### Task A4: `Lattice.Tab.Main` — packbeam entry

**Goal:** `start/0` boots the Realm (the first module with `start/0` is the AtomVM entry; ExAtomVM `:start` names it explicitly).

**Files:**
- Create: `apps/lattice_tab/lib/lattice/tab/main.ex`

**Step 1: Implement**

```elixir
# apps/lattice_tab/lib/lattice/tab/main.ex
defmodule Lattice.Tab.Main do
  @moduledoc "AtomVM packbeam entry point. Boots the in-tab realm."
  @spec start() :: no_return()
  def start, do: Lattice.Tab.Realm.run()
end
```

**Step 2: Verify compile**
Run: `~/.asdf/shims/mix compile --warnings-as-errors`
Expected: clean.

**Acceptance Criteria:**
- [ ] Compiles; `start/0` delegates to `Realm.run/0`.

---

## Group C — Packaging

### Task C1: ExAtomVM wiring in `mix.exs`

**Goal:** Add `:exatomvm` as a build-only dep and the `:atomvm` packbeam config naming `Lattice.Tab.Main` as the entry — without dragging runtime deps into the umbrella.

**Files:**
- Modify: `apps/lattice_tab/mix.exs`

**Step 1: Implement** (replace `project/0`'s deps + add `atomvm:` key; replace `deps/0`)

```elixir
  def project do
    [
      app: :lattice_tab,
      version: "0.1.0",
      build_path: "../../_build",
      config_path: "../../config/config.exs",
      deps_path: "../../deps",
      lockfile: "../../mix.lock",
      elixir: "~> 1.19",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      # ExAtomVM packbeam: first module with start/0 is the entry.
      atomvm: [start: Lattice.Tab.Main]
    ]
  end

  defp deps do
    # exatomvm is BUILD-ONLY (provides `mix atomvm.packbeam`); never a runtime dep.
    [{:exatomvm, github: "atomvm/exatomvm", runtime: false, only: [:dev, :test]}]
  end
```

**Step 2: Verify**
Run: `~/.asdf/shims/mix deps.get && ~/.asdf/shims/mix compile --warnings-as-errors`
Expected: fetches exatomvm + uf2tool; umbrella compiles clean; **no new runtime app deps** (verify `application/0` still `[extra_applications: [:logger]]`).

**Acceptance Criteria:**
- [ ] `mix atomvm.packbeam` is available in `apps/lattice_tab`.
- [ ] Default `mix test` for the umbrella is unaffected (exatomvm is `runtime: false`, dev/test only).

---

### Task C2: `build_avm.sh` — produce + stage `lattice_tab.avm` and the VM

**Goal:** One reproducible script that (a) fetches+verifies the pinned VM bundle, (b) builds the stdlib libs from AtomVM source, (c) compiles `emscripten`/`websocket` + packs them with the app into `lattice_tab.avm`, (d) stages everything into `examples/atomvm_tab/`.

**Files:**
- Create: `apps/lattice_tab/build_avm.sh`
- Modify: `.gitignore`

**Context:** Mirrors the proven PHASE0 recipe (PHASE0 §Reproduce). The stdlib (`atomvmlib.avm` + `exavmlib.avm`) and the `emscripten`/`websocket` beams are **not** shipped (PHASE0 §OQ5) — built from source via cmake/ninja and packed/co-loaded. Pinned hashes live in [spike/atomvm/vendor/VERSIONS.sha256](../../spike/atomvm/vendor/VERSIONS.sha256).

**Step 1: Implement**

```bash
# apps/lattice_tab/build_avm.sh
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAG=v0.7.0-alpha.1
MIX=~/.asdf/shims/mix; ERLC=~/.asdf/shims/erlc; ESCRIPT=~/.asdf/shims/escript
APP="$ROOT/apps/lattice_tab"
STAGE="$ROOT/examples/atomvm_tab"
WORK="$APP/.atomvm_build"; mkdir -p "$WORK"

# (a) VM bundle — fetch + verify against the pinned hashes.
gh release download "$TAG" --repo atomvm/AtomVM --pattern 'AtomVM-web-*' --dir "$WORK/vendor" --clobber
( cd "$WORK/vendor" && shasum -a 256 -c AtomVM-web-$TAG.js.sha256 AtomVM-web-$TAG.wasm.sha256 )

# (b) stdlib + bridge libs from source (cmake/ninja — host tools).
SRC="$WORK/AtomVM-src"
[ -d "$SRC/.git" ] || git clone --depth 1 --branch "$TAG" https://github.com/atomvm/AtomVM "$SRC"
( cd "$SRC" && mkdir -p build && cd build && cmake -G Ninja .. >/dev/null && ninja atomvmlib exavmlib )

# (c) pack the app .avm: compile the emscripten/websocket beams + app beams, pack together.
( cd "$APP" && "$MIX" deps.get )
( cd "$APP" && "$MIX" do compile, atomvm.packbeam )   # -> apps/lattice_tab/lattice_tab.avm
"$ERLC" -o "$WORK/beams" "$SRC"/libs/avm_emscripten/src/{emscripten,websocket}.erl
"$ESCRIPT" "$SRC/build/tools/packbeam/packbeam" create "$WORK/app_full.avm" \
  "$APP/lattice_tab.avm" "$WORK/beams/emscripten.beam" "$WORK/beams/websocket.beam"

# (d) stage into examples/atomvm_tab/ (names match the static_handler whitelist).
cp "$WORK/vendor/AtomVM-web-$TAG.js"   "$STAGE/AtomVM-web-$TAG.js"
cp "$WORK/vendor/AtomVM-web-$TAG.wasm" "$STAGE/AtomVM-web-$TAG.wasm"
cp "$WORK/app_full.avm"                "$STAGE/lattice_tab.avm"
cp "$SRC/build/libs/atomvmlib.avm"     "$STAGE/atomvmlib.avm"
cp "$SRC/build/libs/exavmlib/lib/exavmlib.avm" "$STAGE/exavmlib.avm"
echo "staged AtomVM tab assets -> $STAGE"
```

**Step 2: gitignore the staged binaries + build work**

```
# AtomVM tab build artifacts (regenerated by apps/lattice_tab/build_avm.sh; never committed)
apps/lattice_tab/.atomvm_build/
apps/lattice_tab/lattice_tab.avm
examples/atomvm_tab/*.avm
examples/atomvm_tab/AtomVM-web-*.js
examples/atomvm_tab/AtomVM-web-*.wasm
```

**Step 3: Run it**
Run: `bash apps/lattice_tab/build_avm.sh`
Expected: `examples/atomvm_tab/` contains `AtomVM-web-v0.7.0-alpha.1.{js,wasm}`, `lattice_tab.avm`, `atomvmlib.avm`, `exavmlib.avm`.

**Acceptance Criteria:**
- [ ] Script is idempotent (re-run reuses the clone) and exits 0.
- [ ] Staged file names exactly match the `static_handler` whitelist (Task D3).
- [ ] No binary is committed (all staged artifacts gitignored).

---

## Group D — Shell + static serving

### Task D1: `examples/atomvm_tab/index.html` — boot the VM

**Goal:** Replace the placeholder with the real boot page: global `Module` (arguments + `locateFile`), the `#app` ready-beacon target, and the shell module.

**Files:**
- Rewrite: `examples/atomvm_tab/index.html`

**Context:** PHASE0 §C3/§gotcha-2: the bundle is loaded via a global `var Module = {arguments:[avm…], locateFile}` set **before** the `<script>` tag; the bundle hardcodes `AtomVM.wasm` so `locateFile` must redirect to the pinned name.

**Step 1: Implement**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Lattice — AtomVM tab</title>
    <link rel="stylesheet" href="/atomvm_tab/styles.css" />
  </head>
  <body>
    <main id="app" data-atomvm-ready="false">
      <h1>Lattice AtomVM tab</h1>
      <p id="status">booting…</p>
      <ul id="ledger"></ul>
    </main>
    <script>
      // Global Module is read by the (non-modularized) AtomVM bundle.
      var Module = {
        locateFile: function (p) {
          return p.endsWith(".wasm") ? "/atomvm_tab/AtomVM-web-v0.7.0-alpha.1.wasm" : p;
        },
        arguments: ["/atomvm_tab/lattice_tab.avm", "/atomvm_tab/atomvmlib.avm", "/atomvm_tab/exavmlib.avm"],
      };
    </script>
    <script async src="/atomvm_tab/AtomVM-web-v0.7.0-alpha.1.js"></script>
    <script type="module" src="/atomvm_tab/shell.js"></script>
  </body>
</html>
```

**Acceptance Criteria:**
- [ ] `arguments` lists app `.avm` first, then `atomvmlib.avm`, then `exavmlib.avm` (PHASE0 co-load order).
- [ ] `locateFile` redirects `.wasm` to the pinned asset.

---

### Task D2: `examples/atomvm_tab/shell.js` — authority-blind I/O

**Goal:** Own `/ws` + resume/JWT/sessionStorage (design non-goal), forward every frame to the Realm via `Module.call`, send the returned `out` envelopes, and apply `render` intents through a dumb `kind → DOM` map. **Zero branches on envelope `type`/`cap_id`/`result`.**

**Files:**
- Create: `examples/atomvm_tab/shell.js`

**Context:** Resume/sessionStorage/JWT mirror [client.js:36-45,110-114,74-89](../../examples/browser_demo/client.js). The semantic logic that client.js does inline (`pulseEvent`, `eventTitle`) now lives in the BEAM Realm; the shell only maps render intents to DOM ops.

**Step 1: Implement**

```javascript
// examples/atomvm_tab/shell.js — authority-blind shell for the AtomVM tab.
// It NEVER inspects envelope type/cap_id/result; it ferries bytes to the BEAM
// realm (Module.call) and paints render intents the realm returns.
const app = document.getElementById("app");
let ws, ready = false;
let lastSeq = Number(sessionStorage.getItem("lattice.resume.seq") || "0");
let clientId = sessionStorage.getItem("lattice.resume.client_id");
if (!clientId) {
  clientId = (crypto.randomUUID && crypto.randomUUID()) || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sessionStorage.setItem("lattice.resume.client_id", clientId);
}

async function whenRealmReady() {
  // The BEAM sets data-atomvm-ready="true" via the ready beacon once registered.
  while (app.getAttribute("data-atomvm-ready") !== "true") await new Promise((r) => setTimeout(r, 25));
  ready = true;
}

// Single bridge call: hand the realm one inbound message, get {out, render}.
async function toRealm(message) {
  const reply = await Module.call("realm", JSON.stringify(message));
  const { out = [], render = [] } = JSON.parse(reply);
  out.forEach((env) => ws.send(JSON.stringify(env)));
  render.forEach(applyIntent);
}

// Dumb kind -> DOM map. No authority decisions.
function applyIntent(intent) {
  switch (intent.kind) {
    case "status": app.querySelector("#status").textContent = intent.text + (intent.tab_id ? ` (${intent.tab_id.slice(0, 8)})` : ""); break;
    case "cap": app.querySelector("#status").textContent = `cap ${intent.text}`; break;
    case "call_result": app.querySelector("#status").textContent = intent.ok ? "call allowed" : "call denied"; break;
    case "cast_result": app.querySelector("#status").textContent = intent.ok ? "cast ok" : "cast denied"; break;
    case "pulse": pulse(intent.route); break;
    case "error": app.querySelector("#status").textContent = `error: ${intent.text}`; break;
    case "ledger_event": addLedger(intent); break;
  }
}
function pulse(route) {
  app.classList.add(`pulse-${route}`);
  setTimeout(() => app.classList.remove(`pulse-${route}`), 780);
}
function addLedger(intent) {
  const li = document.createElement("li");
  li.textContent = intent.text || intent.route || "event";
  app.querySelector("#ledger").prepend(li);
}
function rememberSeq(raw) {
  try { const m = JSON.parse(raw); if (typeof m.seq === "number" && m.seq > lastSeq) { lastSeq = m.seq; sessionStorage.setItem("lattice.resume.seq", String(lastSeq)); } } catch (_) {}
}

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.addEventListener("open", async () => {
    await whenRealmReady();
    try {
      const r = await fetch(`/api/session-token?client_id=${encodeURIComponent(clientId)}`);
      ws.send(JSON.stringify({ type: "resume", seq: lastSeq, jwt: (await r.json()).token }));
    } catch (_) { lastSeq = 0; }
    // Ask the realm to build hello (carries the shell-owned client_id).
    await toRealm({ __lattice__: "boot", client_id: clientId, last_seq: lastSeq });
  });
  ws.addEventListener("message", (e) => { rememberSeq(e.data); if (ready) toRealm(JSON.parse(e.data)); });
  ws.addEventListener("close", () => { ready = false; setTimeout(connect, 500); });
}

connect();
```

**Acceptance Criteria:**
- [ ] **Authority-blindness:** grep shows zero `switch`/`if` on envelope `type`, `cap_id`, or `result` — only `intent.kind` (render) is branched on.
- [ ] Resume (`client_id`, `seq`, JWT) stays entirely in the shell (sessionStorage); the realm receives `client_id` via the `boot` control message.
- [ ] No `eval`/`Function`/string-built code; data crosses only as `Module.call` arguments + parsed results.

---

### Task D3: `static_handler` — whitelist `exavmlib.avm`

**Goal:** Add the one missing whitelist entry (the Elixir stdlib avm) so the isolated route serves it.

**Files:**
- Modify: `apps/lattice_server/lib/lattice_server/static_handler.ex`

**Context:** The route already whitelists `shell.js`, `AtomVM-web-v0.7.0-alpha.1.{js,wasm}`, `lattice_tab.avm`, `atomvmlib.avm` ([static_handler.ex](../../apps/lattice_server/lib/lattice_server/static_handler.ex)). Only `exavmlib.avm` (added in this build for Elixir support) is missing. `content_type/1` already maps `.avm → application/octet-stream`.

**Step 1: Add one clause** beside the existing `atomvmlib.avm` line

```elixir
  defp file_for("/atomvm_tab/exavmlib.avm"), do: {:ok, "exavmlib.avm"}
```

**Step 2: Verify** existing isolation test still passes
Run: `~/.asdf/shims/mix test apps/lattice_server/test/atomvm_static_test.exs`
Expected: existing tests pass (3 + non-isolation), no regressions.

**Acceptance Criteria:**
- [ ] `/atomvm_tab/exavmlib.avm` resolves; all other unknown paths still 404 (whitelist preserved).

---

## Group E — Evidence

### Task E1: WASM smoke test (guarded)

**Goal:** A fast, guarded check that the packed `.avm` boots in the AtomVM **node** bundle and answers one `Module.call` boot round-trip with a real `hello` — excluded from default `mix test`.

**Files:**
- Create: `scripts/lattice_atomvm_tab_smoke.mjs`
- Create: `apps/lattice_tab/test/lattice/tab/wasm_smoke_test.exs`

**Context:** Reuses the PHASE0 node-run pattern (`.cjs` + `locateFile` via the generic `AtomVM.wasm` name). The node bundle exposes `Module.call` (PHASE0 bundle inspection), so a DOM-free boot round-trip is checkable.

**Step 1: node smoke script**

```javascript
// scripts/lattice_atomvm_tab_smoke.mjs — boots the packed app in the node bundle,
// does one Module.call boot round-trip, asserts a real hello. Exit 0 = pass.
import path from "node:path";
const S = path.resolve("examples/atomvm_tab");
const wasm = path.join(S, "AtomVM-web-v0.7.0-alpha.1.wasm");
globalThis.Module = {
  locateFile: (p) => (p.endsWith(".wasm") ? wasm : p),
  arguments: [path.join(S, "lattice_tab.avm"), path.join(S, "atomvmlib.avm"), path.join(S, "exavmlib.avm")],
  onRuntimeInitialized() {
    setTimeout(async () => {
      const reply = await Module.call("realm", JSON.stringify({ __lattice__: "boot", client_id: "smoke-1", last_seq: 0 }));
      const { out } = JSON.parse(reply);
      const ok = out?.[0]?.type === "hello" && out[0].client_id === "smoke-1";
      console.log(ok ? "SMOKE_OK" : "SMOKE_FAIL:" + reply);
      process.exit(ok ? 0 : 1);
    }, 200);
  },
};
await import(path.join(S, "AtomVM-web-v0.7.0-alpha.1.js")); // run via a .cjs shim if package.json type=module blocks it
```
> Note: the repo `package.json` has `"type":"module"` (PHASE0 §gotcha-3). Invoke with a `.cjs` runner like `spike/atomvm/run-node.cjs`, or copy the bundle to `.cjs`. The E2E (E2) uses the **web** bundle in-browser and is unaffected.

**Step 2: guarded ExUnit wrapper**

```elixir
# apps/lattice_tab/test/lattice/tab/wasm_smoke_test.exs
defmodule Lattice.Tab.WasmSmokeTest do
  use ExUnit.Case, async: false
  @moduletag :wasm  # excluded from default `mix test` (see test_helper exclude)

  test "packed .avm boots in the node bundle and answers a hello" do
    avm = Path.expand("../../../../examples/atomvm_tab/lattice_tab.avm", __DIR__)
    if File.exists?(avm) do
      {out, code} = System.cmd("node", [Path.expand("../../../../scripts/lattice_atomvm_tab_smoke.mjs", __DIR__)], stderr_to_stdout: true)
      assert code == 0, out
      assert out =~ "SMOKE_OK"
    else
      flunk("run apps/lattice_tab/build_avm.sh first (no lattice_tab.avm staged)")
    end
  end
end
```

**Step 3: exclude `:wasm` by default** — add to `apps/lattice_tab/test/test_helper.exs`:
```elixir
ExUnit.start(exclude: [:wasm])
```

**Acceptance Criteria:**
- [ ] `mix test` (default) does **not** run the smoke test (`:wasm` excluded).
- [ ] `mix test --only wasm` after `build_avm.sh` prints `SMOKE_OK`, exits 0.

---

### Task E2: Playwright E2E

**Goal:** Drive the real served tab in headless Chromium through the core-demo path against a live `LatticeServer`: connect → grant → allowed call → **denied fake cap** → `tab_call`→render. **Plus the design's "JS tab + AtomVM tab both contained" scenario** (testing-strategy item 3): open the JS demo at `/` in one page and the AtomVM tab at `/atomvm_tab/` in a second page against the **same** gateway, and assert both operate and remain contained (each denied a forged cap; neither reaches a target without a cap).

**Files:**
- Create: `scripts/lattice_atomvm_tab_e2e.mjs`
- Modify: `package.json` (scripts)

**Context:** Generalizes `spike/atomvm/driver.mjs` + mirrors [scripts/lattice_browser_e2e.mjs](../../scripts/lattice_browser_e2e.mjs) (Playwright launch + `tests/e2e/support/lattice-server.mjs` `startServer`/`freePort`). The page is served by the real `/atomvm_tab` isolated route (COOP/COEP). Drive UI actions by injecting envelopes through the shell's `toRealm` is NOT allowed (that bypasses /ws); instead trigger via the same buttons/flow the demo uses, asserting on `#status`/`data-*` and on server audit via a `/api` probe or the presence frames.

**Step 1: Implement** (key skeleton — fill DOM selectors to match index.html)

```javascript
// scripts/lattice_atomvm_tab_e2e.mjs
import { chromium } from "playwright";
import { startServer } from "../tests/e2e/support/lattice-server.mjs";

const server = await startServer({ root: process.cwd(), command: "/Users/nicholas/.asdf/shims/mix",
  args: ["run", "--no-halt", "-e", "LatticeServer.start_http(port: System.get_env(\"PORT\") |> String.to_integer(), grant_targets: %{\"echo\" => Lattice.Demo.EchoServer})"],
  readyPath: "/atomvm_tab/index.html" });
const browser = await chromium.launch({ headless: true, args: ["--enable-features=SharedArrayBuffer"] });
try {
  const page = await browser.newPage();
  await page.goto(`${server.url}atomvm_tab/index.html`);
  await page.waitForSelector('#app[data-atomvm-ready="true"]', { timeout: 20000 });
  // wait for connected status (welcome flowed through the real BEAM realm)
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("connected"), { timeout: 10000 });
  // …grant -> allowed call -> denied fake cap -> tab_call render, asserting #status / pulse classes…
  console.log("ATOMVM_E2E_OK");
} finally { await browser.close(); await server.stop(); }
```

**Step 2: npm scripts** — add to `package.json`:
```json
"atomvm:smoke": "node spike/atomvm/run-node.cjs scripts/lattice_atomvm_tab_smoke.mjs",
"atomvm:e2e": "node scripts/lattice_atomvm_tab_e2e.mjs"
```

**Acceptance Criteria:**
- [ ] `npm run atomvm:e2e` (after `build_avm.sh`) reaches `connected` and prints `ATOMVM_E2E_OK`.
- [ ] The script drives actions through the page/`/ws`, never by injecting outbound envelopes directly (the BEAM must produce them).
- [ ] The "both contained" scenario runs: a `/` JS tab and a `/atomvm_tab/` tab on one gateway both operate and are both denied a forged cap (containment parity across tab types).

---

### Task E3: Phase-2 over-WebSocket denial parity (the thesis gate)

**Goal:** Prove the server denies identically over the WebSocket boundary for the **exact envelopes the AtomVM Realm produces** — forged cap and revoke-then-denied — so "no new server trust" is evidence-backed (Review Issue 5).

**Files:**
- Create: `apps/lattice_stress/test/atomvm_tab_denial_test.exs`

**Context:** Reuses `Lattice.Transport.WebSocket.Client` + the `WebSocketAbuseTest` harness ([web_socket_abuse_test.exs](../../apps/lattice_stress/test/web_socket_abuse_test.exs)). The forged-cap envelope is the **exact shape** `Lattice.Tab.Protocol.call/3` emits (a `%{"type"=>"call","cap_id"=>…,"payload"=>%{"op"=>…,"message"=>…}}` — verified in [protocol_test.exs](../../apps/lattice_tab/test/lattice/tab/protocol_test.exs)), hardcoded here so this stays a pure server-side test with **no `lattice_tab` dependency** (lattice_stress does not depend on lattice_tab — confirmed). The server cannot distinguish an AtomVM tab from a JS tab — identical JSON over `/ws` — so this is the denial-parity proof.

**Step 1: Write the test**

```elixir
# apps/lattice_stress/test/atomvm_tab_denial_test.exs
defmodule LatticeStress.AtomvmTabDenialTest do
  use ExUnit.Case, async: false
  alias Lattice.Transport.WebSocket.Client
  alias LatticeStress.ProbeServer

  setup do
    Lattice.reset!()
    LatticeServer.DemoHub.reset()
    {:ok, probe} = ProbeServer.start_link(owner: self(), name: :atomvm_denial_probe)
    listener = :"atomvm_denial_#{System.unique_integer([:positive])}"
    port = free_port()
    {:ok, _} = LatticeServer.start_http(listener: listener, port: port, auto_story?: false,
      grant_targets: %{"echo" => probe, {"echo", :ops} => ["echo"]})
    on_exit(fn -> LatticeServer.stop_http(listener) end)
    {:ok, %{port: port, probe: probe}}
  end

  test "Realm-produced forged-cap call is denied over /ws, target never sees it", %{port: port, probe: probe} do
    {:ok, client} = Client.connect(port: port)
    assert :ok = Client.send_envelope(client, %{type: "hello", identity: %{surface: "atomvm-tab"}})
    assert {:ok, %{"type" => "welcome"}} = recv_type(client, "welcome")

    # Exactly the shape Protocol.call/3 emits for a cap the tab never legitimately holds
    # (see protocol_test.exs "call/3 builds a call using the held echo cap").
    forged_call = %{type: "call", cap_id: "forged-not-a-real-cap", payload: %{op: "echo", message: "raw reach"}}

    assert :ok = Client.send_envelope(client, forged_call)
    assert {:ok, %{"type" => "call_result", "ok" => false}} = recv_type(client, "call_result")
    assert %{call_count: 0} = ProbeServer.stats(probe)
    Client.close(client)
  end

  test "revoke-then-call is denied over /ws (disconnect revokes caps)", %{port: port, probe: probe} do
    {:ok, client} = Client.connect(port: port)
    assert :ok = Client.send_envelope(client, %{type: "hello", identity: %{surface: "atomvm-tab"}})
    assert {:ok, %{"type" => "welcome", "tab_id" => tab_id}} = recv_type(client, "welcome")
    assert :ok = Client.send_envelope(client, %{type: "grant_request", target: "echo"})
    assert {:ok, %{"type" => "grant", "cap" => %{"id" => cap_id}}} = recv_type(client, "grant")

    assert :ok = Client.close(client)
    Process.sleep(20)
    assert {:error, :revoked} = Lattice.call(tab_id, cap_id, %{op: "echo"})
    assert %{call_count: 0} = ProbeServer.stats(probe)
  end

  defp free_port do
    {:ok, s} = :gen_tcp.listen(0, [:binary, active: false]); {:ok, p} = :inet.port(s); :gen_tcp.close(s); p
  end
  defp recv_type(client, type, timeout \\ 5_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_recv(client, type, deadline)
  end
  defp do_recv(client, type, deadline) do
    case Client.recv_envelope(client, max(deadline - System.monotonic_time(:millisecond), 1)) do
      {:ok, %{"type" => ^type} = e} -> {:ok, e}
      {:ok, _} -> do_recv(client, type, deadline)
      {:error, r} -> {:error, r}
    end
  end
end
```
**Step 2: Verify**
Run: `~/.asdf/shims/mix test apps/lattice_stress/test/atomvm_tab_denial_test.exs --trace`
Expected: 2 tests, 0 failures; both assert `call_count: 0` (target never reached).

**Acceptance Criteria:**
- [ ] Both denial paths pass **over the WebSocket** using Realm-produced envelopes.
- [ ] The probe target observes zero calls in both cases (containment proven).

---

## Integration

### Integration Task I1: wire + full suite

**Depends on:** A1–A4, B1, C1–C2, D1–D3, E3 (host) ; E1/E2 require `build_avm.sh` first.

**Step 1: host suite (no WASM)**
```bash
~/.asdf/shims/mix compile --warnings-as-errors
~/.asdf/shims/mix format --check-formatted
~/.asdf/shims/mix test          # all green incl. lattice_tab (Codec+Realm) + the new denial test; :wasm excluded
```

**Step 2: WASM evidence (opt-in)**
```bash
bash apps/lattice_tab/build_avm.sh
~/.asdf/shims/mix test --only wasm          # E1 smoke -> SMOKE_OK
npm run atomvm:e2e                           # E2 -> ATOMVM_E2E_OK
```

**Step 3: authority-blindness check**
```bash
grep -nE '"type"|cap_id|\.result' examples/atomvm_tab/shell.js   # expect: none on inbound; only intent.kind branched
```

---

## Verification

### Final Checks
- [ ] `~/.asdf/shims/mix test` — all pass (host), no regressions; `:wasm` excluded by default.
- [ ] `~/.asdf/shims/mix compile --warnings-as-errors` — clean (Bridge `@compile {:no_warn_undefined,…}` holds).
- [ ] `~/.asdf/shims/mix format --check-formatted` — formatted.
- [ ] `bash apps/lattice_tab/build_avm.sh` then `mix test --only wasm` → `SMOKE_OK`.
- [ ] `npm run atomvm:e2e` → `ATOMVM_E2E_OK` (connect→grant→call→deny→tab_call render).
- [ ] Phase-2 denial parity (E3) green → "no new server trust" is evidence-backed.
- [ ] `shell.js` has zero branches on envelope `type`/`cap_id`/`result` (authority-blind).
- [ ] No binary committed; `examples/atomvm_tab/*.avm` + bundle gitignored; gateway/`envelope.ex`/WebSocket untouched.

---

## Drift check (planner self-audit vs design)

- **Every design component maps to a task:** Shell→D1/D2; AtomVM runtime (staged+sha256)→C2; Realm→A2/A3; Protocol→(exists); Codec→A1; Bridge→B1; Main→A4; `.avm` packaging→C1/C2; static serving→D3 (rest exists); route wiring + `max_frame_size`→(already on branch). ✓
- **Security invariant (Issue 1):** satisfied by construction — data via `promise_resolve`, `run_script` constant-only (B1, A3, D2). ✓
- **Resume non-goal:** resume/JWT/sessionStorage stay in `shell.js`; Realm gets `client_id` via the `boot` control message (D2, A2). ✓
- **Denial parity (Issue 5) moved to Phase-2:** E3 over-the-WS, before E2E. ✓
- **Nothing introduced beyond the design:** the `Module.call`/`promise_resolve` + `boot` control message is the **settled realization** of the design's *implementation-agnostic* Bridge contract whose exact API names the design deferred to "Phase-0 criterion 1" — see the name→mechanism mapping table in the preamble. No gateway/envelope change. ✓
- **Design Issue 7 (who owns the WebSocket) — DECIDED, not parked:** Path A (shell-owned `/ws`) on the rationale in the preamble decision block (same no-eval property + preserves the resume-in-shell non-goal); Path B (BEAM-owned `websocket`) recorded as the future optimization. ✓
- **Deliberately deferred (noted, not silently dropped):** Phase-3 protocol completeness (`cast/3` build + `snapshot`/`presence`/`server_event` render parity — pure Elixir, host-testable, not needed for the connect→grant→call→deny→tab_call E2E path); opt-in CI job (Phase-4) — `build_avm.sh` + `mix test --only wasm` + `npm run atomvm:e2e`, OTP 28; **Phase-4 docs flip** (move the "AtomVM is future work" disclaimers → "implemented (narrow)" across the 5 docs in design §"Documentation to update") — gated on the `output/` evidence artifact.

---

Next: `/drift-check` to verify this plan faithfully represents the design, then `/coordinated-build` to execute (order **B → A → C → E**, with **D** in parallel).
