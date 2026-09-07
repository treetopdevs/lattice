defmodule Treehouse.NativePreviewOracle do
  @moduledoc "Independent verification of the offline preview's public retained frames."
  alias Lattice.{Authority, Log, Op, Sync}
  alias Lattice.Carrier.Wire

  @spec verify!(map()) :: :ok
  def verify!(artifact) do
    %{
      "version" => 1,
      "product" => "treehouse",
      "readiness" => "recovery_not_ready",
      "profiles" => profiles
    } = artifact

    public_key = Base.decode64!(artifact["publicKey"])
    true = byte_size(public_key) == 32

    for profile <- profiles do
      module =
        case profile["product"] do
          "Treehouse.Space" -> Treehouse.Space
          "Treehouse.Thread" -> Treehouse.Thread
        end

      Code.ensure_loaded!(module)

      ops =
        Enum.map(profile["frames"], fn frame ->
          {:ok, op} = Wire.decode_op(frame)
          true = Op.valid?(op)
          true = op.replica == profile["replica"]
          op
        end)

      true = length(Enum.uniq_by(ops, & &1.id)) == length(ops)
      {log, report} = Sync.deliver(Log.new(profile["replica"]), Enum.reverse(ops))
      [] = report.pending
      true = map_size(Log.ops(log)) == length(ops)
      analysis = Authority.analyze(module, log)

      true =
        Enum.any?(ops, fn op ->
          op.author == public_key and op.deps == [] and match?({:genesis, _, _}, op.body) and
            not MapSet.member?(analysis.quarantine, op.id)
        end)

      observed = observe(module, log)

      unless observed == profile["expect"],
        do:
          raise(
            "preview parity mismatch: #{inspect(%{observed: observed, expected: profile["expect"]}, limit: :infinity)}"
          )

      path =
        Path.join(
          System.tmp_dir!(),
          "treehouse-preview-#{System.unique_integer([:positive])}.log"
        )

      try do
        :ok = Log.dump(log, path)
        {:ok, restored} = Log.restore(path)
        true = Log.ops(restored) == Log.ops(log)
        true = observe(module, restored) == observed
      after
        File.rm(path)
      end
    end

    :ok
  end

  defp observe(module, log) do
    view = Treehouse.ReadModel.observe(module, log)
    state = Map.new(view.state, fn {field, value} -> {Atom.to_string(field), value} end)
    roles = for {_, %{kind: :authority, role: role}} <- module.__lattice_fields__(), do: role

    state =
      Enum.reduce(Enum.uniq(roles), state, fn role, acc ->
        holder = Authority.holder(module, log, role)
        Map.put(acc, Atom.to_string(role), if(holder, do: Base.encode64(holder)))
      end)

    %{
      "state" => state,
      "posts" =>
        Enum.map(view.posts, fn post ->
          %{"id" => post.id, "author" => Base.encode64(post.author), "text" => post.text}
        end),
      "order" => view.order,
      "quarantine" =>
        Enum.sort(Enum.map(view.quarantine, fn {id, reason} -> [id, Atom.to_string(reason)] end)),
      "operationCount" => view.operation_count
    }
  end
end

if path = System.get_env("TREEHOUSE_PREVIEW_ARTIFACT") do
  :ok = path |> File.read!() |> Jason.decode!() |> Treehouse.NativePreviewOracle.verify!()
  IO.puts("TREEHOUSE_NATIVE_PREVIEW_ORACLE_OK")
end
