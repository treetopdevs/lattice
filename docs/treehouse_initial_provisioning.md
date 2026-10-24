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
in an argument, bundle or output. Ports default to zero for fixture startup;
choose and verify real listener/proxy mappings separately before a field run.

Successful output contains verified Space/Thread log dumps, the signed reference,
derived grant review, a Space-only initial manifest, a candidate manifest, and
`complete.json`. Files and their directory are synced before the completion marker,
which is synced last. A completed retry rechecks every file and syncs existing
material. Partial, changed, extra, symlinked or hard-linked output refuses and is
preserved. Use a new reviewed attempt rather than deleting recovery evidence.

Start the existing controlled carrier with `LATTICE_CARRIER_MANIFEST` pointing at
the reported initial manifest and `LATTICE_CARRIER_OPERATOR_ROOT` at the operator
root. The initial deployment serves only the imported Space. The public
`InitialProvisioning.prepare/1` result also supplies the request and artifacts for
`Staging.prepare/5`; read the current journal as its expected state. Staging copies
and verifies the child and candidate manifest under its own mutation lock, without
rewriting the existing Space reference or source log.

`initial_existing` is an explicit observation of an already-honored reference.
Normal pending-reference mode still requires absence. Initial staging verifies
an empty catalog store under its owner lock. Activation/readiness re-observe the
reference and grants. Catalog/listing refuse this mode until their actual guarded
consumers support it; never manually advance the journal to bypass that stop.

A prior controlled-boot marker prevents creating another fresh import in that
operator root. It is not a liveness detector or permission to reset state. Total
deletion of the store, journal, history and marker is indistinguishable from first
use locally; preserving these files is an operator trust assumption. Existing
clients retain their independent catalog fork/rollback checks.
