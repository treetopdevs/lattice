defmodule Lattice.Flagship.Scenario do
  @moduledoc """
  Declarative story contract for the flagship demo.
  """

  @limit 300
  @vendor "bookshop"
  @provenance_label "wallet-consent"
  @cap_ttl_ms 120_000

  @steps [
    %{
      id: :connect,
      action: "connect",
      label: "Connect realms",
      pending_detail: "Awaiting realm connection.",
      narration:
        "Wallet, planner, and red-team realms are live. They still have zero ambient authority over the wallet process."
    },
    %{
      id: :grant,
      action: "grant",
      label: "Issue caveated cap",
      pending_detail: "Awaiting wallet consent and cap issuance.",
      narration:
        "Wallet consent created one caveated authority edge: planner to wallet, bookshop only, at or below $300, with confirmation and provenance."
    },
    %{
      id: :allowed,
      action: "allowed",
      label: "Approve $199 bookshop",
      story_label: "Approve $199 at bookshop",
      pending_detail: "Awaiting a purchase that satisfies all caveats.",
      narration:
        "The benign purchase satisfies every caveat, reaches the wallet process, and increments the wallet ledger exactly once.",
      expected_result: %{ok: true, delivered_to_wallet?: true}
    },
    %{
      id: :over_budget,
      action: "over_budget",
      label: "Attempt $425",
      story_label: "Deny over budget",
      pending_detail: "Awaiting an over-budget denial.",
      narration:
        "The planner still holds the cap, but the amount caveat rejects this message before the wallet process can see it.",
      expected_result: %{ok: false, error: ":amount_exceeds_caveat", delivered_to_wallet?: false}
    },
    %{
      id: :wrong_vendor,
      action: "wrong_vendor",
      label: "Attempt wrong vendor",
      story_label: "Deny wrong vendor",
      pending_detail: "Awaiting a wrong-vendor denial.",
      narration:
        "The numeric bound is satisfied, but the symbolic vendor caveat rejects the message before delivery.",
      expected_result: %{ok: false, error: ":vendor_not_allowed", delivered_to_wallet?: false}
    },
    %{
      id: :stolen,
      action: "stolen",
      label: "Steal cap from red-team tab",
      story_label: "Deny stolen cap",
      pending_detail: "Awaiting a stolen-cap denial.",
      narration:
        "The cap object is not enough by itself. The gateway rejects use from the wrong tab realm, which blocks a confused-deputy path.",
      expected_result: %{ok: false, error: ":wrong_owner", delivered_to_wallet?: false}
    },
    %{
      id: :revoke,
      action: "revoke",
      label: "Revoke cap",
      pending_detail: "Awaiting wallet revocation.",
      narration:
        "Wallet consent has been withdrawn. The graph keeps the revoked edge visible for audit, but it can no longer carry authority."
    },
    %{
      id: :replay,
      action: "replay",
      label: "Replay revoked cap",
      story_label: "Deny replay",
      pending_detail: "Awaiting replay denial after revocation.",
      narration:
        "Replay after revocation is denied before delivery. The wallet ledger stays at one successful purchase.",
      expected_result: %{ok: false, error: ":revoked", delivered_to_wallet?: false}
    }
  ]

  @steps_by_id Map.new(@steps, &{&1.id, &1})
  @step_order Enum.map(@steps, & &1.id)

  @actions [
    %{id: :run_all, action: "run_all", label: "Run full story", primary: true},
    %{id: :reset, action: "reset", label: "Reset"}
    | Enum.map(@steps, fn step ->
        %{id: step.id, action: step.action, label: step.label, step: step.id}
      end)
  ]

  @action_ids Enum.map(@actions, & &1.id)
  @actions_by_name Map.new(@actions, &{&1.action, &1.id})
  @invocation_order [:allowed, :over_budget, :wrong_vendor, :stolen, :replay]

  @invocations %{
    allowed: %{
      actor: :agent_tab,
      expectation: :delivered,
      label: "Planner invokes the cap within all caveats.",
      payload: %{
        amount: 199,
        vendor: @vendor,
        item: "Systems Programming Book",
        confirmed?: true,
        provenance_label: @provenance_label
      }
    },
    over_budget: %{
      actor: :agent_tab,
      expectation: :denied,
      label: "Planner tries to exceed the $300 amount caveat.",
      payload: %{
        amount: 425,
        vendor: @vendor,
        item: "Conference travel add-on",
        confirmed?: true,
        provenance_label: @provenance_label
      }
    },
    wrong_vendor: %{
      actor: :agent_tab,
      expectation: :denied,
      label: "Planner tries the right amount at the wrong vendor.",
      payload: %{
        amount: 120,
        vendor: "gadget-mart",
        item: "Noise-cancelling headphones",
        confirmed?: true,
        provenance_label: @provenance_label
      }
    },
    stolen: %{
      actor: :attacker_tab,
      expectation: :denied,
      label: "Red-team tab reuses the planner cap and fails owner checking.",
      payload: %{
        amount: 50,
        vendor: @vendor,
        item: "Stolen cap attempt",
        confirmed?: true,
        provenance_label: @provenance_label
      }
    },
    replay: %{
      actor: :agent_tab,
      expectation: :denied,
      label: "Planner replays the revoked cap and fails before delivery.",
      payload: %{
        amount: 40,
        vendor: @vendor,
        item: "Replay after revoke",
        confirmed?: true,
        provenance_label: @provenance_label
      }
    }
  }

  def limit, do: @limit
  def vendor, do: @vendor
  def provenance_label, do: @provenance_label
  def cap_ttl_ms, do: @cap_ttl_ms
  def steps, do: @steps
  def step_order, do: @step_order
  def actions, do: Enum.map(@actions, &Map.drop(&1, [:id]))
  def action_ids, do: @action_ids
  def invocation_order, do: @invocation_order

  def action_id(action_name) when is_binary(action_name) do
    case Map.fetch(@actions_by_name, action_name) do
      {:ok, action} -> {:ok, action}
      :error -> {:error, :unknown_action}
    end
  end

  def action?(action), do: action in @action_ids
  def step_definition(step), do: Map.fetch!(@steps_by_id, step)
  def pending_detail(step), do: step_definition(step).pending_detail
  def expected_result(step), do: Map.get(step_definition(step), :expected_result)

  def step_label(step) do
    step
    |> step_definition()
    |> Map.get(:story_label)
    |> case do
      nil -> step_definition(step).label
      label -> label
    end
  end

  def invocation(kind, state) do
    spec = Map.fetch!(@invocations, kind)

    {
      tab_id(spec.actor, state),
      spec.payload,
      spec.expectation,
      spec.label
    }
  end

  def grant_opts(wallet_tab_id) do
    [
      issuer: {:wallet_tab, wallet_tab_id},
      amount_max: @limit,
      vendor: @vendor,
      requires_confirmation: true,
      provenance_label: @provenance_label,
      ttl: @cap_ttl_ms,
      audit: %{consented_by: wallet_tab_id, demo: "flagship"}
    ]
  end

  def policy do
    %{
      limit: @limit,
      vendor: @vendor,
      required_confirmation: true,
      provenance_label: @provenance_label
    }
  end

  defp tab_id(field, state), do: Map.fetch!(state, field).id
end
