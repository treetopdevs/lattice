defmodule Lattice.Demo.AgentTools do
  @moduledoc """
  Capability-gated AI-agent tool-use demo.

  The "agent" is simulated: it is a tab realm making tool calls through caps.
  No model API is invoked, and no ambient tool authority is granted.
  """

  alias Lattice.Demo.{CapWallet, LocalTab}

  def run_demo do
    {:ok, wallet} = CapWallet.start_link([])
    {:ok, _agent_pid, agent_tab} = LocalTab.connect(identity: %{role: "simulated_ai_agent"})

    {:ok, tool_cap} =
      Lattice.grant(agent_tab.id, wallet, [:call],
        amount_max: 25,
        vendor: "gpu-credits",
        requires_confirmation: true
      )

    allowed =
      Lattice.call(agent_tab.id, tool_cap, %{
        amount: 10,
        vendor: "gpu-credits",
        confirmed?: true
      })

    over_budget =
      Lattice.call(agent_tab.id, tool_cap, %{
        amount: 100,
        vendor: "gpu-credits",
        confirmed?: true
      })

    forged = Lattice.call(agent_tab.id, "agent-forged-cap", %{amount: 1})

    %{agent_tab_id: agent_tab.id, allowed: allowed, over_budget: over_budget, forged: forged}
  end
end
