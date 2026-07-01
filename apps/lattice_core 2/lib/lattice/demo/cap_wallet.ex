defmodule Lattice.Demo.CapWallet do
  @moduledoc """
  Wallet-as-process demo for caveated PID-as-capability authority.
  """

  use GenServer

  alias Lattice.Cap.Membrane
  alias Lattice.Demo.LocalTab

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts)
  end

  def ledger(pid), do: GenServer.call(pid, :ledger)

  def run_demo do
    {:ok, wallet} = start_link([])
    {:ok, _wallet_pid, _wallet_tab} = LocalTab.connect(identity: %{role: "wallet"})
    {:ok, _merchant_pid, merchant_tab} = LocalTab.connect(identity: %{role: "merchant"})

    {:ok, cap} =
      Lattice.grant(merchant_tab.id, wallet, [:call],
        amount_max: 50,
        vendor: "bookshop",
        requires_confirmation: true,
        provenance_label: "wallet-consent",
        schema: %{
          amount: :number,
          vendor: :string,
          confirmed?: :boolean,
          provenance_label: :string
        }
      )

    allowed =
      Lattice.call(merchant_tab.id, cap, %{
        amount: 40,
        vendor: "bookshop",
        confirmed?: true,
        provenance_label: "wallet-consent"
      })

    overreach =
      Lattice.call(merchant_tab.id, cap, %{
        amount: 500,
        vendor: "bookshop",
        confirmed?: true,
        provenance_label: "wallet-consent"
      })

    confused_deputy =
      Membrane.call(merchant_tab.id, cap, %{
        target: wallet,
        amount: 10,
        vendor: "bookshop",
        confirmed?: true,
        provenance_label: "wallet-consent"
      })

    %{
      cap: cap,
      allowed: allowed,
      overreach: overreach,
      confused_deputy: confused_deputy,
      ledger: ledger(wallet)
    }
  end

  @impl true
  def init(_opts), do: {:ok, %{ledger: []}}

  @impl true
  def handle_call({:lattice_call, %{from_tab_id: tab_id, payload: payload}}, _from, state) do
    entry = %{
      from_tab_id: tab_id,
      amount: payload[:amount] || payload["amount"],
      vendor: payload[:vendor] || payload["vendor"],
      at: System.monotonic_time(:millisecond)
    }

    {:reply, {:ok, %{charged: entry.amount, vendor: entry.vendor}},
     %{state | ledger: state.ledger ++ [entry]}}
  end

  def handle_call(:ledger, _from, state), do: {:reply, state.ledger, state}
end
