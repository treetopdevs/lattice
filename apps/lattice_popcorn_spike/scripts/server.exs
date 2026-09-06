Code.require_file("../test/support/server.exs", __DIR__)

{:ok, _} =
  LatticePopcornSpike.Server.start(
    String.to_integer(System.get_env("LATTICE_POPCORN_PORT", "4059"))
  )

IO.puts("Popcorn proof Gateway ready (loopback only)")
Process.sleep(:infinity)
