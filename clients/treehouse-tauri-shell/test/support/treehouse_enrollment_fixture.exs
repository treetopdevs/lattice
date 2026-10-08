# Plan 181 slice 4 fixture: one empty replica-named path log per route. The relay manifest names these
# files, and the founder's first Sync relays the genesis into them. The replica ids are the bound ids the
# app minted (`replica:treehouse:<kind>:<nonce>#root:<tag>`), so an empty `Log.new/1` restores through the
# holder and accepts the founder's genesis.
#
# usage: treehouse_enrollment_fixture.exs <dir> <label>=<replica> ...
alias Lattice.Log

[dir | pairs] = System.argv()

for pair <- pairs do
  [label, replica] = String.split(pair, "=", parts: 2)
  :ok = Log.dump(Log.new(replica), Path.join(dir, "#{label}.log"))
end

IO.puts("FIXTURE_READY #{length(pairs)}")
