defmodule LatticeCarrierServer.Operator.CatalogCeremony.Atoms do
  @moduledoc false
  # `Lattice.Log.restore_verified/1` decodes with `binary_to_term(:safe)`, which
  # refuses any atom the VM has not interned yet. A fresh `mix` OS process has
  # loaded only the modules it touched, so load every module of the apps whose
  # atoms a Space log can carry before decoding one.

  @apps [:lattice_core, :lattice_carrier_server]

  @spec load() :: :ok
  def load do
    if :persistent_term.get({__MODULE__, :loaded}, false) do
      :ok
    else
      for app <- @apps do
        _ = Application.load(app)
        for module <- Application.spec(app, :modules) || [], do: Code.ensure_loaded(module)
      end

      :persistent_term.put({__MODULE__, :loaded}, true)
    end
  end
end
