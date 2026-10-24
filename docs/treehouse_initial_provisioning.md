# Initial Treehouse provisioning import

This operator tool prepares a first bounded Space and Thread from public signed
evidence. It does not publish a catalog, install app trust, or prove two-app relay
chat. The ordinary offline exchange and final bundle export controls remain plan
262 B; the current integration gate produces evidence through the actual app
workflow with isolated seed-store adapters.

Use a supported Linux host, OTP 28/Elixir 1.19.5, a verified catalog ceremony, and
an existing private service identity file. Finish the ordinary Space pin/export,
binding-payload review/sign, re-export and verify-binding/report ceremony first.
The final bundle must contain both participants' admission and direct child-root
posting grants. Neither a transport peer list nor a valid signature substitutes
for that authority.

Create the operator root privately before its first controlled boot. Use an output
directory outside that root, under a trusted existing parent, with no symlinks.
The importer creates the output; do not pre-create or populate it.

```sh
mix treehouse.initial_provisioning \
  --bundle /private/input/initial-bundle.json \
  --ceremony /private/ceremony \
  --output /private/new-initial-output \
  --operator-root /private/operator \
  --identity-file /private/keys/service.identity \
  --space-port 4101 --thread-port 4102
```

All arguments are file paths or public configuration. No seed or passphrase goes
in an argument, bundle or output. Supply explicit distinct nonzero listener ports, and verify the host/proxy
mapping separately before a field run. Port zero is limited to the existing test
harness configuration; the ordinary command never enables that escape hatch.

Successful output contains verified Space/Thread log dumps, the signed reference,
derived grant review, a Space-only initial manifest, a candidate manifest, and
`complete.json`. The manifest blueprint is not bootable JSON. All sealed data is verified and synced
before `complete.json`; only after that marker is durable does the importer publish
the bootable initial manifest through an exclusive write and sync. A completed retry rechecks every file and syncs existing
material. Partial, changed, extra, symlinked or hard-linked output refuses and is
preserved. Use a new reviewed attempt rather than deleting recovery evidence.

Start the existing controlled carrier with `LATTICE_CARRIER_MANIFEST` pointing at
the reported initial manifest and `LATTICE_CARRIER_OPERATOR_ROOT` at the operator
root. The initial deployment serves only the imported Space. The public
`InitialProvisioning.prepare/1` result also supplies the request and artifacts for
`Staging.prepare/5`; read the current journal as its expected state. Staging copies
and verifies the child and candidate manifest under its own mutation lock, without
rewriting the existing Space reference or source log.

After restart, call `InitialProvisioning.load_staging(output, ceremony)` to reconstruct
those inputs from the sealed public `bundle.json`. It rechecks the immutable files,
service binding and original operations retained in the current Space. It permits
append-only Space growth and the known activated manifest. It does not write files
or assert readiness; staging and activation still recheck current authority.
Resume from the current journal phase. The returned original request is for the
initial staging phase; after activation, proceed with readiness rather than staging
again. A concurrent live-file replacement may cause a read refusal; retry the
read-only loader after that write completes. Use
`prepare/1` only for an exact import retry, not to repair live files.

`initial_existing` is an explicit observation of an already-honored reference.
Normal pending-reference mode still requires absence. Initial staging verifies
an empty catalog store under its owner lock. Activation/readiness re-observe the
reference and grants. Initial import and unserved staging require clean, closed child
history. Live rechecks retain quarantined authentic operations without letting them
change effective grants; reviewed authority, profile and reference drift still refuse.
In initial mode, the reference title must match the child creation title. Catalog/listing refuse this mode until their actual guarded
consumers support it; never manually advance the journal to bypass that stop.

A prior controlled-boot marker prevents creating another fresh import in that
operator root. It is not a liveness detector or permission to reset state. Total
deletion of the store, journal, history and marker is indistinguishable from first
use locally; preserving these files is an operator trust assumption. Existing
clients retain their independent catalog fork/rollback checks.
