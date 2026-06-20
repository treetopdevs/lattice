defmodule Lattice2.UnifiedChainTest do
  @moduledoc """
  Phase C keystone — behavior 16.

  The same signed delegation chain authorizes BOTH a log append (its leaf id is
  cited in `Lattice.Op.cap`) and a live ephemeral message sent through the v1
  `Lattice.Gateway` (the chain rides in a `Lattice.Cap`). One revoke — an in-log
  `:revoke` op plus the linked v1 cap revocation — kills both paths.
  """
  use ExUnit.Case, async: false

  alias Lattice.{Authority, Cap, Identity, Live, Log, Op, Reduce}
  alias Lattice.Authority.Delegation
  alias Lattice.Demo.Thread

  defmodule Echo do
    use GenServer
    def start_link(_), do: GenServer.start_link(__MODULE__, nil)
    @impl true
    def init(_), do: {:ok, nil}
    @impl true
    def handle_call({:lattice_call, %{payload: payload}}, _from, state),
      do: {:reply, {:ok, {:echo, payload}}, state}
  end

  setup do
    Lattice.reset!()
    :ok
  end

  test "one delegation chain authorizes a log append and a live Gateway message; revoke kills both" do
    replica = "replica:thread:unified"
    server = Identity.from_seed("server", "seed:server")
    tab = Identity.from_seed("tab", "seed:tab")

    # Genesis self-grant, then ONE delegation D: server -> tab, granting :post (a
    # log capability) AND :live (an ephemeral-send capability).
    genesis =
      Delegation.genesis(server, replica,
        ops: [:post, :set_title],
        roles: [:moderator],
        live: true
      )

    g_op = Op.new(server, replica, [], :authority, {:genesis, genesis, %{}})
    log = Log.append!(Log.new(replica), g_op)

    d = Delegation.new(server, replica, tab.pub, ops: [:post], live: true, parent_id: genesis.id)
    grant_op = Op.new(server, replica, Log.frontier(log), :authority, {:grant, d})
    log = Log.append!(log, grant_op)

    # v1 capability plane: connect the tab, start a target process, mint a v1 cap,
    # and bind the SAME chain to it.
    {:ok, _tab_realm} =
      Lattice.connect_tab(%{id: "tab", connection_pid: self(), transport: Lattice.Transport})

    {:ok, echo} = start_supervised(Echo)
    {:ok, v1cap} = Lattice.grant("tab", {:server, echo}, [:call])
    cap = Cap.with_chain(v1cap, replica, [genesis, d])

    # (a) LOG APPEND PATH — tab posts citing D's id.
    post = Op.new(tab, replica, Log.frontier(log), :command, {:post, ["live+log"]}, cap: d.id)
    log = Log.append!(log, post)
    refute MapSet.member?(Authority.quarantine(Thread, log), post.id)
    q = Authority.quarantine(Thread, log)
    assert "live+log" in Reduce.reduce(Thread, log, quarantine: q).messages

    # (b) LIVE PATH — same chain, routed through the v1 Gateway to the target.
    assert {:ok, {:echo, %{hello: 1}}} = Live.call(cap, log, %{hello: 1})

    # ---- Revoke the one chain. ----
    log = Live.revoke(log, server, d.id, cap.id)

    # (a') LOG APPEND PATH now dead.
    post2 = Op.new(tab, replica, Log.frontier(log), :command, {:post, ["after"]}, cap: d.id)
    log = Log.append!(log, post2)
    assert Map.get(Authority.analyze(Thread, log).reasons, post2.id) == :revoked_capability
    q2 = Authority.quarantine(Thread, log)
    refute "after" in Reduce.reduce(Thread, log, quarantine: q2).messages

    # (b') LIVE PATH now dead — denied by the same in-log revocation.
    assert {:error, :revoked} = Live.call(cap, log, %{hello: 2})
  end
end
