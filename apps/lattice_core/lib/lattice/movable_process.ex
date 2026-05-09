defmodule Lattice.MovableProcess do
  @moduledoc """
  Minimal logical process that routes operations across server and tab realms.

  This is intentionally small: it proves one handle can choose a realm per
  operation while still using the capability gateway.
  """

  use GenServer

  defstruct [:pid]

  def start_link(tab_id, opts \\ []) do
    GenServer.start_link(__MODULE__, {tab_id, opts})
  end

  def new(tab_id, opts \\ []) do
    with {:ok, pid} <- start_link(tab_id, opts) do
      {:ok, %__MODULE__{pid: pid}}
    end
  end

  def generate_storyboard(%__MODULE__{pid: pid}, brief) do
    GenServer.call(pid, {:generate_storyboard, brief})
  end

  def render_preview(%__MODULE__{pid: pid}) do
    GenServer.call(pid, :render_preview)
  end

  def get_state(%__MODULE__{pid: pid}) do
    GenServer.call(pid, :get_state)
  end

  @impl true
  def init({tab_id, opts}) do
    render_cap =
      case Keyword.fetch(opts, :render_cap) do
        {:ok, cap} ->
          cap

        :error ->
          if Keyword.get(opts, :grant_render_cap, true) do
            {:ok, cap} =
              Lattice.grant(tab_id, {:tab, tab_id}, [:call], ttl: Keyword.get(opts, :ttl_ms))

            cap
          end
      end

    {:ok, %{tab_id: tab_id, render_cap: render_cap, storyboard: nil, preview: nil}}
  end

  @impl true
  def handle_call({:generate_storyboard, brief}, _from, state) do
    storyboard = Lattice.Demo.AdPreview.generate_storyboard(brief)
    {:reply, {:ok, storyboard}, %{state | storyboard: storyboard}}
  end

  def handle_call(:render_preview, _from, %{render_cap: nil} = state) do
    Lattice.Audit.record(:deny, %{
      tab_id: state.tab_id,
      reason: :movable_process_missing_render_cap
    })

    {:reply, {:error, :missing_render_cap}, state}
  end

  def handle_call(:render_preview, _from, state) do
    payload = %{op: :render_preview, storyboard: state.storyboard}

    case Lattice.call(state.tab_id, state.render_cap, payload) do
      {:ok, preview} ->
        {:reply, {:ok, preview}, %{state | preview: preview}}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call(:get_state, _from, state), do: {:reply, state, state}
end
