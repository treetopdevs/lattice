# Guarded Thread listing

Use this step after [catalog publication](treehouse_catalog_publication.md) has recorded
`catalogued`. It publishes only the already client-signed staged Space reference and
records a dated local `listed` receipt. It does not install trust or routes in an app,
prove a public relay or establish physical custody. Clients still judge current histories.
The ordinary two-app session remains a separate acceptance gate.

## Run inside the guarded relay

Keep the existing operator-controlled release running. Use its existing local RPC or
console; do not start another relay process. The public ceremony and separate read-only
probe identity must be the same ones used for catalog publication. No catalog, Space or
Thread seed belongs in this command. Deploy compatible BEAM and Python owner versions;
older versions refuse the newly supported initial-listed record.

Preserve the exact current catalogued intent in the private transfer directory:

```bash
( umask 077; set -o noclobber; cat "$ROOT/operator-journal.json" > "$TRANSFER/catalogued-intent.json" )
```

Create a private command file, substituting the actual paths as JSON strings:

```json
{
  "format": "treehouse-catalog-command-v1",
  "args": [
    "list",
    "--root", "/srv/treehouse/operator",
    "--expected", "/srv/treehouse/transfer/catalogued-intent.json",
    "--ceremony", "/srv/treehouse/ceremony",
    "--probe", "/srv/treehouse/probe.identity"
  ]
}
```

Run it through the existing release adapter:

```bash
bin/lattice_carrier_pilot rpc 'case LatticeCarrierServer.Operator.CatalogCli.run_file("/srv/treehouse/transfer/list.json") do :ok -> :ok; {:error, reason} -> raise Atom.to_string(reason) end'
```

The command rechecks the exact intent, boot, manifest, all authenticated routes, current
roster and bound service/catalog key. It verifies the committed catalog and exact staged
reference artifact. A pure bounded review judges the current holder snapshot and candidate;
a concurrent Space change makes its compare-and-swap token stale and requires fresh review.
Only that exact signed frame may be persisted. This creates no network courier action
and changes no participant relay allowlist.

After delivery it probes again, checks the served in-memory histories equal the verified
disk histories and re-observes every catalog entry. Only then may the existing Linux owner
record the phase-only listed receipt, checking manifest and boot incarnation under its lock.

For initial provisioning, the exact honored reference must already exist. Listing and
retry never rewrite the Space file. A missing initial reference refuses and is never
repaired by appending. Existing startup rehearsal on relay-enabled routes may replace
the file with identical bytes; that startup behavior is distinct from listing's zero-write
presence observation. Guarded Treehouse routes retain OD-5's reviewed relay realms.

## Retry and recovery

A timeout or lost reply can follow a durable reference or journal write. Preserve the
original intent and retry the same command. An exact matching listed receipt is accepted
only after fresh current-history review; no duplicate frame or journal history is written.
A different attempt, catalog, artifact or receipt is stale intent. Never replace the
intent with a fresh journal merely to hide a refusal, remove an authentic frame, hand-edit
a journal or reset the catalog signing ledger.

`stale_served_history` means the Space changed between review and delivery. Retry from
fresh evidence. `roster_drift_since_catalog`, `reference_not_honored`,
`initial_reference_competing` or `catalog_carried_entry_lapsed` requires explicit review
of current histories. A lapsed immutable reference retains its catalog slot. Replacement
is the separate row 244 workflow; signing another same-revision catalog is not recovery.

A known pre-rename persistence failure is retryable. An ambiguous failure or timeout
fences writes for the entire release incarnation. Its release owner retains outstanding
write-worker leases; restarting a holder child cannot clear the fence. Fenced holders
refuse mutations, readiness and drain capture. Recovery needs a controlled release restart
with verified disk restore in a new incarnation; there is no local unfence command.
Keep single-process ownership, stop the old VM before another process uses its paths,
and preserve the failed attempt's evidence. A worker must reauthorize its old-owner lease
after acquiring the target lock, so it cannot begin late effects under a replacement owner.
Do not claim a clean drain receipt for an ambiguous or still-running writer.

`listed` is a checked observation at particular frontiers. Later admission, revocation,
tombstone or history change can invalidate it for a client. It is not a continuous health,
authority or discoverability guarantee.
