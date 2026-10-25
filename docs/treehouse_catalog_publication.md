# Local catalog publication with an off-host custodian

This is the plan 263 software workflow. It records `catalogued` after local authenticated
probes; it does not mark a Thread listed, install app trust, deploy a public relay, or
prove physical key custody. The actual operator ceremony and backup drill remain field
prerequisites. Use disposable ceremonies for rehearsals.

The relay host holds the service identity and a separate read-only probe identity. It
never receives the catalog signer seed. The custodian keeps the seed, its completed
ceremony and the one managed signing ledger. Follow
[signer custody](treehouse_catalog_signer_custody.md) for generation, backup and signing.

## Before starting

The relay must already be running under its operator-root controlled boot, with its
journal at `ready`, the staged child active, and its current roster/relay realms matching
reviewed membership. Use the already available local release RPC or console. Do not
start a second relay process or enable a new network listener to run these commands.
The Python helpers must be deployed with the trusted checkout; relocated releases and
an untrusted Python/toolchain are outside this software claim.

Keep the transfer directory private (0700). Every output creates a new private file,
or accepts identical existing bytes. Preserve earlier status/package/envelope files;
use a new filename per attempt/revision. Never edit a served log or journal.

Before the **first** relay prepare, the custodian initializes from its own verified signed
Space log, without needing an operator signing package:

```bash
~/.asdf/shims/mix treehouse.catalog_ceremony init-ledger \
  --ceremony "$CEREMONY" --space-log "$SIGNED_SPACE_LOG" --out "$GENESIS_STATUS"
```

Transfer this public genesis status to the relay operator. Future status exports include
the signed chain. A stale/withheld status is not a freshness guarantee: the custodian's
actual locked ledger still refuses a competing signature.

## Preserve intent, prepare and transfer

Copy the exact current ready journal bytes into a new intent file. This is a read-only
snapshot, not a journal edit. In a shell with the paths set for this deployment:

```bash
( set -o noclobber; cat "$ROOT/operator-journal.json" > "$TRANSFER/ready-intent.json" )
```

Create a private JSON command file, for example `/srv/treehouse/transfer/prepare.json`:

```json
{
  "format": "treehouse-catalog-command-v1",
  "args": [
    "prepare",
    "--root", "/srv/treehouse/operator",
    "--expected", "/srv/treehouse/transfer/ready-intent.json",
    "--ceremony", "/srv/treehouse/ceremony",
    "--probe", "/srv/treehouse/probe.identity",
    "--status", "/srv/treehouse/transfer/custodian-status.json",
    "--out", "/srv/treehouse/transfer/catalog-unsigned.json"
  ]
}
```

Substitute the actual paths as JSON strings. Commands are data, never evaluated as code.
Execute inside the already running guarded release (or call `run_file/1` in its console):

```bash
bin/lattice_carrier_pilot rpc 'case LatticeCarrierServer.Operator.CatalogCli.run_file("/srv/treehouse/transfer/prepare.json") do :ok -> :ok; {:error, reason} -> raise Atom.to_string(reason) end'
```

The wrapper case makes a refusal fail the shell command. The adapter itself prints an
atom-only refusal. It rechecks the exact ready bytes, guarded boot/manifest, roster,
service binding, authenticated pulls for all Treehouse routes, store head and custodian
status. It carries every old catalog entry unchanged and adds the staged Thread. The
journal remains ready. Its JSON output names the package and prints the derived review.

Transfer the **unchanged** package to the custodian. It includes complete Space and
Thread histories, including plaintext chat. The custodian independently verifies its
own ceremony binding, every signed history and reference. Review roots, routes,
references, inventory, snapshot frame counts/frontier digests and the expected new entry
through a separately checked operator channel. Follow `review-catalog`, `sign-catalog`
and `catalog-status` in the custody runbook. Transfer the signed envelope and current
public status back. Never transfer the seed.

## Commit the same package and envelope

Create another private command file; reuse the original intent snapshot and package:

```json
{
  "format": "treehouse-catalog-command-v1",
  "args": [
    "commit",
    "--root", "/srv/treehouse/operator",
    "--expected", "/srv/treehouse/transfer/ready-intent.json",
    "--ceremony", "/srv/treehouse/ceremony",
    "--probe", "/srv/treehouse/probe.identity",
    "--package", "/srv/treehouse/transfer/catalog-unsigned.json",
    "--envelope", "/srv/treehouse/transfer/catalog-signed.json"
  ]
}
```

Run it through the same local RPC/console adapter. Commit redoes the live review,
requires current histories to extend the reviewed snapshot, recomputes the identical
catalog, verifies the bound signature and asks the existing Linux owner to publish the
immutable envelope before its journal receipt. Its output is a local `catalogued`
receipt, not a live health signal or an app route-installation receipt.

For initial provisioning, the reference already exists in Space: commit observes the
exact honored frame and leaves the served Space file unchanged. For later pending
references, cataloguing leaves the staged reference unserved. Follow the separate
[guarded listing step](treehouse_thread_listing.md) for either reference mode.

## Retry and refusal

Keep all evidence after any error. A timeout, lost reply or failed export may follow a
durable write. Retry the exact intent/package/envelope: an existing matching receipt
succeeds without another revision or journal write. A pending immutable envelope must
match the recomputed catalog; a different pending signature/catalog refuses. Never reset
a ledger, restage to conceal a consumed signature, or delete store history to retry.

Roster, authority, binding, route or history changes can make an already signed catalog
unusable. It still consumes that signature revision; there is no fork-safe abandonment.
This needs explicit custody/recovery handling. Do not sign a competing catalog at that
revision. A consistent rollback of the entire custodian ledger cannot be detected by
this tooling; preserve the counter/ledger with its backup practice.

The catalog admits at most thirteen entries (one Space and twelve Threads). Operator
packages also have explicit history/frame/byte limits. Capacity refusal preserves the
ready journal and store; it never truncates evidence or silently drops carried entries.

Restaging an existing `ready`, `catalogued` or `listed` attempt requires the optional
sixth `Staging.prepare/6` argument: the current public custodian-status file. A signature
not yet receipted in the local store refuses `catalog_signature_pending`; omitted status
refuses `custodian_status_required`. Initial and still-pending staging retain their
existing API. Status is revalidated under the staging owner's lock against the binding
and requested committed head. This prevents accidental erasure of a reviewed pending
signature; it cannot prove that a remote custodian has signed nothing since a snapshot.

A later catalog can carry an earlier Thread only when its earlier reference is actually
served and honored. It never treats that old reference as hypothetical. Complete listing
(or genuine client publication of the exact signed reference) before another publication
attempt. A still-absent carried reference makes prepare refuse `catalog_reference_pending` and preserves the current
journal/store; it is not repaired by inventing a second frame. The capacity rehearsal
uses fixture-only client-signed relay deliveries between revisions, not a listed receipt.

`catalogued` records checked frontiers. As in readiness confirmation, an op may arrive
between the final observation and the owner's journal replacement; the receipt makes no
continuous-current-authority claim. Guarded listing and native client evaluation must
re-observe actual histories before relying on it.

The public decoder bounds the entire JSON input at 64 MiB before parsing. Per-history
frame/byte budgets are then checked before Wire decoding and cryptographic replay;
this deliberately permits a bounded JSON transient rather than a streaming format.
`invalid_catalog_package` includes malformed/authentication evidence and history/package
budget refusals; inspect the documented byte/frame limits rather than assuming corruption.
An entry-count overflow is the distinct `catalog_capacity` refusal. A carried instance
missing from a hand-altered deployment is refused, never omitted from a catalog.
