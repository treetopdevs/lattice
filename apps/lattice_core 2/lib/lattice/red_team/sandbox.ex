defmodule Lattice.RedTeam.Sandbox do
  @moduledoc """
  Adversarial process sandbox for repeatable authority-boundary attacks.
  """

  alias Lattice.Demo.{CapWallet, LocalTab}

  def run do
    {:ok, wallet} = CapWallet.start_link([])
    {:ok, _owner_pid, owner} = LocalTab.connect(identity: %{role: "owner"})
    {:ok, _attacker_pid, attacker} = LocalTab.connect(identity: %{role: "attacker"})

    {:ok, cap} =
      Lattice.grant(owner.id, wallet, [:call],
        amount_max: 20,
        vendor: "books",
        requires_confirmation: true
      )

    {:ok, _direct_cap} = Lattice.grant(owner.id, {:tab, attacker.id}, [:call])

    %{
      forged_cap: Lattice.call(attacker.id, "forged", %{amount: 1}),
      stolen_cap: Lattice.call(attacker.id, cap, %{amount: 1, vendor: "books", confirmed?: true}),
      over_amount: Lattice.call(owner.id, cap, %{amount: 200, vendor: "books", confirmed?: true}),
      wrong_vendor:
        Lattice.call(owner.id, cap, %{amount: 5, vendor: "diamonds", confirmed?: true}),
      missing_confirmation: Lattice.call(owner.id, cap, %{amount: 5, vendor: "books"}),
      no_tab_bridge: Lattice.call(owner.id, cap_id_for(owner.id, attacker.id), %{op: :relay}),
      secret_to_public_ifc: ifc_attack(owner.id, attacker.id)
    }
  end

  defp cap_id_for(owner_id, target_tab_id) do
    Lattice.diagnostics().caps.caps
    |> Enum.find_value(fn {_id, cap} ->
      if cap.owner_tab_id == owner_id and cap.target == {:tab, target_tab_id}, do: cap
    end)
  end

  defp ifc_attack(owner_id, attacker_id) do
    Lattice.IFC.label(owner_id, :secret)
    Lattice.IFC.label(attacker_id, :public)
    Lattice.IFC.transfer(owner_id, attacker_id, %{secret: "server-state"})
  end
end
