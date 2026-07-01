defmodule Lattice.Demo.AdPreview do
  @moduledoc """
  Server-side half of the MovableProcess demo.
  """

  def generate_storyboard(brief) do
    %{
      title: "Storyboard",
      brief: brief,
      frames: [
        %{id: 1, text: "Introduce the problem"},
        %{id: 2, text: "Show the offer"},
        %{id: 3, text: "Invite action"}
      ]
    }
  end
end
