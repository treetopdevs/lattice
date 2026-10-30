defmodule Lattice.NativePeerOutput do
  @moduledoc false

  # Mix may print umbrella headers while acquiring its build lock. Keep the
  # fresh protocol response separate without skipping dependency checks.
  def puts(json) when is_binary(json) do
    case System.get_env("LATTICE_NATIVE_PEER_OUTPUT") do
      nil -> IO.puts(json)
      path -> File.write!(path, json, [:append])
    end
  end
end
