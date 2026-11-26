defmodule Treehouse.CommandHighIntegerVectors do
  @moduledoc """
  Row 336: wire uint64s above 2^53 - 1 in Treehouse Space and Thread command arguments.

  Every case is a genuinely signed `Wire.encode_op` frame judged alone on its product's base
  history; its reason is BEAM's Authority verdict. Each high case has a safe-integer control
  in the same argument position. `wireCases` are hand-mutated numeric or non-canonical integer
  forms that both runtimes refuse structurally. Disposable seeded keys only.
  """

  alias Lattice.{Authority, Identity, Log, Op, Sim}
  alias Lattice.Carrier.Wire
  alias Treehouse.MemberContinuityCertificate, as: Certificate
  alias Treehouse.{MemberContinuitySemanticFixture, Space, Thread}

  @path "treehouse_command/high_integer_v1.json"
  @high 9_007_199_254_740_992
  @max 18_446_744_073_709_551_615

  @doc "The Space and Thread base histories (topological ops) and their signing context."
  @spec bases() :: %{space: map(), thread: map()}
  def bases, do: %{space: space_base(), thread: thread_base()}

  defp space_base do
    {sim, claim} = MemberContinuitySemanticFixture.founded()
    log = Sim.log(sim, "root")
    root = Sim.identity(sim, "root")

    %{
      module: Space,
      product: "Treehouse.Space",
      sim: sim,
      claim: claim,
      log: log,
      identity: root,
      cap: root_cap(log, root),
      recipient: Base.encode64(Sim.identity(sim, "nominee").pub)
    }
  end

  defp thread_base do
    {sim, _} =
      Sim.new(Thread, "replica:treehouse:thread:r336-high-integer", ["root"],
        seed: "r336-high-integer-thread"
      )
      |> Sim.create_replica("root")

    {sim, _} = Sim.command(sim, "root", :create_thread, ["Row 336"])
    {sim, post} = Sim.command(sim, "root", :post, ["hello"])
    log = Sim.log(sim, "root")
    root = Sim.identity(sim, "root")

    %{
      module: Thread,
      product: "Treehouse.Thread",
      log: log,
      identity: root,
      cap: root_cap(log, root),
      post: post.id
    }
  end

  # The capability the Sim chose for the root's own honored commands.
  defp root_cap(log, root) do
    log
    |> Log.topo_ops()
    |> Enum.filter(&(&1.kind == :command and &1.author == root.pub))
    |> List.last()
    |> Map.fetch!(:cap)
  end

  @doc "Every `{name, base_key, op}` case, high integers first in each pair, then its control."
  @spec cases(%{space: map(), thread: map()}) :: [{String.t(), :space | :thread, Op.t()}]
  def cases(%{space: s, thread: t}) do
    space =
      pairs(s, [
        {"create_space", :create_space, &[&1]},
        {"create_space-max", :create_space, fn n -> [if(n == @high, do: @max, else: n)] end},
        {"create_thread-replica", :create_thread, &[&1, "t"]},
        {"create_thread-title", :create_thread, &["r", &1]},
        {"issue_invitation-recipient", :issue_invitation, &[&1, []]},
        {"issue_invitation-thread", :issue_invitation, &[s.recipient, [&1]]},
        {"revoke_invitation", :revoke_invitation, &[&1]},
        {"admit_member-invitation", :admit_member, &[&1, s.recipient, "member", "sig"]},
        {"remove_member", :remove_member, &[&1]},
        {"catalog_bootstrap_v1", :catalog_bootstrap_v1, &[&1]},
        {"space-post-unknown", :post, &[&1]},
        {"create_space-arity", :create_space, &[&1, &1]}
      ]) ++
        attest_cases(s) ++
        pairs(s, [{"replace_catalog_v1", :replace_catalog_v1, &[&1, &1, &1]}])

    thread =
      pairs(t, [
        {"thread-post", :post, &[&1]},
        {"thread-post-max", :post, fn n -> [if(n == @high, do: @max, else: n)] end},
        {"thread-create_thread", :create_thread, &[&1]},
        {"thread-author_edit", :author_edit, &[&1, t.post, "x"]},
        {"thread-author_tombstone", :author_tombstone, &[&1, t.post]},
        {"thread-moderator_tombstone", :moderator_tombstone, &[&1, t.post]},
        {"thread-archive_thread", :archive_thread, &[&1]}
      ])

    Enum.map(space, &Tuple.insert_at(&1, 1, :space)) ++
      Enum.map(thread, &Tuple.insert_at(&1, 1, :thread))
  end

  defp pairs(base, specs) do
    Enum.flat_map(specs, fn {name, command, args} ->
      [
        {"#{name}-high", command_op(base, command, args.(@high))},
        {"#{name}-safe", command_op(base, command, args.(1))}
      ]
    end)
  end

  defp command_op(base, command, args, deps \\ nil) do
    deps = deps || Enum.sort(Log.frontier(base.log))
    Op.new(base.identity, base.log.replica, deps, :command, {command, args}, cap: base.cap)
  end

  # attest_member_key_v1 signed by the Space root over the claim's deps. Possession and vouches
  # stay those of the genuine claim; normalization refuses the high value before any signature.
  defp attest_cases(s) do
    claim = s.claim
    sim = s.sim
    possession = Identity.sign(Sim.identity(sim, "new"), Certificate.possession_bytes(claim))

    vouches =
      ["a", "b"]
      |> Enum.map(fn name ->
        member = Sim.identity(sim, name)

        %{
          member: member.pub,
          signature: Identity.sign(member, Certificate.vouch_bytes(claim, possession))
        }
      end)
      |> Enum.sort_by(& &1.member)

    [first | rest] = vouches
    attest = &command_op(s, :attest_member_key_v1, &1, claim.deps)

    [
      {"attest-genuine-control", attest.([claim, possession, vouches])},
      {"attest-claim-epoch-high", attest.([%{claim | epoch: @high}, possession, vouches])},
      {"attest-claim-epoch-safe", attest.([%{claim | epoch: 1}, possession, vouches])},
      {"attest-claim-version-high", attest.([%{claim | version: @high}, possession, vouches])},
      {"attest-claim-version-safe", attest.([%{claim | version: 2}, possession, vouches])},
      {"attest-possession-high", attest.([claim, @high, vouches])},
      {"attest-possession-safe", attest.([claim, 1, vouches])},
      {"attest-vouch-high", attest.([claim, possession, [@high | rest]])},
      {"attest-vouch-safe", attest.([claim, possession, [1 | rest]])},
      {"attest-vouch-signature-high",
       attest.([claim, possession, [%{first | signature: @high} | rest]])},
      {"attest-vouch-signature-safe",
       attest.([claim, possession, [%{first | signature: 1} | rest]])}
    ]
  end

  @doc "BEAM's Authority reason for `op` judged alone after `log`, or nil when honored."
  @spec reason(module(), Log.t(), Op.t()) :: atom() | nil
  def reason(module, log, op), do: Authority.analyze(module, Log.append!(log, op)).reasons[op.id]

  @spec vector() :: map()
  def vector do
    b = bases()

    cases =
      for {name, key, op} <- cases(b) do
        base = Map.fetch!(b, key)

        %{
          "name" => name,
          "product" => base.product,
          "frame" => Wire.encode_op(op),
          "reason" => stringify(reason(base.module, base.log, op))
        }
      end

    good = command_op(b.space, :create_space, ["wire"])
    good_frame = Wire.encode_op(good)

    wire_cases =
      for {name, term} <- [
            {"json-number-2^53", ["int", @high]},
            {"json-number-2^53+1", ["int", @high + 1]},
            {"json-number-u64-max", ["int", @max]},
            {"text-leading-zero", ["int", "0" <> Integer.to_string(@high)]},
            {"text-above-u64", ["int", Integer.to_string(@max + 1)]}
          ] do
        %{
          "name" => name,
          "frame" => put_in(good_frame, ["body", Access.at(1), Access.at(1)], ["list", [term]]),
          "decode" => "malformed_op"
        }
      end

    %{
      "version" => 1,
      "space" => %{
        "replica" => b.space.log.replica,
        "frames" => Enum.map(Log.topo_ops(b.space.log), &Wire.encode_op/1)
      },
      "thread" => %{
        "replica" => b.thread.log.replica,
        "frames" => Enum.map(Log.topo_ops(b.thread.log), &Wire.encode_op/1)
      },
      "cases" => cases,
      "good" => good_frame,
      "wireCases" => wire_cases
    }
  end

  defp stringify(nil), do: nil
  defp stringify(reason), do: to_string(reason)

  @spec write(String.t()) :: :ok
  def write(directory) do
    path = Path.join(directory, @path)
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, encode(vector()))
  end

  @spec encode(map()) :: binary()
  def encode(vector), do: Jason.encode!(vector, pretty: true) <> "\n"
end
