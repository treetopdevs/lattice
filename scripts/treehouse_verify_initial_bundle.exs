# Independent boundary proof over the ordinary app's public output, not its SQLite state.
path = System.fetch_env!("TREEHOUSE_INITIAL_BUNDLE")
{:ok, bundle} = LatticeCarrierServer.Operator.InitialBundle.load(path)

IO.puts(
  JSON.encode!(%{
    "status" => "PASS",
    "claim" => "verified_public_initial_bundle",
    "space" => bundle.space.replica,
    "thread" => bundle.child.replica,
    "reference" => bundle.reference.id,
    "members" => length(bundle.roster)
  })
)
