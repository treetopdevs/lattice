defmodule TownshipWeb do
  @moduledoc """
  Entry point for the Township Phoenix boundary.
  """

  def router do
    quote do
      use Phoenix.Router, helpers: false

      import Phoenix.Controller
      import Phoenix.LiveView.Router
      import Plug.Conn
    end
  end

  def live_view do
    quote do
      use Phoenix.LiveView, layout: {TownshipWeb.Layouts, :app}

      unquote(html_helpers())
    end
  end

  def html do
    quote do
      use Phoenix.Component

      unquote(html_helpers())
    end
  end

  defp html_helpers do
    quote do
      import Phoenix.HTML

      alias Phoenix.LiveView.JS
    end
  end

  @doc false
  defmacro __using__(which) when is_atom(which), do: apply(__MODULE__, which, [])
end
