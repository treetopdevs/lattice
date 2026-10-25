defmodule Lattice.StrictSignatureReciprocalTest do
  use ExUnit.Case, async: false
  alias Lattice.Identity
  @root Path.expand("../../../..", __DIR__)
  @client Path.join(@root, "clients/lattice-client")

  test "fresh Noble witnesses and BEAM-produced consent use the strict signature profile" do
    IO.puts("strict Ed25519 backend: #{inspect(:crypto.info_lib())}")

    {output, 0} =
      System.cmd("node", ["--import", "tsx", "test/support/strict_signature_peer.ts", "produce"],
        cd: @client,
        stderr_to_stdout: true
      )

    cases = Jason.decode!(output)["cases"]

    for entry <- Jason.decode!(output)["frames"] do
      {:ok, op} = Lattice.Carrier.Wire.decode_op(entry["frame"])
      assert Lattice.Op.valid?(op) == entry["expected"]
    end

    assert length(cases) >= 65
    assert Enum.count(cases, & &1["expected"]) >= 2

    for value <- cases do
      actual =
        Identity.verify(
          Base.decode64!(value["key"]),
          Base.decode64!(value["message"]),
          Base.decode64!(value["signature"])
        )

      assert actual == value["expected"], value["name"]
    end

    key = Identity.generate("strict-signature-test")
    message = "independent BEAM reciprocal signature"
    identity = <<1, 0::248>>

    values =
      for {pub, msg, sig, expected} <- [
            {key.pub, message, Identity.sign(key, message), true},
            {key.pub, "wrong", Identity.sign(key, message), false},
            {identity, message, <<identity::binary, 0::256>>, false}
          ] do
        %{
          key: Base.encode64(pub),
          message: Base.encode64(msg),
          signature: Base.encode64(sig),
          expected: expected
        }
      end

    path =
      Path.join(System.tmp_dir!(), "strict-signature-#{System.unique_integer([:positive])}.json")

    File.write!(path, Jason.encode!(%{cases: values}))

    try do
      {output, 0} =
        System.cmd(
          "node",
          ["--import", "tsx", "test/support/strict_signature_peer.ts", "consume", path],
          cd: @client,
          stderr_to_stdout: true
        )

      assert Jason.decode!(output)["decisions"] == Enum.map(values, & &1.expected)
    after
      File.rm!(path)
    end
  end

  test "fresh ordinary invitations in both producer directions refuse weak consent" do
    {output, 0} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/strict_signature_application_peer.ts", "produce"],
        cd: @client,
        stderr_to_stdout: true
      )

    ts_histories = Jason.decode!(output)["histories"]
    root = Identity.generate("strict-application-root")
    member = Identity.generate("strict-application-member")
    nonce = :crypto.hash(:sha256, "strict-application-space") |> Base.url_encode64(padding: false)

    {:ok, creation} =
      Treehouse.Space.prepare_creation(
        root,
        "replica:treehouse:space:" <> nonce,
        "BEAM strict Space"
      )

    [genesis, name] = creation.pending
    {:genesis, delegation, _} = genesis.body
    identity = <<1, 0::248>>

    histories =
      for valid <- [true, false] do
        recipient = Base.encode64(if(valid, do: member.pub, else: identity))

        {:ok, invitation} =
          Lattice.Op.authored(
            root,
            creation.replica,
            [name.id],
            :command,
            {:issue_invitation, [recipient, []]},
            cap: delegation.id
          )

        acceptance =
          if valid,
            do: Treehouse.Invitation.accept(member, creation.replica, invitation),
            else: Base.encode64(<<identity::binary, 0::256>>)

        {:ok, admission} =
          Lattice.Op.authored(
            root,
            creation.replica,
            [invitation.id],
            :command,
            {:admit_member, [invitation.id, recipient, "member", acceptance]},
            cap: delegation.id
          )

        %{
          name: "beam-#{valid}",
          replica: creation.replica,
          frames:
            Enum.map([genesis, name, invitation, admission], &Lattice.Carrier.Wire.encode_op/1),
          admission: admission.id,
          expected: valid
        }
        |> Jason.encode!()
        |> Jason.decode!()
      end

    all = ts_histories ++ histories

    results =
      for history <- all do
        {:ok, ops} = Lattice.Carrier.Wire.decode_ops(history["frames"])
        assert Enum.all?(ops, &Lattice.Op.valid?/1)
        log = Lattice.Log.from_ops(history["replica"], Map.new(ops, &{&1.id, &1}))
        view = Treehouse.ReadModel.observe(Treehouse.Space, log)
        expected = if history["expected"], do: nil, else: :application_invalid_invitation
        assert view.quarantine[history["admission"]] == expected
        assert length(view.state.members) == if(history["expected"], do: 1, else: 0)

        reversed =
          Lattice.Log.from_ops(history["replica"], Map.new(Enum.reverse(ops), &{&1.id, &1}))

        assert Treehouse.ReadModel.observe(Treehouse.Space, reversed) == view

        %{
          state: view.state,
          reasons:
            Map.new(Enum.filter(ops, &(&1.kind == :command)), &{&1.id, view.quarantine[&1.id]})
        }
      end

    path = Path.join(System.tmp_dir!(), "strict-app-#{System.unique_integer([:positive])}.json")
    File.write!(path, Jason.encode!(%{histories: all}))

    try do
      {output, 0} =
        System.cmd(
          "node",
          [
            "--import",
            "tsx",
            "test/support/strict_signature_application_peer.ts",
            "consume",
            path
          ],
          cd: @client,
          stderr_to_stdout: true
        )

      assert Jason.decode!(output)["results"] == Jason.decode!(Jason.encode!(results))
    after
      File.rm!(path)
    end
  end
end
