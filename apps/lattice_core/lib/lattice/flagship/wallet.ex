defmodule Lattice.Flagship.Wallet do
  @moduledoc """
  Wallet-as-process target for the flagship demo.

  Only gateway-authorized calls reach this process. Denied overreach attempts
  are proven by the ledger and delivery count staying unchanged.
  """

  use GenServer

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts)
  end

  def ledger(pid), do: GenServer.call(pid, :ledger)
  def delivery_count(pid), do: GenServer.call(pid, :delivery_count)

  @impl true
  def init(opts) do
    {:ok,
     %{
       label: Keyword.get(opts, :label, "Wallet process"),
       ledger: [],
       delivery_count: 0
     }}
  end

  @impl true
  def handle_call({:lattice_call, %{from_tab_id: tab_id, payload: payload}}, _from, state) do
    entry = %{
      id: "purchase_" <> Lattice.Realm.random_id(8),
      amount: payload[:amount] || payload["amount"],
      vendor: payload[:vendor] || payload["vendor"],
      item: payload[:item] || payload["item"],
      from_tab_id: tab_id,
      at: System.system_time(:millisecond)
    }

    reply = %{
      approved: true,
      receipt_id: entry.id,
      amount: entry.amount,
      vendor: entry.vendor,
      item: entry.item
    }

    {:reply, {:ok, reply},
     %{
       state
       | ledger: state.ledger ++ [entry],
         delivery_count: state.delivery_count + 1
     }}
  end

  def handle_call(:ledger, _from, state), do: {:reply, state.ledger, state}
  def handle_call(:delivery_count, _from, state), do: {:reply, state.delivery_count, state}
end
