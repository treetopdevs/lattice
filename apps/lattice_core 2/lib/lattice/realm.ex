defmodule Lattice.Realm do
  @moduledoc """
  A stable realm identity inside the Lattice process plane.

  Realms are descriptive metadata. Authority is never derived from realm ids,
  node membership, registered names, pids, or cookies; the gateway only accepts
  explicit capabilities.
  """

  @enforce_keys [:id, :type, :session_id, :state, :connected_at]
  defstruct [
    :id,
    :type,
    :session_id,
    :auth,
    :metadata,
    :state,
    :connected_at,
    :disconnected_at
  ]

  @type type :: :server | :tab | atom()
  @type lifecycle_state :: :connected | :disconnected | :ejected

  @type t :: %__MODULE__{
          id: String.t(),
          type: type(),
          session_id: String.t(),
          auth: map() | nil,
          metadata: map() | nil,
          state: lifecycle_state(),
          connected_at: integer(),
          disconnected_at: integer() | nil
        }

  def server(metadata \\ %{}) do
    now = System.monotonic_time(:millisecond)

    %__MODULE__{
      id: "server",
      type: :server,
      session_id: "server",
      auth: %{trusted: true},
      metadata: metadata,
      state: :connected,
      connected_at: now
    }
  end

  def tab(attrs) when is_map(attrs) do
    now = System.monotonic_time(:millisecond)
    tab_id = Map.get(attrs, :id) || Map.get(attrs, "id") || "tab_" <> random_id(18)

    session_id =
      Map.get(attrs, :session_id) || Map.get(attrs, "session_id") || "sess_" <> random_id(18)

    %__MODULE__{
      id: tab_id,
      type: :tab,
      session_id: session_id,
      auth: Map.get(attrs, :auth) || Map.get(attrs, "auth") || %{},
      metadata: Map.get(attrs, :metadata) || Map.get(attrs, "metadata") || %{},
      state: :connected,
      connected_at: now
    }
  end

  def random_id(bytes \\ 24) do
    bytes
    |> :crypto.strong_rand_bytes()
    |> Base.url_encode64(padding: false)
  end
end
