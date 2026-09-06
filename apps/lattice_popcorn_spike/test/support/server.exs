Code.require_file("replica_server.exs", __DIR__)

defmodule LatticePopcornSpike.SignedEcho do
  @moduledoc "Test-only signature observer behind the unchanged Lattice Gateway."
  use GenServer

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)
  def init(_), do: {:ok, %{deliveries: 0, verified: 0, seen: MapSet.new()}}

  def handle_call(:stats, _, state),
    do: {:reply, Map.take(state, [:deliveries, :verified]), state}

  def handle_call({:lattice_call, envelope}, _, state) do
    valid = valid?(envelope) and not MapSet.member?(state.seen, envelope.payload["id"])
    state = %{state | deliveries: state.deliveries + 1}

    if valid do
      state = %{
        state
        | verified: state.verified + 1,
          seen: MapSet.put(state.seen, envelope.payload["id"])
      }

      {:reply, {:ok, %{signature_verified: true, id: envelope.payload["id"]}}, state}
    else
      {:reply, {:error, :invalid_signature_or_replay}, state}
    end
  end

  defp valid?(%{payload: p, cap_id: cap_id, from_tab_id: tab_id}) do
    with %{"body" => %{"tab_id" => ^tab_id} = body, "cap" => ^cap_id} <- p,
         {:ok, pub} <- Base.decode64(p["author"]),
         {:ok, sig} <- Base.decode64(p["sig"]),
         {:ok, claimed} <- Base.decode64(p["canonical"]) do
      actual = Lattice.Canonical.op_bytes("popcorn-spike", pub, [], :command, body, cap_id)

      actual == claimed and Lattice.Identity.verify(pub, actual, sig) and
        Base.url_encode64(:crypto.hash(:sha256, actual), padding: false) == p["id"]
    else
      _ -> false
    end
  rescue
    _ -> false
  end
end

defmodule LatticePopcornSpike.EvidenceHandler do
  @moduledoc "Loopback-only fixture controls. Never mounted by the application."
  def init(req, opts) do
    result =
      case {:cowboy_req.method(req), :cowboy_req.path(req)} do
        {"GET", "/proof/state"} ->
          stats = GenServer.call(LatticePopcornSpike.SignedEcho, :stats)

          tabs =
            Lattice.Topology.snapshot().tabs
            |> Map.values()
            |> Enum.map(&Map.take(&1, [:id, :state]))

          Map.put(stats, :tabs, tabs)

        {"GET", "/proof/replica"} ->
          GenServer.call(LatticePopcornSpike.ReplicaServer, :state)

        {"POST", "/proof/revoke"} ->
          pub = :cowboy_req.parse_qs(req) |> List.keyfind("public_key", 0, {nil, nil}) |> elem(1)
          GenServer.call(LatticePopcornSpike.ReplicaServer, {:revoke, pub})

        {"POST", "/proof/lease"} ->
          tab_id = :cowboy_req.parse_qs(req) |> List.keyfind("tab_id", 0, {nil, nil}) |> elem(1)

          case Lattice.grant(tab_id, LatticePopcornSpike.SignedEcho, [:call], ttl: 20) do
            {:ok, cap} -> %{cap_id: cap.id}
            _ -> %{error: "invalid_tab"}
          end

        _ ->
          %{error: "invalid_request"}
      end

    req =
      :cowboy_req.reply(200, %{"content-type" => "application/json"}, Jason.encode!(result), req)

    {:ok, req, opts}
  end
end

defmodule LatticePopcornSpike.Server do
  @moduledoc "Isolated local proof listener using the existing WebSocket handler."
  def start(port) do
    {:ok, _} = LatticePopcornSpike.SignedEcho.start_link([])
    {:ok, _} = LatticePopcornSpike.ReplicaServer.start_link([])

    dispatch =
      :cowboy_router.compile([
        {:_,
         [
           {"/ws", Lattice.Transport.WebSocket,
            %{
              grant_targets: %{
                "signed_echo" => LatticePopcornSpike.SignedEcho,
                "replica_demo" => LatticePopcornSpike.ReplicaServer,
                {"replica_demo", :ops} => ["call"],
                {"signed_echo", :ops} => ["call"]
              },
              auto_story?: false
            }},
           {"/proof/[...]", LatticePopcornSpike.EvidenceHandler, %{}}
         ]}
      ])

    :cowboy.start_clear(:lattice_popcorn_proof, [ip: {127, 0, 0, 1}, port: port], %{
      env: %{dispatch: dispatch}
    })
  end
end
