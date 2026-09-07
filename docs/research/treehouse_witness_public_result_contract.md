# R36 public result projection

This integrator contract fills the public-result serialization seam of the adopted
Stage 2 five-command API. It adds no purpose, authority, eligibility or command
activation. The private snapshot protocol remains distinct.

The exact identity command is `treehouse_witness_public_identity`. No alias is
registered. Identity input is exactly `{}`; the other four inputs remain the
reviewed closed JSON encoded as a numeric byte array. Refusals use Tauri rejected
promises with a fixed native reason string. A successful missing or cancellation
result is exactly `{version:1,status:"missing"}` or
`{version:1,status:"cancelled"}`. No success envelope can contain eligible true.

Identity success is exactly `{version:1,status:"identity",eligible:false,identity}`.
Preparation success is exactly
`{version:1,status:"prepared",eligible:false,identity,enrollment}`. Generation
success is exactly
`{version:1,status:"generated_unvalidated",eligible:false,identity}`.

`identity` has exactly the validated private snapshot record keys:
`creationAttemptId`, `phase`, `generationChallenge`, `metadata`, `revision`.
Both nullable fields must be present. The three phases and metadata shape/limits
are unchanged from the private snapshot contract. Revision and creation version
are canonical positive signed-64 decimal strings. `enrollment` has exactly
`replica`, `enrollmentId`, `recipient`, `creationAttemptId`, and matches the
proposed request plus the retained original identity. The projection does not
export the inventory of other enrollments or private operation handles.

Proof success is exactly
`{version:1,status:"signed",eligible:false,identity,binding}` with the original
completed identity. `binding` has exactly `claim` and `signature`. `claim` has
exactly thirteen keys: `domain`, `version`, `product`, `appId`, `replica`,
`enrollmentId`, `recipient`, `creationAttemptId`, `actualWitnessPublicKey`,
`generationChallengeDigest`, `freshValidatorNonce`, `nativeRandomNonce`, and
`nativeCallerSessionDigest`. The first four are the fixed binding domain,
integer 1, treehouse, and dev.treetop.lattice.treehouse. All variable fields are
those actually accepted by the sealed Rust verifier; no public proposed claim
or unchecked callback can produce a verified public result. Signature is the
verified 64-byte Ed25519 signature. Every binary field is canonical padded
Base64. The claim maps to the unchanged fixed 13-element canonical byte array.

The exported identity key/original attempt/challenge digest must match the
verified claim. Export uses retained original public metadata and chain, not a
new attestation. Serialize the actual complete JSON and reject over 131072 UTF-8
bytes. The independent validator matches its own issuance and trusted inputs;
this packet is never an eligibility report.

Cancellation ownership is the already specified native targeted event
`treehouse:witness-pending-v1` with exactly `{version:1,attemptId,phase}` and
phase review or presence. The ephemeral operation ID is distinct from the
retained creation attempt. The caller subscribes before invoking. Event loss
never permits caller-selected operation IDs or silently changes cancel mapping.
Native cancellation, lifecycle invalidation, callback draining, monotonic
consent deadlines and the final owner/session check remain mandatory.

The old six preview commands remain unchanged until the full continuity path
and native activation gates pass. This contract alone activates nothing.
