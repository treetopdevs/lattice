Code.require_file("support/native_peer_output.exs", __DIR__)

alias Lattice.Identity

case System.argv() do
  ["produce"] ->
    key = Identity.generate("strict-signature-test")
    message = "fresh BEAM strict-signature producer"
    signature = Identity.sign(key, message)

    encode = fn name, pub, msg, sig, expected ->
      %{
        name: name,
        key: Base.encode64(pub),
        message: Base.encode64(msg),
        signature: Base.encode64(sig),
        expected: expected
      }
    end

    identity = <<1, 0::248>>
    identity_signature = <<identity::binary, 0::256>>

    cases = [
      encode.("beam-valid", key.pub, message, signature, true),
      encode.("beam-wrong-message", key.pub, "wrong", signature, false),
      encode.("beam-weak-key", identity, message, identity_signature, false),
      encode.("beam-zero-key", <<0::256>>, message, identity_signature, false),
      encode.("beam-short-key", <<1>>, message, signature, false),
      encode.("beam-short-signature", key.pub, message, <<0>>, false)
    ]

    Lattice.NativePeerOutput.puts(Jason.encode!(%{cases: cases}))

  ["consume"] ->
    input = IO.read(:stdio, :eof) |> Jason.decode!()

    decisions =
      Enum.map(input["cases"], fn value ->
        Identity.verify(
          Base.decode64!(value["key"]),
          Base.decode64!(value["message"]),
          Base.decode64!(value["signature"])
        )
      end)

    Lattice.NativePeerOutput.puts(Jason.encode!(%{decisions: decisions}))
end
