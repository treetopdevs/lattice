# Actual public BEAM owner for fresh full-resolver requests. Frame transport is
# passed through untouched; only the public API's metadata names are translated.
Code.require_file("support/native_peer_output.exs", __DIR__)

defmodule NativeCatalogResolverPeer do
  @names ~w(installed expected incoming version review histories catalogs rotations cutoff_proofs accepted blocked product space space_root bootstrap_id observed_bootstrap_ids disposition trust_revision history_generation replica frames rejected frame reason id json cutoff history frontier log_digest binding generation catalog revision bindings bootstrap_ids op_ids pending_proof_ids triggers authority_witnesses kind digest bytes)a
  @keys Map.new(@names, fn name ->
          camel =
            name
            |> Atom.to_string()
            |> then(&Regex.replace(~r/_([a-z])/, &1, fn _, c -> String.upcase(c) end))

          {camel, name}
        end)
  @enums Map.new(
           [
             :treehouse,
             :pin_exact_observed_bootstrap,
             :catalog_fork,
             :authority_changed,
             :control_history_limit,
             :bad_signature,
             :catalog,
             :rotation
           ],
           &{Atom.to_string(&1), &1}
         )

  def input(value) when is_map(value) do
    Map.new(value, fn {key, item} ->
      key = Map.get(@keys, key, key)

      converted =
        cond do
          key in [:frames, :frame] ->
            item

          key == :space_root and is_binary(item) ->
            case Base.decode64(item) do
              {:ok, bytes} -> bytes
              :error -> item
            end

          key in [:product, :disposition, :reason, :kind] ->
            Map.get(@enums, item, item)

          true ->
            input(item)
        end

      {key, converted}
    end)
  end

  def input(value) when is_list(value), do: Enum.map(value, &input/1)
  def input(value), do: value

  def output(value) when is_map(value) do
    Map.new(value, fn {key, item} ->
      name =
        if is_atom(key),
          do:
            key
            |> Atom.to_string()
            |> then(&Regex.replace(~r/_([a-z])/, &1, fn _, c -> String.upcase(c) end)),
          else: key

      item =
        if key in [:space_root, :root, :service_key] and is_binary(item),
          do: Base.encode64(item),
          else: output(item)

      {name, item}
    end)
  end

  def output(value) when is_list(value), do: Enum.map(value, &output/1)
  def output(value) when value in [nil, true, false], do: value
  def output(value) when is_atom(value), do: Atom.to_string(value)
  def output(value), do: value
end

input = IO.read(:stdio, :eof) |> Jason.decode!()

results =
  Enum.map(input["cases"], fn item ->
    %{
      name: item["name"],
      decision:
        item["input"]
        |> NativeCatalogResolverPeer.input()
        |> Treehouse.CatalogTrust.evaluate()
        |> NativeCatalogResolverPeer.output()
    }
  end)

Lattice.NativePeerOutput.puts(Jason.encode!(%{results: results}))
