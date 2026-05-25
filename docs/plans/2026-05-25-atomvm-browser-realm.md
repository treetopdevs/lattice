# AtomVM Browser Realm — Execution Plan (Phase 0 + spike-independent foundation)

> **For Claude:** Use `/coordinated-build` to execute this plan. **Scope is deliberately partial** — see "Scope & why" below.

**Goal:** Make the Lattice tab realm a real BEAM (AtomVM-WASM) process behind the unchanged capability gateway.
**Design:** [docs/designs/2026-05-25-atomvm-browser-realm.md](../designs/2026-05-25-atomvm-browser-realm.md)
**Review:** [docs/reviews/2026-05-25-atomvm-browser-realm.md](../reviews/2026-05-25-atomvm-browser-realm.md)

**Architecture:** A pure Elixir `Protocol` reducer (maps→maps) executes the tab's protocol semantics; a thin `Realm` process + `Bridge` (deferred) carry it into AtomVM-WASM; an authority-blind JS shell does I/O only. The server gateway/envelope boundary is untouched.
**Tech stack:** Elixir 1.19 / OTP 28 umbrella, Cowboy 2.12, Jason 1.4, ExUnit; AtomVM v0.7.0-alpha.1 web bundle + ExAtomVM (spike).

---

## Scope & why (READ FIRST)

The design is **spike-gated**: the exact AtomVM JS↔BEAM bridge API, threading model, JSON-decode location, and *whether OTP-28 bytecode runs at all* are unresolved until **Phase 0**. Writing "complete code" for the `Bridge`/`Realm`-boot/`Shell`/WASM-E2E tasks now would mean **fabricating unverified AtomVM interop** — failing this skill's grounding rule and quality gate.

**This plan therefore atomizes only what is groundable today:**
- **Group A** — the pure `Protocol` reducer (host TDD, no WASM). The highest-value, fully deterministic piece.
- **Group B** — tab-agnostic server hardening + the `/atomvm_tab` static route (against files already read).
- **Group C** — the **Phase-0 spike** itself, as explicit go/no-go gates with exact commands. Its output document is the input to a **post-spike re-run of `/atomic-plan`** for the deferred work.

**Deferred to post-spike** (see "Deferred" section, each with the Phase-0 output it needs): `Bridge`, `Realm`, `Main`, the Codec WASM backend, `Shell`, ExAtomVM packaging wiring, the WASM smoke test, Playwright E2E, over-WebSocket adversarial parity, docs updates, and the opt-in CI job.

---

## Task Groups & file ownership

### Group A — `Lattice.Tab.Protocol` (pure reducer, host TDD) · `async: true`
Files owned (all **new**):
- `apps/lattice_tab/mix.exs`
- `apps/lattice_tab/lib/lattice/tab/protocol.ex`
- `apps/lattice_tab/test/test_helper.exs`
- `apps/lattice_tab/test/lattice/tab/protocol_test.exs`

### Group B — Server hardening + AtomVM static route · `async: false`
Files owned:
- Modify `apps/lattice_server/lib/lattice_server/static_handler.ex`
- Modify `apps/lattice_server/lib/lattice_server.ex`
- Create `examples/atomvm_tab/index.html`, `examples/atomvm_tab/styles.css` (placeholders)
- Create `apps/lattice_server/test/atomvm_static_test.exs`

### Group C — Phase-0 spike (research gates) · sequential
Files owned (all **new**, throwaway/evidence):
- `spike/atomvm/` (throwaway mini-project + HTML harness)
- `output/atomvm_spike/PHASE0.md` (evidence + resolved open questions)

**Conflict check:**
- A ∩ B = ∅ (`apps/lattice_tab/*` vs `apps/lattice_server/*` + `examples/atomvm_tab/{index.html,styles.css}`) ✓
- A ∩ C = ∅ ✓
- B ∩ C = ∅ (`examples/atomvm_tab/{index.html,styles.css}` vs `spike/*` + `output/atomvm_spike/*`) ✓
- All three groups are **independent and may run in parallel**. Group C's output gates only the *deferred* work, not A or B.

---

## Group A — `Lattice.Tab.Protocol`

### Task A1: Create the `lattice_tab` umbrella app

**Goal:** A minimal, dependency-free umbrella app that compiles on the repo toolchain and runs host tests.

**Files:**
- Create: `apps/lattice_tab/mix.exs`
- Create: `apps/lattice_tab/test/test_helper.exs`

**Context:** New umbrella app, mirrors [apps/lattice_core/mix.exs](../../apps/lattice_core/mix.exs) conventions (shared `_build`/`mix.lock`). Kept lean — **no deps** (the `Protocol` is pure, JSON-agnostic), no application callback (no processes yet; `Realm`/`Main` are deferred). ExAtomVM/`mix atomvm.packbeam` is **not** added here yet — it is proven in Group C and wired post-spike.

**Step 1: Create `apps/lattice_tab/mix.exs`**
```elixir
defmodule LatticeTab.MixProject do
  use Mix.Project

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
      deps: deps()
    ]
  end

  # No application callback: this app is a pure protocol library for now.
  # The Realm process + AtomVM packaging are added post-spike.
  def application do
    [extra_applications: [:logger]]
  end

  defp deps do
    # Intentionally empty — Protocol operates on plain maps (no JSON dep),
    # so it stays inside AtomVM's subset and needs nothing at runtime.
    []
  end
end
```

**Step 2: Create `apps/lattice_tab/test/test_helper.exs`**
```elixir
ExUnit.start()
```

**Step 3: Verify it compiles and is recognized by the umbrella**
Run: `mix compile --warnings-as-errors`
Expected: compiles clean; `apps/lattice_tab` appears in the umbrella build.
Run: `mix cmd --app lattice_tab mix test`
Expected: `0 failures` (no tests yet).

**Step 4: Commit**
```bash
git add apps/lattice_tab/mix.exs apps/lattice_tab/test/test_helper.exs
git commit -m "feat(lattice_tab): scaffold pure-Elixir tab app"
```

**Acceptance Criteria:**
- [ ] `mix compile --warnings-as-errors` clean
- [ ] `apps/lattice_tab` builds within the umbrella
- [ ] No new runtime deps added

---

### Task A2: `Protocol` struct, `init/1`, and `hello/1`

**Goal:** The reducer's state and the boot `hello` envelope, carrying the shell-supplied `client_id` (Design Issue 3).

**Files:**
- Create: `apps/lattice_tab/lib/lattice/tab/protocol.ex`
- Create: `apps/lattice_tab/test/lattice/tab/protocol_test.exs`

**Context:** `Protocol` is a **pure** module: no process, no I/O, no JSON. It takes/returns string-keyed maps (the same envelope shapes the server sends/expects in [web_socket.ex](../../apps/lattice_server/lib/lattice/transport/web_socket.ex)). The `hello` shape mirrors [client.js:84-88](../../examples/browser_demo/client.js:84) / [worker-client.js:46-54](../../examples/browser_demo/worker-client.js:46).

**Step 1: Write failing test** — `apps/lattice_tab/test/lattice/tab/protocol_test.exs`
```elixir
defmodule Lattice.Tab.ProtocolTest do
  use ExUnit.Case, async: true

  alias Lattice.Tab.Protocol

  describe "init/1 and hello/1" do
    test "init/1 starts in :connecting with the supplied client_id" do
      state = Protocol.init("client-abc-123")
      assert state.client_id == "client-abc-123"
      assert state.status == :connecting
      assert state.tab_id == nil
      assert state.caps == %{}
    end

    test "hello/1 builds a hello envelope carrying the client_id and a status intent" do
      {state, outbound, intents} = Protocol.hello(Protocol.init("client-abc-123"))

      assert [%{"type" => "hello", "client_id" => "client-abc-123", "identity" => identity}] =
               outbound

      assert identity["surface"] == "atomvm-tab"
      assert identity["client_id"] == "client-abc-123"
      assert intents == [%{kind: "status", text: "connecting"}]
      assert state.status == :connecting
    end
  end
end
```

**Step 2: Verify fail** — `mix cmd --app lattice_tab mix test test/lattice/tab/protocol_test.exs --trace`
Expected: FAIL — `Lattice.Tab.Protocol.init/1 is undefined`.

**Step 3: Implement** — `apps/lattice_tab/lib/lattice/tab/protocol.ex`
```elixir
defmodule Lattice.Tab.Protocol do
  @moduledoc """
  Pure protocol state machine for the AtomVM tab realm.

  No process, no I/O, no JSON — it operates on decoded string-keyed maps
  (envelopes) and returns `{state, [outbound_envelope], [render_intent]}`.
  Runs identically on the host BEAM (ExUnit) and inside AtomVM-WASM, and
  stays inside AtomVM's subset (no bitstrings, big integers, or ETS).

  This module owns 100% of core-demo protocol *semantics*; the shell is
  authority-blind I/O only.
  """

  @enforce_keys [:client_id]
  defstruct client_id: nil,
            tab_id: nil,
            session_id: nil,
            caps: %{},
            status: :init

  @type envelope :: %{optional(String.t()) => term()}
  @type render_intent :: %{required(:kind) => String.t(), optional(atom()) => term()}
  @type t :: %__MODULE__{
          client_id: String.t(),
          tab_id: String.t() | nil,
          session_id: String.t() | nil,
          caps: %{optional(String.t()) => String.t()},
          status: atom()
        }
  @type step :: {t(), [envelope()], [render_intent()]}

  @spec init(String.t()) :: t()
  def init(client_id) when is_binary(client_id) do
    %__MODULE__{client_id: client_id, status: :connecting}
  end

  @doc "Boot envelope. The shell supplies `client_id` via `Bridge.start/2`."
  @spec hello(t()) :: step()
  def hello(%__MODULE__{client_id: client_id} = state) do
    envelope = %{
      "type" => "hello",
      "client_id" => client_id,
      "identity" => %{"surface" => "atomvm-tab", "client_id" => client_id}
    }

    {state, [envelope], [%{kind: "status", text: "connecting"}]}
  end
end
```

**Step 4: Verify pass** — `mix cmd --app lattice_tab mix test test/lattice/tab/protocol_test.exs --trace`
Expected: 2 tests, 0 failures.

**Step 5: Commit**
```bash
git add apps/lattice_tab/lib/lattice/tab/protocol.ex apps/lattice_tab/test/lattice/tab/protocol_test.exs
git commit -m "feat(lattice_tab): Protocol struct, init/1, hello/1"
```

**Acceptance Criteria:**
- [ ] 2 tests pass
- [ ] No JSON/runtime deps used
- [ ] `mix compile --warnings-as-errors` clean

---

### Task A3: `handle/2` — `welcome`, `grant`, `state_request`

**Goal:** Consume `welcome` (store identity + emit `state_request`) and `grant` (store the echo cap), with render-intents.

**Files:**
- Modify: `apps/lattice_tab/lib/lattice/tab/protocol.ex` (add `handle/2` clauses)
- Modify: `apps/lattice_tab/test/lattice/tab/protocol_test.exs` (add `describe "handle/2 — connection"`)

**Context:** On `welcome` the JS demo stores `tab_id`/`client_id` then sends `state_request` ([client.js:129-140](../../examples/browser_demo/client.js:129)). On `grant` it reads `msg.cap.id` ([client.js:164-169](../../examples/browser_demo/client.js:164)) — so `external_cap` carries `"id"`.

**Step 1: Add failing tests**
```elixir
  describe "handle/2 — connection" do
    setup do
      {:ok, state: Protocol.init("client-abc-123")}
    end

    test "welcome stores tab_id/session_id and emits state_request", %{state: state} do
      env = %{"type" => "welcome", "tab_id" => "tab_9", "session_id" => "sess_1", "client_id" => "client-abc-123"}
      {state, outbound, intents} = Protocol.handle(state, env)

      assert state.tab_id == "tab_9"
      assert state.session_id == "sess_1"
      assert state.status == :online
      assert outbound == [%{"type" => "state_request"}]
      assert %{kind: "status", text: "connected", tab_id: "tab_9"} in intents
    end

    test "grant stores the echo cap_id and emits a cap intent", %{state: state} do
      env = %{"type" => "grant", "cap" => %{"id" => "cap_echo_42"}}
      {state, outbound, intents} = Protocol.handle(state, env)

      assert state.caps["echo"] == "cap_echo_42"
      assert outbound == []
      assert %{kind: "cap", text: "granted", cap_id: "cap_echo_42"} in intents
    end
  end
```

**Step 2: Verify fail** — Expected: FAIL — `Protocol.handle/2 is undefined`.

**Step 3: Implement** — append to `protocol.ex`:
```elixir
  @doc "Reduce one inbound envelope into new state + outbound envelopes + render-intents."
  @spec handle(t(), envelope()) :: step()
  def handle(%__MODULE__{} = state, %{"type" => "welcome"} = env) do
    state = %{
      state
      | tab_id: env["tab_id"],
        session_id: env["session_id"],
        client_id: env["client_id"] || state.client_id,
        status: :online
    }

    {state, [%{"type" => "state_request"}],
     [%{kind: "status", text: "connected", tab_id: state.tab_id}]}
  end

  def handle(%__MODULE__{} = state, %{"type" => "grant", "cap" => %{"id" => cap_id}}) do
    {%{state | caps: Map.put(state.caps, "echo", cap_id)}, [],
     [%{kind: "cap", text: "granted", cap_id: cap_id}]}
  end
```

**Step 4: Verify pass** — Expected: 4 tests, 0 failures.

**Step 5: Commit**
```bash
git add apps/lattice_tab/lib/lattice/tab/protocol.ex apps/lattice_tab/test/lattice/tab/protocol_test.exs
git commit -m "feat(lattice_tab): handle welcome + grant"
```

**Acceptance Criteria:**
- [ ] 4 tests pass · no warnings

---

### Task A4: `grant_request/2`, `call/3`, and `call_result`/`cast_result` consume

**Goal:** Build `grant_request` and `call` (selecting a held cap) and consume their results into render-intents.

**Files:**
- Modify: `apps/lattice_tab/lib/lattice/tab/protocol.ex`
- Modify: `apps/lattice_tab/test/lattice/tab/protocol_test.exs`

**Context:** Demo actions: grant target `"echo"`; allowed call `%{"op" => "echo", "message" => "visible capability"}` ([client.js:196-208](../../examples/browser_demo/client.js:196)). `call_result` carries `%{"ok" => bool}` ([client.js:171-173](../../examples/browser_demo/client.js:171)). The Realm **chooses the held cap_id** — the shell never does.

**Step 1: Add failing tests**
```elixir
  describe "build + result" do
    setup do
      base = Protocol.init("c1")
      {state, _o, _i} = Protocol.handle(base, %{"type" => "grant", "cap" => %{"id" => "cap_echo_42"}})
      {:ok, granted: state}
    end

    test "grant_request/2 builds a grant_request envelope" do
      {_state, outbound, _intents} = Protocol.grant_request(Protocol.init("c1"), "echo")
      assert outbound == [%{"type" => "grant_request", "target" => "echo"}]
    end

    test "call/3 builds a call using the held echo cap", %{granted: state} do
      {_state, outbound, _intents} = Protocol.call(state, "echo", "visible capability")

      assert [%{"type" => "call", "cap_id" => "cap_echo_42", "payload" => payload}] = outbound
      assert payload == %{"op" => "echo", "message" => "visible capability"}
    end

    test "call/3 without a held cap emits an error intent and no outbound" do
      {_state, outbound, intents} = Protocol.call(Protocol.init("c1"), "echo", "x")
      assert outbound == []
      assert [%{kind: "error", text: "no cap held"}] = intents
    end

    test "call_result maps ok:true to an allowed intent", %{granted: state} do
      {_state, outbound, intents} = Protocol.handle(state, %{"type" => "call_result", "ok" => true, "result" => %{"echo" => "hi"}})
      assert outbound == []
      assert %{kind: "call_result", ok: true} = hd(intents)
    end

    test "cast_result maps ok:false to a denied intent", %{granted: state} do
      {_state, _outbound, intents} = Protocol.handle(state, %{"type" => "cast_result", "ok" => false, "error" => ":denied"})
      assert %{kind: "cast_result", ok: false} = hd(intents)
    end
  end
```

**Step 2: Verify fail** — Expected: FAIL — `Protocol.grant_request/2 is undefined`.

**Step 3: Implement** — append:
```elixir
  @doc "Build a grant_request for a server-named target (e.g. \"echo\")."
  @spec grant_request(t(), String.t()) :: step()
  def grant_request(%__MODULE__{} = state, target) when is_binary(target) do
    {state, [%{"type" => "grant_request", "target" => target}], []}
  end

  @doc "Build a `call` using a held cap. The Realm — not the shell — selects the cap."
  @spec call(t(), String.t(), String.t()) :: step()
  def call(%__MODULE__{caps: caps} = state, op, message) do
    case Map.fetch(caps, "echo") do
      {:ok, cap_id} ->
        env = %{"type" => "call", "cap_id" => cap_id, "payload" => %{"op" => op, "message" => message}}
        {state, [env], []}

      :error ->
        {state, [], [%{kind: "error", text: "no cap held"}]}
    end
  end

  # consume results
  def handle(%__MODULE__{} = state, %{"type" => "call_result"} = env) do
    {state, [], [%{kind: "call_result", ok: env["ok"], result: env["result"], error: env["error"]}]}
  end

  def handle(%__MODULE__{} = state, %{"type" => "cast_result"} = env) do
    {state, [], [%{kind: "cast_result", ok: env["ok"], error: env["error"]}]}
  end
```

**Step 4: Verify pass** — Expected: 9 tests, 0 failures.

**Step 5: Commit**
```bash
git add apps/lattice_tab/lib/lattice/tab/protocol.ex apps/lattice_tab/test/lattice/tab/protocol_test.exs
git commit -m "feat(lattice_tab): build grant_request/call, consume results"
```

**Acceptance Criteria:**
- [ ] 9 tests pass · no warnings

---

### Task A5: `tab_call` → real `tab_render_result` (the milestone logic) + `error` + fall-through

**Goal:** Compute a **real** `tab_render_result` for an inbound `tab_call` — the BEAM equivalent of the JS fakes (the `setTimeout` at [client.js:178-188](../../examples/browser_demo/client.js:178) and the synchronous `renderWorkerResult` at [worker-client.js:110-121](../../examples/browser_demo/worker-client.js:110)).

**Files:**
- Modify: `apps/lattice_tab/lib/lattice/tab/protocol.ex`
- Modify: `apps/lattice_tab/test/lattice/tab/protocol_test.exs`

**Context:** This is the heart of the proof: a genuine BEAM process answering a capability-mediated `tab_call`. Inbound `tab_call` = `%{"type"=>"tab_call","request_id"=>..,"payload"=>..,"from_tab_id"=>..}` ([web_socket.ex:67-78](../../apps/lattice_server/lib/lattice/transport/web_socket.ex:67)); the response `tab_render_result` = `%{"type"=>"tab_render_result","request_id"=>..,"result"=>..}` ([web_socket.ex:305](../../apps/lattice_server/lib/lattice/transport/web_socket.ex:305)). The result shape unions the JS fakes' fields.

**Step 1: Add failing tests**
```elixir
  describe "handle/2 — tab_call milestone" do
    setup do
      {state, _o, _i} = Protocol.handle(Protocol.init("c1"), %{"type" => "welcome", "tab_id" => "tab_A", "session_id" => "s", "client_id" => "c1"})
      {:ok, state: state}
    end

    test "tab_call computes a real tab_render_result echoing pulse + op", %{state: state} do
      env = %{
        "type" => "tab_call",
        "request_id" => "req_42",
        "from_tab_id" => "tab_B",
        "payload" => %{"op" => "render", "pulse" => "blue"}
      }

      {^state, outbound, intents} = Protocol.handle(state, env)

      assert [%{"type" => "tab_render_result", "request_id" => "req_42", "result" => result}] = outbound
      assert result["realm"] == "atomvm"
      assert result["received_by"] == "tab_A"
      assert result["from_tab_id"] == "tab_B"
      assert result["op"] == "render"
      assert result["pulse"] == "blue"
      assert result["rendered"] == true
      assert %{kind: "pulse", route: "bridge"} in intents
    end

    test "error envelope becomes an error intent, no outbound", %{state: state} do
      {_state, outbound, intents} = Protocol.handle(state, %{"type" => "error", "error_type" => "denied", "reason" => ":nope"})
      assert outbound == []
      assert %{kind: "error", text: "denied"} = hd(intents)
    end

    test "unknown envelope type is a no-op", %{state: state} do
      assert {^state, [], []} = Protocol.handle(state, %{"type" => "totally_unknown"})
    end
  end
```

**Step 2: Verify fail** — Expected: FAIL on the `tab_call` assertion.

**Step 3: Implement** — append (the fall-through clause MUST be last):
```elixir
  def handle(%__MODULE__{} = state, %{"type" => "tab_call", "request_id" => request_id} = env) do
    result = render_tab_call(state, env)
    reply = %{"type" => "tab_render_result", "request_id" => request_id, "result" => result}
    {state, [reply], [%{kind: "pulse", route: "bridge"}]}
  end

  def handle(%__MODULE__{} = state, %{"type" => "error"} = env) do
    {state, [], [%{kind: "error", text: env["error_type"], reason: env["reason"]}]}
  end

  # Fall-through: any other (or out-of-scope) type is a no-op. MUST be the last clause.
  def handle(%__MODULE__{} = state, _envelope), do: {state, [], []}

  # Real result for a capability-mediated tab_call (replaces the JS fakes).
  defp render_tab_call(%__MODULE__{tab_id: tab_id}, env) do
    payload = env["payload"] || %{}

    %{
      "realm" => "atomvm",
      "received_by" => tab_id,
      "from_tab_id" => env["from_tab_id"],
      "op" => payload["op"],
      "pulse" => payload["pulse"],
      "rendered" => true
    }
  end
```

**Step 4: Verify pass** — Expected: 12 tests, 0 failures.

**Step 5: Commit**
```bash
git add apps/lattice_tab/lib/lattice/tab/protocol.ex apps/lattice_tab/test/lattice/tab/protocol_test.exs
git commit -m "feat(lattice_tab): tab_call -> real tab_render_result + error + fallthrough"
```

**Acceptance Criteria:**
- [ ] 12 tests pass · no warnings
- [ ] Fall-through clause is last (verified by the "unknown type" test)
- [ ] `snapshot`/`presence`/`server_event` full render parity is **intentionally deferred to Phase 3** (post-spike) — they currently hit the no-op fall-through, which is correct for this milestone.

---

## Group B — Server hardening + AtomVM static route

### Task B1: Extend `StaticHandler` (MIME + COOP/COEP via `isolate?`) + prefix whitelist

**Goal:** Serve `.wasm`/`.js`/`.avm` with correct MIME and add cross-origin-isolation headers when `isolate?` is set, preserving the explicit-whitelist security property.

**Files:**
- Modify: `apps/lattice_server/lib/lattice_server/static_handler.ex` (entire module — small)

**Context:** Current handler at [static_handler.ex](../../apps/lattice_server/lib/lattice_server/static_handler.ex) keys off the request path and serves a fixed whitelist. We add an `/atomvm_tab/`-prefixed whitelist + new MIME + optional isolation headers. `File.read` already returns a binary, so `.wasm`/`.avm` serve correctly.

**Step 1: Replace the module body** — `apps/lattice_server/lib/lattice_server/static_handler.ex`
```elixir
defmodule LatticeServer.StaticHandler do
  @moduledoc false

  @behaviour :cowboy_handler

  @impl true
  def init(req, opts) do
    static_dir = Map.fetch!(opts, :static_dir)
    isolate? = Map.get(opts, :isolate?, false)
    path = :cowboy_req.path(req)
    file = file_for(path)

    {status, content_type, body} =
      with {:ok, file} <- file,
           true <- safe_file?(file),
           {:ok, body} <- File.read(Path.join(static_dir, file)) do
        {200, content_type(file), body}
      else
        _ -> {404, "text/plain; charset=utf-8", "not found\n"}
      end

    headers =
      %{"content-type" => content_type, "cache-control" => "no-store"}
      |> maybe_isolate(isolate?)

    req = :cowboy_req.reply(status, headers, body, req)
    {:ok, req, %{}}
  end

  # --- JS demo whitelist (unchanged) ---
  defp file_for("/"), do: {:ok, "index.html"}
  defp file_for("/index.html"), do: {:ok, "index.html"}
  defp file_for("/client.js"), do: {:ok, "client.js"}
  defp file_for("/worker-client.js"), do: {:ok, "worker-client.js"}
  defp file_for("/worker.html"), do: {:ok, "worker.html"}
  defp file_for("/styles.css"), do: {:ok, "styles.css"}
  # --- AtomVM tab whitelist (prefix-stripped; same static_dir = examples/atomvm_tab) ---
  defp file_for("/atomvm_tab"), do: {:ok, "index.html"}
  defp file_for("/atomvm_tab/"), do: {:ok, "index.html"}
  defp file_for("/atomvm_tab/index.html"), do: {:ok, "index.html"}
  defp file_for("/atomvm_tab/styles.css"), do: {:ok, "styles.css"}
  defp file_for("/atomvm_tab/shell.js"), do: {:ok, "shell.js"}
  defp file_for("/atomvm_tab/AtomVM-web-v0.7.0-alpha.1.js"), do: {:ok, "AtomVM-web-v0.7.0-alpha.1.js"}
  defp file_for("/atomvm_tab/AtomVM-web-v0.7.0-alpha.1.wasm"), do: {:ok, "AtomVM-web-v0.7.0-alpha.1.wasm"}
  defp file_for("/atomvm_tab/lattice_tab.avm"), do: {:ok, "lattice_tab.avm"}
  defp file_for("/atomvm_tab/atomvmlib.avm"), do: {:ok, "atomvmlib.avm"}
  defp file_for(_), do: {:error, :not_found}

  defp safe_file?(file), do: not String.contains?(file, "..")

  defp content_type("client.js"), do: "application/javascript; charset=utf-8"
  defp content_type("worker-client.js"), do: "application/javascript; charset=utf-8"
  defp content_type("shell.js"), do: "text/javascript; charset=utf-8"
  defp content_type("styles.css"), do: "text/css; charset=utf-8"

  defp content_type(file) do
    cond do
      String.ends_with?(file, ".wasm") -> "application/wasm"
      String.ends_with?(file, ".avm") -> "application/octet-stream"
      String.ends_with?(file, ".js") -> "text/javascript; charset=utf-8"
      String.ends_with?(file, ".html") -> "text/html; charset=utf-8"
      true -> "text/html; charset=utf-8"
    end
  end

  defp maybe_isolate(headers, false), do: headers

  defp maybe_isolate(headers, true) do
    Map.merge(headers, %{
      "cross-origin-opener-policy" => "same-origin",
      "cross-origin-embedder-policy" => "require-corp",
      "cross-origin-resource-policy" => "same-origin"
    })
  end
end
```

**Step 2: Verify compile** — `mix compile --warnings-as-errors`. Expected: clean. (Integration test lands in B4, after the route exists.)

**Step 3: Commit**
```bash
git add apps/lattice_server/lib/lattice_server/static_handler.ex
git commit -m "feat(server): static handler serves wasm/avm + optional COOP/COEP isolation"
```

**Acceptance Criteria:**
- [ ] Compiles clean; existing JS-demo whitelist clauses unchanged
- [ ] `..` rejection preserved

---

### Task B2: `examples/atomvm_tab` placeholders

**Goal:** A minimal, servable AtomVM-tab page so the route is testable now (the real `shell.js` + vendored VM come post-spike).

**Files:**
- Create: `examples/atomvm_tab/index.html`
- Create: `examples/atomvm_tab/styles.css`

**Step 1: Create `examples/atomvm_tab/index.html`**
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Lattice — AtomVM tab (placeholder)</title>
    <link rel="stylesheet" href="/atomvm_tab/styles.css" />
  </head>
  <body>
    <main id="app" data-atomvm-ready="false">
      <h1>Lattice AtomVM tab</h1>
      <p id="status">shell + WASM bridge land after the Phase-0 spike.</p>
    </main>
    <!-- shell.js + AtomVM bundle are wired post-spike (deferred tasks). -->
  </body>
</html>
```

**Step 2: Create `examples/atomvm_tab/styles.css`**
```css
body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; color: #0a2540; }
#status { color: #475569; }
```

**Step 3: Commit**
```bash
git add examples/atomvm_tab/index.html examples/atomvm_tab/styles.css
git commit -m "feat(examples): atomvm_tab placeholder page"
```

**Acceptance Criteria:**
- [ ] Files exist and are valid HTML/CSS

---

### Task B3: Add the `/atomvm_tab` route + `max_frame_size` hardening

**Goal:** Wire the isolated AtomVM-tab route (COOP/COEP scoped to it) and bound WebSocket frame size for both tab types (Design Issue 6).

**Files:**
- Modify: `apps/lattice_server/lib/lattice_server.ex`

**Context:** Dispatch + cowboy opts at [lattice_server.ex:16-48](../../apps/lattice_server/lib/lattice_server.ex:16). Add the route **before** the catch-all; add `max_frame_size` to the protocol opts map.

**Step 1: Add the `atomvm_tab_dir` opt** — after [lattice_server.ex:10](../../apps/lattice_server/lib/lattice_server.ex:10):
```elixir
    atomvm_tab_dir =
      Keyword.get(opts, :atomvm_tab_dir, Path.expand("examples/atomvm_tab", File.cwd!()))
```

**Step 2: Add the route** — insert immediately **before** the catch-all line `{:_, LatticeServer.StaticHandler, %{static_dir: static_dir}}` ([lattice_server.ex:31](../../apps/lattice_server/lib/lattice_server.ex:31)):
```elixir
           {"/atomvm_tab/[...]", LatticeServer.StaticHandler,
            %{static_dir: atomvm_tab_dir, isolate?: true}},
```

**Step 3: Add `max_frame_size`** — in the protocol opts map ([lattice_server.ex:38-47](../../apps/lattice_server/lib/lattice_server.ex:38)), add the key:
```elixir
        max_frame_size: 65_536,
```
(Sits alongside `idle_timeout`, `max_keepalive`, etc. Matches the [envelope.ex:11](../../apps/lattice_server/lib/lattice/transport/web_socket/envelope.ex:11) parse cap so oversized frames are rejected by Cowboy before assembly.)

**Step 4: Verify compile** — `mix compile --warnings-as-errors`. Expected: clean.

**Step 5: Commit**
```bash
git add apps/lattice_server/lib/lattice_server.ex
git commit -m "feat(server): isolated /atomvm_tab route + max_frame_size 65536"
```

**Acceptance Criteria:**
- [ ] Route added before catch-all; JS demo `/` unaffected
- [ ] `max_frame_size: 65_536` set in cowboy opts

---

### Task B4: Integration test — isolation headers + MIME + scoping

**Goal:** Prove `/atomvm_tab` serves with COOP/COEP + correct MIME, and that `/` (JS demo) is **not** isolated.

**Files:**
- Create: `apps/lattice_server/test/atomvm_static_test.exs`

**Context:** Uses the shared harness [LatticeServer.TestSupport.HTTP](../../apps/lattice_server/test_support/http.ex) (`free_port/0`, `http_get/2`, `raw_http_with_head/5` → `{:ok, status, head, body}` where `head` is the raw response head incl. headers). Server tests are `async: false` (they boot Cowboy). The test creates a hermetic tmp `atomvm_tab_dir` fixture so it does not depend on the (post-spike) vendored binaries.

**Step 1: Write the test**
```elixir
defmodule LatticeServer.AtomvmStaticTest do
  use ExUnit.Case, async: false

  alias LatticeServer.TestSupport.HTTP

  setup do
    tab_dir = Path.join(System.tmp_dir!(), "atomvm_tab_#{System.unique_integer([:positive])}")
    File.mkdir_p!(tab_dir)
    File.write!(Path.join(tab_dir, "index.html"), "<!doctype html><title>atomvm</title>")
    File.write!(Path.join(tab_dir, "AtomVM-web-v0.7.0-alpha.1.wasm"), <<0, 97, 115, 109>>)

    listener = :"atomvm_static_test_#{System.unique_integer([:positive])}"
    port = HTTP.free_port()

    {:ok, _pid} =
      LatticeServer.start_http(
        listener: listener,
        port: port,
        static_dir: Path.expand("../../../examples/browser_demo", __DIR__),
        atomvm_tab_dir: tab_dir,
        auto_story?: false,
        grant_targets: %{}
      )

    on_exit(fn ->
      LatticeServer.stop_http(listener)
      File.rm_rf!(tab_dir)
    end)

    {:ok, port: port}
  end

  describe "/atomvm_tab isolation" do
    test "index.html is served cross-origin-isolated", %{port: port} do
      assert {:ok, 200, head, body} = HTTP.raw_http_with_head(port, "GET", "/atomvm_tab/index.html")
      assert body =~ "atomvm"
      assert head =~ "cross-origin-opener-policy: same-origin"
      assert head =~ "cross-origin-embedder-policy: require-corp"
      assert head =~ "cross-origin-resource-policy: same-origin"
    end

    test ".wasm is served with application/wasm + isolation", %{port: port} do
      assert {:ok, 200, head, _body} =
               HTTP.raw_http_with_head(port, "GET", "/atomvm_tab/AtomVM-web-v0.7.0-alpha.1.wasm")

      assert head =~ "content-type: application/wasm"
      assert head =~ "cross-origin-embedder-policy: require-corp"
    end

    test "unknown atomvm_tab file is 404 (whitelist preserved)", %{port: port} do
      assert {:ok, 404, _head, _body} = HTTP.raw_http_with_head(port, "GET", "/atomvm_tab/secret.key")
    end
  end

  describe "JS demo route is not isolated" do
    test "/ has no cross-origin-embedder-policy header", %{port: port} do
      assert {:ok, 200, head, _body} = HTTP.raw_http_with_head(port, "GET", "/")
      refute head =~ "cross-origin-embedder-policy"
    end
  end
end
```

**Step 2: Verify pass** — `mix cmd --app lattice_server mix test test/atomvm_static_test.exs --trace`
Expected: 4 tests, 0 failures.

**Step 3: Commit**
```bash
git add apps/lattice_server/test/atomvm_static_test.exs
git commit -m "test(server): atomvm_tab isolation headers + MIME + scoping"
```

**Acceptance Criteria:**
- [ ] 4 tests pass
- [ ] Confirms COOP/COEP scoped to `/atomvm_tab` only

---

## Group C — Phase-0 spike (go/no-go gates)

> These are **research-verification** tasks, not TDD. Each task's "acceptance" is its gate outcome, **recorded in `output/atomvm_spike/PHASE0.md`**. If a gate fails, STOP and consult the design's fallback (separate build context, or Popcorn). Builders run these manually/observably; they do not block Groups A/B.

### Task C1: Fetch + verify the pinned AtomVM web bundle and packaging tool

**Goal:** Obtain `AtomVM-web-v0.7.0-alpha.1.{js,wasm}` + `atomvmlib`, verify sha256, and confirm ExAtomVM/`atomvm_packbeam` is installable.

**Commands:**
```bash
mkdir -p spike/atomvm/vendor output/atomvm_spike
cd spike/atomvm/vendor
base=https://github.com/atomvm/AtomVM/releases/download/v0.7.0-alpha.1
for f in AtomVM-web-v0.7.0-alpha.1.js AtomVM-web-v0.7.0-alpha.1.wasm \
         AtomVM-web-v0.7.0-alpha.1.js.sha256 AtomVM-web-v0.7.0-alpha.1.wasm.sha256; do
  curl -fsSL -O "$base/$f"
done
# Verify (the .sha256 files are published alongside the assets)
shasum -a 256 -c AtomVM-web-v0.7.0-alpha.1.js.sha256
shasum -a 256 -c AtomVM-web-v0.7.0-alpha.1.wasm.sha256
```
Also locate the stdlib `.avm` to co-load: confirm whether the web bundle requires `atomvmlib-*.avm` (released asset) or embeds the stdlib.

**Gate (record in PHASE0.md):**
- [ ] Web assets downloaded; **sha256 verified** — and **if** a generic `atomvmlib-v0.7.0-alpha.1.avm` web asset ships, fetch + verify its `.sha256` too (else record that the web bundle embeds the stdlib).
- [ ] Pinned exact tag + recorded hashes (for the future CI hash check).
- [ ] `atomvm_packbeam` tool obtained (note exact install path: Hex `:exatomvm`, the `atomvm/atomvm_packbeam` escript, or a release binary).

---

### Task C2: Bytecode gate — OTP-28 `.beam` in alpha AtomVM (THE highest-risk gate)

**Goal:** Prove a `.avm` built on the **repo toolchain (Elixir 1.19 / OTP 28)** loads and runs in `v0.7.0-alpha.1`.

**Commands:**
```bash
# In a THROWAWAY mini-project (NOT apps/lattice_tab):
mkdir -p spike/atomvm/hello/lib
cat > spike/atomvm/hello/lib/hello.ex <<'EOF'
defmodule Hello do
  def start, do: :erlang.display(:hello_from_atomvm)
end
EOF
# Add :exatomvm, then:
cd spike/atomvm/hello && mix deps.get && mix atomvm.packbeam
# Run the packed .avm under the alpha node build (or the web build via Task C3):
node ../vendor/AtomVM-node-v0.7.0-alpha.1.js Hello.avm   # if using the node bundle
```

**Gate (record in PHASE0.md):**
- [ ] **PASS:** `.avm` runs, prints `hello_from_atomvm`. → proceed on the repo toolchain.
- [ ] **FAIL:** record the exact error (opcode/version). → switch `apps/lattice_tab` to a **separate older-toolchain build context**, or invoke the **Popcorn fallback**. **This is the project's primary go/no-go.**

---

### Task C3: Load gate — VM boots in a browser under COOP/COEP

**Goal:** The web bundle initializes in a real (headless) browser served with the isolation headers from Group B.

**Commands:** Serve `spike/atomvm/` (the vendored `.js`/`.wasm` + a tiny `index.html` that loads them) with COOP/COEP (reuse the Group-B `static_handler` via `LatticeServer.start_http`, or a throwaway server). Drive with Playwright (already a repo dev tool) headless Chromium; assert a console/DOM marker that the VM reported ready.

**Gate (record in PHASE0.md):**
- [ ] VM boots in-browser (ready marker observed) under `require-corp`. Note the **exact JS init API** (module/global names, how the `.wasm` + stdlib `.avm` are passed).

---

### Task C4: Round-trip + SECURITY gate (criterion 1b)

**Goal:** Establish the JS↔BEAM bridge **and confirm the BEAM→JS path passes data as structured arguments to pre-registered functions — NOT an `eval`/`run_script` string** (Design Issue 1).

**Commands/observations:** From the booted VM, send one message JS→BEAM (e.g. `Module.cast`-style) and have BEAM call back JS→shell with a value. Inspect the actual AtomVM `emscripten`/interop API used.

**Gate (record in PHASE0.md):**
- [ ] One message round-trips JS→BEAM→JS.
- [ ] **SECURITY:** the BEAM→JS mechanism is a structured/registered-function call. If only `run_script` (eval) exists, document the **safe usage pattern** (call a pre-registered function by name with no interpolation) and confirm it is achievable. **No interpolation of envelope/codec bytes into JS source — ever.**
- [ ] Record the exact API names + the chosen pattern (input to the deferred `Bridge` task).

---

### Task C5: Threading gate (measurable)

**Goal:** Resolve the `run_script([main_thread])`-blocks concern (Design Issue 7) with a number.

**Commands/observations:** Drive a burst of BEAM→shell sends; measure latency; confirm no deadlock/UI stall. Also try AtomVM's native `websocket` module (`websocket:new`/`send_utf8`) as a BEAM-owned-socket alternative.

**Gate (record in PHASE0.md):**
- [ ] Send latency within a stated budget (record p50/p99) and **no deadlock** under burst.
- [ ] Decision recorded: shell-mediated send vs BEAM-owned WebSocket; worker vs `[main_thread]`.

---

### Task C6: JSON gate (criterion 4) — one real envelope

**Goal:** In-BEAM, consume a fake `welcome` and emit a `hello` JSON envelope (or decide JS-parses-syntax).

**Commands/observations:** Feed the VM a `welcome` JSON string; have the (spike) BEAM code parse it and emit a `hello` string; verify on the JS side.

**Gate (record in PHASE0.md):**
- [ ] One real envelope round-trips with JSON handled per the chosen location.
- [ ] Decision recorded: **JSON decode in BEAM** (raw string crosses) vs **in JS** (decoded map crosses). Both keep the shell authority-blind. (This determines the deferred `Codec`/`Bridge` shape.)

---

### Task C7: Write `output/atomvm_spike/PHASE0.md` (the re-plan input)

**Goal:** Consolidate all gate outcomes + the **resolved open questions** so the deferred work can be atomized.

**Contents (required):** Per-gate PASS/FAIL + evidence; **exact bridge API names**; threading decision; JSON-location decision; toolchain decision (repo 1.19/28 vs separate context vs Popcorn); pinned asset hashes; whether `atomvmlib.avm` must co-load.

**Gate:**
- [ ] `output/atomvm_spike/PHASE0.md` exists and answers Design "Open questions" 1-5. Open Question 6 (in-WASM process richness for the deferred *in-tab OTP topology* stretch — a non-goal) is recorded opportunistically if observed during C3-C5, else explicitly left open.
- [ ] Commit: `git add output/atomvm_spike/PHASE0.md spike/ && git commit -m "spike(atomvm): Phase-0 gate results + resolved unknowns"`

---

## Integration / Verification (after Groups A + B; C is independent)

### Integration Task: full-suite green + no regressions

**Depends on:** All Group A + Group B tasks.

**Step 1: Full suite**
```bash
mix test
```
Expected: all pass, including the new `lattice_tab` (12) + `atomvm_static_test` (4); **no regressions** in existing suites.

**Step 2: Quality gates**
```bash
mix compile --warnings-as-errors
mix format --check-formatted
```

**Acceptance:**
- [ ] `mix test` green across the umbrella
- [ ] No new warnings; formatted
- [ ] `apps/lattice_tab` adds **zero** new runtime deps and **zero** new required toolchain to default CI (the AtomVM toolchain lives only in Group C / the deferred opt-in CI job)

---

## DEFERRED (post-spike) — re-run `/atomic-plan` after Group C

Each item lists the **Phase-0 output it needs** (from `PHASE0.md`). These could not be grounded now without fabricating AtomVM interop.

| Design component | Deferred task | Needs from Phase 0 |
|---|---|---|
| `Lattice.Tab.Bridge` | implement BEAM↔JS bridge (pre-registered fns, no eval) | C4 (API names + security pattern), C5 (threading) |
| `Lattice.Tab.Realm` | process loop wrapping `Protocol` + `Bridge.start(client_id, last_seq)` / `deliver/1` | C4, C5 |
| `Lattice.Tab.Main` (`start/0`) | packbeam entry that boots `Realm` | C2 (packaging) |
| `Lattice.Tab.Codec` (WASM backend) | JSON in BEAM or JS-syntax seam | C6 (JSON location) |
| **Protocol completeness** — `cast/3` build + consume render-parity for `snapshot`/`presence`/`server_event`/`tab_cast` | Phase 3 (full state machine) | **none** (pure Elixir, host-testable; deferred as Phase-3 parity, not milestone-critical — the demo path uses only `call`). Drift-check found `cast`-build/`tab_cast` were otherwise untracked. |
| Shell `examples/atomvm_tab/shell.js` | real authority-blind I/O + `Bridge.start` + ready beacon | C3 (init API), C4 |
| ExAtomVM wiring in `apps/lattice_tab/mix.exs` + build script | produce `lattice_tab.avm`, stage vendored VM (+ sha256) | C1, C2 |
| WASM smoke test (guarded) | `.avm` loads + round-trips | C2, C3 |
| Playwright E2E `scripts/lattice_atomvm_tab_e2e.mjs` | connect→grant→call→deny→tab_call→revoke | all of C |
| **Over-WebSocket adversarial parity** (Phase-2 gate) | forged-cap / revoke-then-denied from an AtomVM session | C (a live AtomVM tab) |
| Docs future-work→implemented (5 docs) | Phase-4 | proof artifact |
| Opt-in CI job | installs AtomVM toolchain + `atomvm_packbeam`, sha256-checks VM | C1 |

---

## Drift check (planner self-audit vs design)

- **Every design component maps** to a now-task or a gated deferred task (table above). ✓
- **Nothing introduced** that is not in the design (the Protocol shapes/`tab_call` result are grounded in `web_socket.ex` + the JS demo; server edits are exactly Design §Static serving/§Route wiring). ✓
- **Scope honesty:** the design's Phases 1-4 are explicitly deferred (not silently dropped); the design's own "host-testable Protocol" insight is what makes Group A buildable now. ✓
- **No design component violated/expanded:** gateway/envelope/WebSocket remain untouched; `max_frame_size` is the design's Issue-6 hardening, not new scope. ✓
