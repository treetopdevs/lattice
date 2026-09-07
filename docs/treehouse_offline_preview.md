# Treehouse offline preview

Treehouse opens empty. **Create local group** creates a local Space and a device-held signing
identity. Create Threads, write posts, edit or hide your own posts, and archive Threads. Changes
reported as **Saved on this device** survive an app restart. The original signed history remains
retained, including edits, hidden posts and archived Threads.

**Recovery is not set up.** This preview has no invitations, member grants, live catalog, sync or
witness setup. It is one local Space with twelve total Thread slots; archiving retains a slot.
The signing key is stored in the platform key store, separately from the Treehouse database.
Missing history or unavailable/mismatched keys are shown explicitly and never replaced silently.

Drafts save after an idle pause. Wait for **Saved on this device** before quitting. Posting commits
one signed command and a draft revision watermark atomically. A failed save keeps your draft.
If another window changes saved history or the draft, reopen before retrying; no saved operation
is overwritten by a stale window.

The initial preview limits the entire serialized public history record to 1 MiB and a draft to
16 KiB. The existing per-Thread 4,000-operation / 8 MiB authoring stop also applies. These are bounded
preview stops; no pilot-scale latency, full-volume capacity or mobile device claim is made.

From `clients/treehouse-tauri-shell`, run `npm ci`, `npm test`, `npm run build`,
`npm run native:test`, then `npm run tauri -- build` for the separately packaged macOS app.
The package uses `dev.treetop.lattice.treehouse` and `treehouse-v1.sqlite3`. It does not import
Township data, fixtures or signing identities.

The packaged gate is `npm run packaged`. It uses an external macOS Accessibility driver on the
normal visible interface, requires Accessibility permission and a clean macOS account, and
refuses to remove existing Treehouse data. Browser tests and injected signers are not packaged
evidence. Local/native/packaged/hosted evidence is recorded separately in the R12 roadmap packet.

A rebuilt unsigned macOS executable may ask you to authorize the existing Treehouse key again in
the system Keychain dialog. Enter any required credential only in that system dialog. The app
never accepts a password or exports the signing key. The original same-binary restart gate passed;
rebuilt-binary replay remains open until platform authorization is completed.
