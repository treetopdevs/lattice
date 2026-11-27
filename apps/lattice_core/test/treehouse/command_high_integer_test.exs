defmodule Treehouse.CommandHighIntegerTest do
  # Row 336: BEAM's reasons for wire uint64s above 2^53 - 1 in Space and Thread command
  # arguments, which the TypeScript judge must reproduce from the same committed frames.
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Wire
  alias Lattice.Log
  alias Treehouse.{CommandHighIntegerVectors, MemberContinuity, Space, Thread}

  @vector Path.expand(
            "../../../../clients/lattice-client/test/vectors/treehouse_command/high_integer_v1.json",
            __DIR__
          )

  # Today's BEAM reason for every high case; each matches the reason of its safe-integer control
  # except the claim epoch, whose safe control reaches the epoch-basis check.
  @high_reasons %{
    "create_space-high" => "malformed_command",
    "create_space-max-high" => "malformed_command",
    "create_thread-replica-high" => "malformed_command",
    "create_thread-title-high" => "malformed_command",
    "issue_invitation-recipient-high" => "malformed_command",
    "issue_invitation-thread-high" => "malformed_command",
    "revoke_invitation-high" => "malformed_command",
    "admit_member-invitation-high" => "malformed_command",
    "remove_member-high" => "malformed_command",
    "catalog_bootstrap_v1-high" => "application_invalid_catalog",
    "space-post-unknown-high" => "unknown_command",
    "create_space-arity-high" => "bad_command_arity",
    "attest-claim-epoch-high" => "application_invalid_continuity",
    "attest-claim-version-high" => "application_invalid_continuity",
    "attest-possession-high" => "application_invalid_continuity",
    "attest-vouch-high" => "application_invalid_continuity",
    "attest-vouch-signature-high" => "application_invalid_continuity",
    "replace_catalog_v1-high" => "operation_not_granted",
    "thread-post-high" => "malformed_command",
    "thread-post-max-high" => "malformed_command",
    "thread-create_thread-high" => "malformed_command",
    "thread-author_edit-high" => "malformed_command",
    "thread-author_tombstone-high" => "malformed_command",
    "thread-moderator_tombstone-high" => "malformed_command",
    "thread-archive_thread-high" => "bad_command_arity"
  }

  setup_all do
    {:ok, vector: @vector |> File.read!() |> Jason.decode!()}
  end

  test "committed high_integer_v1.json equals regeneration" do
    assert File.read!(@vector) ==
             CommandHighIntegerVectors.encode(CommandHighIntegerVectors.vector())
  end

  test "every committed case frame decodes and judges to its recorded reason", %{vector: v} do
    bases = %{
      "Treehouse.Space" => {Space, base_log(v["space"])},
      "Treehouse.Thread" => {Thread, base_log(v["thread"])}
    }

    for c <- v["cases"] do
      {module, log} = Map.fetch!(bases, c["product"])
      assert {:ok, op} = Wire.decode_op(c["frame"]), c["name"]
      reason = CommandHighIntegerVectors.reason(module, log, op)
      assert (reason && to_string(reason)) == c["reason"], c["name"]
    end
  end

  test "high cases pin today's BEAM reasons and carry a canonical high integer", %{vector: v} do
    high =
      for c <- v["cases"], String.ends_with?(c["name"], "-high"), into: %{}, do: {c["name"], c}

    assert Map.new(high, fn {name, c} -> {name, c["reason"]} end) == @high_reasons

    for {name, c} <- high do
      assert high_integer?(c["frame"]["body"]), name
      refute high_integer?(Enum.find(v["cases"], &(&1["name"] == safe(name)))["frame"]["body"])
    end
  end

  test "a whole Space history with one high case decodes and observes, quarantining that op",
       %{vector: v} do
    for c <- v["cases"], c["product"] == "Treehouse.Space" do
      assert {:ok, ops} = Wire.decode_ops(v["space"]["frames"] ++ [c["frame"]]), c["name"]
      log = Enum.reduce(ops, Log.new(v["space"]["replica"]), &Log.append!(&2, &1))
      assert {:ok, %{quarantine: quarantine}} = MemberContinuity.observe(log), c["name"]
      found = Enum.find(quarantine, &(&1.op_id == c["frame"]["id"]))
      assert (found && to_string(found.reason)) == c["reason"], c["name"]
    end
  end

  test "numeric and non-canonical integer forms refuse the frame and its batch", %{vector: v} do
    assert {:ok, _} = Wire.decode_op(v["good"])
    assert length(v["wireCases"]) == 5

    for c <- v["wireCases"] do
      assert c["decode"] == "malformed_op"
      assert {:error, :malformed_op} = Wire.decode_op(c["frame"]), c["name"]
      assert {:error, :malformed_op} = Wire.decode_ops([v["good"], c["frame"]]), c["name"]
    end
  end

  defp base_log(%{"replica" => replica, "frames" => frames}) do
    {:ok, ops} = Wire.decode_ops(frames)
    Enum.reduce(ops, Log.new(replica), &Log.append!(&2, &1))
  end

  defp safe(name), do: String.replace_suffix(name, "-high", "-safe")

  defp high_integer?(["int", text]) when is_binary(text), do: true
  defp high_integer?(terms) when is_list(terms), do: Enum.any?(terms, &high_integer?/1)
  defp high_integer?(_), do: false
end
