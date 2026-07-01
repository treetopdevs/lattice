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
  def run_constant(script) when is_binary(script),
    do: :emscripten.run_script(script, [:main_thread])

  @doc "Emit the deterministic ready beacon once the Realm is registered."
  @spec ready_beacon() :: :ok
  def ready_beacon do
    run_constant(
      "document.getElementById('app') && " <>
        "document.getElementById('app').setAttribute('data-atomvm-ready','true');"
    )
  end
end
