defmodule Lattice.Demo.LiveIntrospection do
  @moduledoc """
  Consent-gated live introspection demo.
  """

  alias Lattice.Demo.LocalTab

  def run_demo do
    {:ok, inspector} = Lattice.Graph.Inspector.start_link([])
    {:ok, _pid, tab} = LocalTab.connect(identity: %{role: "operator"})

    before_consent = Lattice.call(tab.id, "no-introspection-cap", %{op: :snapshot})

    {:ok, cap} =
      Lattice.grant(tab.id, inspector, [:call],
        requires_confirmation: true,
        schema: %{op: {:one_of, [:snapshot]}, confirmed?: :boolean}
      )

    unconfirmed = Lattice.call(tab.id, cap, %{op: :snapshot, confirmed?: false})
    confirmed = Lattice.call(tab.id, cap, %{op: :snapshot, confirmed?: true})

    %{before_consent: before_consent, unconfirmed: unconfirmed, confirmed: confirmed}
  end
end
