# 4. Screens and flows

Each screen lists what it reads, what it can do, and its empty, offline and refused states.
Read models and commands are defined in [03](03-application-layer.md). Words come from
[01](01-ubiquitous-language.md). Layout and feel are left to iteration; the content and state
coverage here are the part to hold fixed.

## Navigation map

```
Launch
 ├─ no key ─────────────► Welcome ─► Trust card ─► Start a group | Join a group
 ├─ joining ────────────► Join ceremony (resumes at the saved step)
 ├─ problem ────────────► Problem screen (identity mismatch | history invalid | removed)
 └─ member ─────────────► Tabs
        ├─ Threads ─► Thread ─► Message details ─► Verify (this message)
        │              └─ Thread info (health, archive, continue in new thread)
        ├─ People ──► Person ─► (admin) Remove | Make moderator | Transfer admin
        │              └─ Invite ceremony (resumes at the saved step)
        └─ Group ───► Relay ─► Verify & audit ─► Export
```

One Group per install in v1 (open decision O-2). Three tabs. Everything deeper is a pushed
screen or a sheet.

## Design principles

1. **Show what is true on this phone.** State labels describe this device and its relay link.
2. **Controls match abilities.** A control the person can never use is hidden. One they cannot
   use right now is disabled with the reason one tap away.
3. **Calm by default, detail on request.** Protocol terms live in Verify. The main surfaces
   use the plain words.
4. **Irreversible actions say so before, not after.** Delete, remove, archive and admin
   transfer each get one confirmation naming what cannot be undone.
5. **Nothing blocks on the network.** Every authoring action completes locally at once.
6. **No surprise loss.** The app never deletes held history or replaces a key on its own.

## Onboarding

**Welcome.** One sentence on what a Group is, then Continue.

**Trust card.** Shown once here and always available under Group. The approved hosting
sentence, then three plain points: your key lives on this phone only; there is no account and
no recovery if the phone is lost; messages are text only.

**Choose.** "Join a group" is primary. "Start a group" is shown only where the relay can
provision one (see [05](05-capability-matrix.md)); otherwise it explains that a relay operator
sets up new groups for now.

| State | Shown |
|---|---|
| Key creation fails | "This phone could not create a secure key." Retry. No fallback to an insecure key. |
| Returning with a key but no group | Straight to Choose. |

## Join ceremony (joiner)

| Step | Screen | Reads | Actions |
|---|---|---|---|
| 1 | **Show your join request** | own key check, QR | Share as text instead |
| 2 | **Scan the offer** | camera | Paste instead |
| 3 | **Review** | Group id check, relay address and reader sentence, thread list | Confirm, Cancel |
| 4 | **Checking** | link state while the Space is pulled and the invitation verified | Retry |
| 5 | **Show your acceptance** | QR | Share as text instead |
| 6 | **Waiting to be admitted** | link state | Sync now |
| 7 | **You're in** | Group name | Open |

- Closing the app at any step resumes at that step. Step 3 holds the offer in memory only, so
  a restart there returns to step 2.
- Step 4 refusals: relay refused this phone ("The relay does not know this phone yet. Ask the
  admin to check relay access."), invitation not found, wrong recipient ("This offer was made
  for a different phone."), revoked, stale scope.
- Step 6 has no timeout. It says what it waits for and who acts next.

## Invite ceremony (admin)

Entry: People → Invite. Hidden unless `Abilities.issue_invitation` is allowed.

| Step | Screen | Actions |
|---|---|---|
| 1 | **Scan their join request** | Paste instead |
| 2 | **Is this them?** key check to compare aloud, name field (petname) | Create invitation, Cancel |
| 3 | **Show the offer** QR or Share | Next |
| 4 | **Scan their acceptance** | Paste instead |
| 5 | **Admit** summary: name, level (member) | Admit |
| 6 | **Done** with the admission's delivery state | Close |

- After step 2 the invitation is a signed op. Cancelling later offers "Revoke invitation".
- People shows **Invitations in progress** with each ceremony's step and Resume or Revoke.
- If the Group has more than 3 threads, step 2 is refused with the reason (invitation scope
  limit) rather than failing at signing.
- The admin needs the relay between steps 2 and 3: the joiner can only verify an invitation
  the relay already holds. Step 3 waits on "Invitation on relay" and says so if the phone is
  offline. Steps 4 and 5 work offline; step 6 then shows "Saved on this phone" until the relay
  has the admission, and the joiner cannot finish until it does.
- If this phone lacks the key for a Thread in scope, step 5 is refused with the reason and
  names the phone that created the Thread as the one that must admit.

## Threads tab

**Reads** `GroupSummary`, `LinkStatus`, `ThreadList`, `Abilities`.

- Header: Group name and the connection pill. Tapping the pill opens Relay.
- Rows: title, last message preview with the author's name, unread count, a small
  waiting-to-send mark when the outbox for that thread is not empty.
- Archived threads sit in a collapsed section at the bottom.
- **New thread** appears only if `create_thread` is allowed and a slot is free.

| State | Shown |
|---|---|
| No threads | "No threads yet." plus New thread if allowed |
| Offline | list from the phone, pill says Offline, everything still opens |
| Slots full | New thread disabled: "This group has used all 12 threads." |
| Thread route not connected | a quiet mark on that row; the thread still opens |

## Thread screen

**Reads** `ThreadTimeline`, `Abilities`, draft. **Commands** post, edit, delete, remove (as
moderator), save draft, mark read.

- Bottom-anchored list in canonical order. Consecutive messages from one author are grouped.
  Day separators use first-seen time where it exists.
- My messages show a delivery mark: clock for saved or sending, single check for on relay,
  warning for relay did not accept. No second check exists.
- "Arrived later" is a small caption on messages that sorted above already-read ones.
- An unread divider sits above the first unread id on open.
- Edited messages show "edited". Removed messages leave a placeholder: "Message deleted" or
  "Removed by moderator".
- The composer saves its draft on every pause. Send is enabled when text is non-empty and
  `post` is allowed.

Long-press sheet (items appear only when allowed):

| Item | For | Confirmation |
|---|---|---|
| Copy | any | none |
| Edit | my honored message, thread not archived | none; composer enters edit mode |
| Delete | my honored message, thread not archived | "Delete this message for the group? This can't be undone. Copies already synced stay in the group's signed history." |
| Remove as moderator | others' messages, if moderator | same sentence, "Remove" |
| Details | any | opens Message details |

| State | Shown |
|---|---|
| Empty thread | "No messages yet." |
| Archived | banner "Archived. Read only." with a link to the successor if one exists; composer replaced by the banner |
| Cannot post (no grant, lapsed, removed) | composer replaced by one line with the reason and who can fix it |
| My message not counted | greyed bubble, reason line, "Copy text" so it can be re-sent |
| Relay did not accept | warning mark; details give the relay's reason; "Try again" runs sync |
| Thread near rollover threshold | moderator sees a one-line prompt to continue in a new thread |
| Concurrent edit lost | the winning text is shown; no error, since both edits are valid history |

**Message details.** Author name and key check, first-seen time labelled as "first on this
phone", delivery, standing, edit history count, and "Verify" which opens the op in Verify.

**Thread info.** Title, message and op counts, size against the rollover thresholds (4,000
ops, 8 MiB), Archive (moderator), Continue in a new thread (moderator and admin abilities).

## People tab

**Reads** `Roster`, `InvitationDesk`, `Abilities`.

- Rows: identicon, petname (or key check if none), role pill (Admin, Moderator), "you".
- Tap a person: set the name you gave, compare key check, see "Started this group" if root.
- Actions on a person, each shown only to the key that can sign it: Make moderator (the
  current moderator holder, since the transfer is holder-gated), Transfer admin (the current
  admin holder), Remove from group (admin).
- Invite button and Invitations in progress as described above.

| Action | Confirmation copy |
|---|---|
| Remove from group | "Remove {name}? They can't post or receive new messages once this reaches the relay. They keep everything already on their phone." |
| Make moderator | "Make {name} the moderator? The current moderator loses that role." |
| Transfer admin | "Make {name} the admin? You stop being admin. This can only be reversed by {name}." |

| State | Shown |
|---|---|
| Only me | "Just you so far." plus Invite |
| Removal not yet reconciled | "Removing…" on the row. `removal_pending` is a contract term; no client derivation was found, so this read-model field must be built upstream first. |
| I was removed | Problem screen: "You've been removed from this group. What's on this phone stays readable." Export available. |
| Admin's phone is lost | No recovery action exists. Group states this under Safety. |

## Group tab

**Reads** `GroupSummary`, `LinkStatus`, `AuditView`.

- **Relay.** The hosting sentence, relay address, connection per thread, waiting count, Sync
  now, and a "Pause sync" switch (the person-facing form of the M0 offline toggle).
- **Safety.** What is and is not protected, in plain lines: readable by the relay operator;
  no recovery if this phone is lost; text only. For losing the admin's phone it uses the
  contract's wording and nothing stronger: the group does not survive that today, and handing
  admin to someone else beforehand is the only handoff. In dev builds using demo identities it
  adds that the demo keys are public, so anyone can post as them.
- **My key.** Key check, where it is stored, and that it cannot be moved to another phone.
- **Verify & audit.** Per replica: op count, frontier, relay generation, matches-relay, every
  grant with its state (usable, revoked, lapsed), and every op that is not counted with its
  reason. Read-only. This is where protocol words are allowed.
- **Export.** Save the held Space frames to a file (the existing D-31 export shape).

## Problem screens

| `SessionStatus` | Says | Offers |
|---|---|---|
| `identity_mismatch` | "The key on this phone doesn't match the saved group." | Export, contact admin. Never "reset". |
| `history_invalid` | "Saved group data failed its check." with the reason code | Export, re-sync from relay into a fresh store after confirmation |
| `removed` | as above | Export |

## Accessibility and platform notes

- Every state mark has a text label for screen readers; colour is never the only signal.
- Identicon colour is paired with the petname or key check everywhere.
- Dynamic type, dark mode and reduced motion are honoured from M1, not retrofitted.
- Android back gesture closes sheets before screens; ceremonies ask before discarding.
- QR screens raise brightness and keep the screen awake while shown.
