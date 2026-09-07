defmodule Treehouse.MemberContinuityReciprocalTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Log, Op, Sync}
  alias Lattice.Carrier.Wire
  alias Treehouse.MemberContinuityCertificate, as: Certificate
  alias Treehouse.MemberContinuityVectors, as: Vectors

  @vectors Path.expand(
             "../../../../clients/lattice-client/test/vectors/member_continuity",
             __DIR__
           )

  test "independently signed TS and BEAM artifacts verify every exact purpose in BEAM" do
    for file <- ["ts_codec.json", "beam_codec.json"] do
      v = fixture(file)
      assert {:ok, claim} = Certificate.claim_from_wire(v["claim_term"])
      assert {:ok, certificate} = Certificate.certificate_from_wire(v["certificate_term"])
      assert {:ok, challenge} = Certificate.return_challenge_from_wire(v["return_challenge_term"])
      signature = Base.decode64!(v["return_signature"])
      assert :ok = Certificate.verify_certificate(certificate, claim)
      assert :ok = Certificate.verify_return(challenge, signature, challenge)
      assert Certificate.claim_id(claim) == v["claim_id"]
      assert Base.encode64(Certificate.claim_bytes(claim)) == v["claim_bytes"]
      assert Base.encode64(Certificate.possession_bytes(claim)) == v["possession_bytes"]

      assert Base.encode64(Certificate.vouch_bytes(claim, certificate.possession)) ==
               v["vouch_bytes"]

      assert Base.encode64(Certificate.return_bytes(challenge)) == v["return_bytes"]

      assert {:error, :invalid_member_continuity} =
               Certificate.verify_certificate(
                 %{certificate | possession: hd(certificate.vouches).signature},
                 claim
               )

      assert {:error, :invalid_member_continuity} =
               Certificate.verify_return(challenge, certificate.possession, challenge)

      assert {:error, :invalid_member_continuity} =
               Certificate.verify_certificate(certificate, %{claim | epoch: claim.epoch + 1})
    end

    assert fixture("beam_codec.json")["claim_id"] != fixture("ts_codec.json")["claim_id"]
  end

  test "both real signed command histories stay retained and unknown in either delivery order" do
    for file <- ["ts_codec.json", "beam_codec.json"] do
      vector = fixture(file)["unknown_command"]
      assert {:ok, ops} = Wire.decode_ops(vector["frames"])
      assert Enum.all?(ops, &Op.valid?/1)
      genesis = Enum.find(ops, &(&1.kind == :authority))
      {:ok, baseline} = Log.accept(Log.new(vector["replica"]), genesis)

      for delivered <- [ops, Enum.reverse(ops)] do
        {log, %{pending: []}} = Sync.deliver(Log.new(vector["replica"]), delivered)
        assert :ok = Log.verify_authenticity(log)
        assert {:error, :unsupported_cutoff} = Treehouse.CatalogCutoff.derive(log)
        analysis = Authority.analyze(Treehouse.Space, log)
        assert analysis.reasons[vector["op_id"]] == :unknown_command
        assert Lattice.state(Treehouse.Space, log) == Lattice.state(Treehouse.Space, baseline)
        assert map_size(Log.ops(log)) == length(ops)
      end
    end
  end

  test "BEAM fixture regenerates exactly from its own synthetic signers" do
    assert Vectors.codec_vector() |> Jason.encode!() |> Jason.decode!() ==
             fixture("beam_codec.json")

    path = Path.join(System.tmp_dir!(), "r19b-codec-#{System.unique_integer([:positive])}.json")
    on_exit(fn -> File.rm(path) end)
    assert :ok = Vectors.export!(path)
    assert File.read!(path) == File.read!(Path.join(@vectors, "beam_codec.json"))
  end

  test "cold VM explicitly loads codec vocabulary without registering the signed command" do
    script = """
    false = :code.is_loaded(Treehouse.MemberContinuityCertificate)
    Code.ensure_loaded!(Treehouse.MemberContinuityCertificate)
    true = Atom.to_string(String.to_existing_atom("attest_member_key_v1")) == "attest_member_key_v1"
    Code.ensure_loaded!(Treehouse.Space)
    Code.ensure_loaded!(Lattice.Authority)
    Code.ensure_loaded!(Lattice.Authority.Delegation)
    for path <- System.argv() do
      vector = path |> File.read!() |> Jason.decode!() |> Map.fetch!("unknown_command")
      {:ok, ops} = Lattice.Carrier.Wire.decode_ops(vector["frames"])
      true = Enum.all?(ops, &Lattice.Op.valid?/1)
      {log, %{pending: []}} = Lattice.Sync.deliver(Lattice.Log.new(vector["replica"]), Enum.reverse(ops))
      :ok = Lattice.Log.verify_authenticity(log)
      :unknown_command = Map.fetch!(Lattice.Authority.analyze(Treehouse.Space, log).reasons, vector["op_id"])
    end
    IO.puts("MEMBER_CONTINUITY_CODEC_COLD_VM_UNKNOWN_OK")
    """

    elixir = System.find_executable("elixir") || raise "Elixir executable unavailable"

    {output, status} =
      System.cmd(
        elixir,
        [
          "-pa",
          Application.app_dir(:lattice_core, "ebin"),
          "-pa",
          Application.app_dir(:jason, "ebin"),
          "-e",
          script,
          Path.join(@vectors, "beam_codec.json"),
          Path.join(@vectors, "ts_codec.json")
        ],
        env: [{"ERL_FLAGS", "+S 4:4"}],
        stderr_to_stdout: true
      )

    assert status == 0, output
    assert output =~ "MEMBER_CONTINUITY_CODEC_COLD_VM_UNKNOWN_OK", output
  end

  defp fixture(name), do: @vectors |> Path.join(name) |> File.read!() |> Jason.decode!()
end
