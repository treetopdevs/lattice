defmodule TownshipWeb.VerifiedInstrumentSnapshot do
  @moduledoc """
  A coherent set of Township instrument projections from one verified log.

  Construction verifies the complete audit bundle before restoring its log,
  derives every rendered fact from that log, and checks that the terminal replay
  agrees with the read model. Callers cannot construct a partially verified
  instrument through this module.
  """

  alias Lattice.{Attestation, Identity, Log}
  alias Township.{AuditBundle, ReadModel}

  @enforce_keys [:read_model, :causal_replay, :provenance, :op_counts]
  defstruct @enforce_keys

  @type provenance :: %{
          required(:bundle_dir) => String.t(),
          required(:matter_sha256) => String.t(),
          required(:schema) => String.t(),
          required(:verified) => true
        }
  @type op_counts :: %{
          required(:total) => non_neg_integer(),
          required(:honored) => non_neg_integer(),
          required(:quarantined) => non_neg_integer()
        }
  @type t :: %__MODULE__{
          read_model: ReadModel.t(),
          causal_replay: map(),
          provenance: provenance(),
          op_counts: op_counts()
        }

  @doc "Verify a bundle and build its coherent instrument snapshot."
  @spec load_bundle(term()) :: {:ok, t()} | {:error, [String.t()]}
  def load_bundle(bundle_dir) do
    case AuditBundle.verify_snapshot(bundle_dir) do
      {:ok, verified} -> load_verified(verified)
      {:error, errors} -> {:error, errors}
    end
  rescue
    error -> {:error, [Exception.message(error)]}
  end

  defp load_verified(%{
         bundle_dir: bundle_dir,
         labels: labels,
         log: log,
         matter_bytes: matter_bytes,
         schema: schema
       }) do
    read_model = ReadModel.observe(log, labels: labels, vouches: demo_vouches())
    causal_replay = ReadModel.replay(log)

    case ensure_coherent(log, read_model, causal_replay) do
      :ok ->
        {:ok,
         %__MODULE__{
           read_model: read_model,
           causal_replay: causal_replay,
           op_counts: op_counts(read_model.op_dag.nodes),
           provenance: %{
             bundle_dir: bundle_dir,
             matter_sha256: sha256(matter_bytes),
             schema: schema,
             verified: true
           }
         }}

      {:error, errors} when is_list(errors) ->
        {:error, errors}

      {:error, reason} ->
        {:error, [format_error(reason)]}
    end
  end

  defp ensure_coherent(log, read_model, %{"frames" => frames, "nodes" => nodes}) do
    case List.last(frames) do
      nil ->
        {:error, ["causal replay has no terminal frame"]}

      terminal ->
        errors =
          [
            {terminal["state"] == replay_state(read_model),
             "causal replay state differs from read model"},
            {terminal["holders"] == stringify_holders(read_model.roles.holders),
             "causal replay holders differ from read model"},
            {terminal["quarantine"] == stringify_reasons(read_model.roles.reasons),
             "causal replay quarantine differs from read model"},
            {terminal["visible_ids"] == log |> Log.op_ids() |> Enum.sort(),
             "causal replay op ids differ from verified log"},
            {length(nodes) == length(read_model.op_dag.nodes),
             "causal replay node count differs from read model"}
          ]
          |> Enum.reject(&elem(&1, 0))
          |> Enum.map(&elem(&1, 1))

        if errors == [], do: :ok, else: {:error, errors}
    end
  end

  defp ensure_coherent(_log, _read_model, _causal_replay),
    do: {:error, ["causal replay contract mismatch"]}

  defp replay_state(read_model) do
    %{
      "title" => read_model.threads.title,
      "summary" => read_model.threads.summary,
      "posts" => read_model.threads.posts,
      "members" => read_model.members.current,
      "clerk_locked" => read_model.threads.clerk_locked?
    }
  end

  defp stringify_holders(holders) do
    Map.new(holders, fn {role, holder} -> {Atom.to_string(role), holder} end)
  end

  defp stringify_reasons(reasons) do
    Map.new(reasons, fn {id, reason} -> {id, Atom.to_string(reason)} end)
  end

  defp op_counts(nodes) do
    %{
      total: length(nodes),
      honored: Enum.count(nodes, &(&1.status == "honored")),
      quarantined: Enum.count(nodes, &(&1.status == "quarantined"))
    }
  end

  defp demo_vouches do
    [
      {"realm:alice", <<9::256>>, :approve},
      {"realm:bob", <<10::256>>, :approve},
      {"realm:carol", <<11::256>>, :reject}
    ]
    |> Enum.map(fn {realm, seed, choice} ->
      identity = Identity.from_seed(realm, seed)
      {_token, body} = Attestation.cast_vouch(Attestation.Stub, identity, choice)
      body
    end)
  end

  defp sha256(bytes), do: :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)
  defp format_error(reason) when is_binary(reason), do: reason
  defp format_error(reason), do: inspect(reason)
end
