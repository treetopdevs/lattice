defmodule Lattice.Flagship.Snapshot do
  @moduledoc """
  Cross-tier snapshot contract for the flagship demo.
  """

  alias Lattice.Flagship.{Claims, Scenario, Wallet}

  @fields [
    :type,
    :current_step,
    :presenter,
    :story,
    :actions,
    :actors,
    :policy,
    :cap,
    :wallet,
    :results,
    :graph,
    :audit_events,
    :claims,
    :exports
  ]

  @derive Jason.Encoder
  defstruct @fields

  @required_keys Enum.reject(@fields, &(&1 in [:current_step, :cap]))

  def required_keys, do: @required_keys

  def build(state) do
    graph = Lattice.Graph.snapshot()
    audit_events = Lattice.audit_events()

    %__MODULE__{
      type: "flagship_snapshot",
      current_step: state.current_step,
      presenter: presenter(state),
      story: story(state),
      actions: Scenario.actions(),
      actors: actors(state),
      policy: Scenario.policy(),
      cap: external_cap(state.cap),
      wallet: wallet_state(state),
      results: state.results,
      graph: graph,
      audit_events: audit_events,
      claims: Claims.all(),
      exports: %{
        json: "/api/flagship/export/json",
        mermaid: "/api/flagship/export/mermaid",
        dot: "/api/flagship/export/dot"
      }
    }
    |> validate!()
  end

  def validate!(%__MODULE__{} = snapshot) do
    missing =
      @required_keys
      |> Enum.filter(&(Map.get(snapshot, &1) == nil))

    if missing == [] do
      snapshot
    else
      raise ArgumentError, "flagship snapshot missing required keys: #{inspect(missing)}"
    end
  end

  def validate!(other) do
    raise ArgumentError, "expected #{inspect(__MODULE__)}, got: #{inspect(other)}"
  end

  defp story(state) do
    Scenario.step_order()
    |> Enum.with_index(1)
    |> Enum.map(fn {step, index} ->
      state.steps[step]
      |> Map.put(:id, step)
      |> Map.put(:label, Scenario.step_label(step))
      |> Map.put(:step_number, index)
      |> Map.put(:active, state.current_step == step)
      |> maybe_put_expected(step)
    end)
  end

  defp maybe_put_expected(story_step, step) do
    case Scenario.expected_result(step) do
      nil -> story_step
      expected -> Map.put(story_step, :expected_result, expected)
    end
  end

  defp presenter(state) do
    %{
      headline: presenter_headline(state.current_step),
      current_step: state.current_step,
      current_step_number: step_number(state.current_step),
      invariant:
        "Capabilities are authority edges. Lifecycle and audit events explain why an edge can or cannot carry a message.",
      narration: presenter_narration(state.current_step),
      next_action: next_action(state)
    }
  end

  defp actors(state) do
    %{
      wallet_tab_id: state.wallet_tab && state.wallet_tab.id,
      planner_tab_id: state.agent_tab && state.agent_tab.id,
      red_team_tab_id: state.attacker_tab && state.attacker_tab.id,
      wallet_pid: state.wallet_pid && inspect(state.wallet_pid),
      graph_inspector_pid: state.inspector_pid && inspect(state.inspector_pid)
    }
  end

  defp wallet_state(%{wallet_pid: pid}) when is_pid(pid) do
    %{ledger: Wallet.ledger(pid), delivery_count: Wallet.delivery_count(pid)}
  end

  defp wallet_state(_state), do: %{ledger: [], delivery_count: 0}

  defp external_cap(nil), do: nil
  defp external_cap(cap), do: Lattice.external_cap(cap)

  defp step_number(step) do
    case Enum.find_index(Scenario.step_order(), &(&1 == step)) do
      nil -> nil
      index -> index + 1
    end
  end

  defp presenter_headline(nil), do: "Ready: no wallet authority has been granted"
  defp presenter_headline(:reset), do: "Reset: the trust graph is clean"
  defp presenter_headline(step), do: "#{Scenario.step_label(step)}"

  defp presenter_narration(nil) do
    "Start by connecting the three realms. The graph should show processes before it shows authority."
  end

  defp presenter_narration(:reset) do
    "All demo processes and authority edges have been cleared. The next visible change should be realm presence, not wallet authority."
  end

  defp presenter_narration(step), do: Scenario.step_definition(step).narration

  defp next_action(state) do
    Scenario.step_order()
    |> Enum.find(fn step -> state.steps[step].status == :pending end)
    |> case do
      nil -> "Next: inspect the selected edge, audit event, graph exports, and CI artifacts."
      step -> "Next: #{Scenario.step_label(step)}"
    end
  end
end
