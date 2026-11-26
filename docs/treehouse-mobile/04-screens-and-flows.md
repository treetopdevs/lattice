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

M1b.1 as built: the Group name and the pill are the tab's own header (it grows with dynamic
type); the pill opens the Group tab, where the Relay section lives, until a Relay screen exists.
Each row says its states in words (for example "2 unread", "1 waiting to send", "Not connected"),
and the screen reader hears the whole row. Archived threads sit behind a collapsed "Archived
threads (N)" toggle row in the same list, after the active rows and heading the archived
rows while open (review fix; it was a footer below them). The pill shows from the first
render, before a Space is pulled, so Relay details are always one tap away. New thread and the slots-full line are not shown in M1:
creating a thread needs G-2 and per-Thread keys, so `create_thread` is never allowed yet.
Authors are named "You", by petname, or by key check; never by realm.

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
| Archived | banner "Archived. No new messages." with a link to the successor if one exists; composer replaced by the banner |
| Cannot post (no grant, lapsed, removed) | composer replaced by one line with the reason and who can fix it |
| My message not counted | greyed bubble, reason line, "Copy text" so it can be re-sent |
| Relay did not accept | warning mark; details give the relay's reason; "Try again" runs sync |
| Thread near rollover threshold | moderator sees a one-line prompt to continue in a new thread |
| Concurrent edit lost | the winning text is shown; no error, since both edits are valid history |

M1b.2 as built: an inverted, virtualized list (newest at the bottom) of bubbles in canonical
order. The author's name heads each run of consecutive messages from one key. A day separator
("Today", "Yesterday", else a short local date) goes before a message whose first-seen day differs
from the current one along canonical order; a message with no first-seen time stays in the current
day, so a day can appear twice. Each of my messages shows its mark as a glyph and words: ◷ "Saved
on this phone" or "Sending", ✓ "On relay", ⚠ "Relay did not accept", and ⚠ "Relay is not
accepting messages" for a stopped submit route. Each bubble carries one accessibility label that
says author, text and every state (seen top to bottom in the simulator's accessibility tree;
VoiceOver itself not run); the mark's own text node is hidden from screen readers. The composer sits on the keyboard (offset from the real stack header
height and the home-indicator inset). The long-press sheet, unread divider, cannot-post bar and
archived banner come with M1b.3 to M1b.6; until then a one-line notice replaces the composer.

M1b.3 as built: a long-press on a bubble opens the sheet only when it has an item; the items come
from the `Abilities` read model (`author_edit`, `author_tombstone`, `moderator_tombstone`, which
already carry the archive rule) and the message's own facts (mine, counted, not removed), in
`src/ui/message_sheet.ts`. A removed or not-counted message offers nothing; a moderator's own
message offers Delete, not Remove. The sheet and its confirmation are one RN `Modal` whose content
switches, so the stack header is covered and iOS never presents a second modal mid-dismiss. The
sheet holds a message id and is re-read from the timeline, so it closes when the message is
removed elsewhere or the thread is archived. Edit puts the message's text in the composer under an
"Editing message" bar with Cancel and Save; the saved draft is flushed first and comes back
unchanged after Save or Cancel, and edit keystrokes are never saved as a draft. The bubble declares
the sheet as its accessibility action ("Message actions", `activate` on iOS, `longpress` on
Android) with a hint, and the backdrop is hidden from screen readers; VoiceOver itself was not run.
Not yet in the sheet at M1b.3: Copy (added at M1b.5)
and Details (no Message details screen yet). At the largest text size the confirmation sentence scrolls inside the card.

M1b.4 as built: on open, a divider with its count ("3 unread", read out as "3 unread from here")
sits above the first unread id, after that message's day separator, and ends an author run. It
stays where it was while the screen is open, although the screen marks what it shows at once; it
is gone on the next open. A message the timeline calls arrived later carries "↑ Arrived later" as
its own caption, in words, and the bubble's screen-reader label says it too; the caption stays
while the screen is open. The Threads tab counts an arrived-later message as unread like any
other. The list does not scroll to the divider: with more unread than fit, the divider can sit
above the first screen.

M1b.5 as built: when this key cannot post, a bar replaces the composer with one line that gives the
reason and who can fix it: "The admin took back posting in this thread from you. Only the admin can
give it back." for a revoked grant, a renew line for a lapsed one, "You were not given posting in this
thread. Ask the admin." for none, the removed line when the group removed this key, and the
archived line until M1b.6's banner. A message of mine the judge does not count is a dashed,
muted bubble (not reduced opacity, so its text keeps its contrast in both themes) with "Not
counted", the judge's reason, and a "Copy text" button beside it; Copy text is also a named
accessibility action on the bubble, whose label includes the reason. The long-press sheet now
offers Copy first for every message with text (Copy only on a not-counted message, or once the
thread no longer takes changes from this key), so no bubble is selectable; the screen reader hears
"Copied". Details is still not in the sheet (no Message details screen).

M1b.6 as built: in an archived thread a banner, "Archived. No new messages.", replaces the composer for
every key, the moderator included, and comes before any reason about this key (removed, revoked); it
appears while the screen is open as soon as the archive arrives. There is no successor link: rollover
needs G-2 and the Thread replica records no successor, so nothing in M1 names one. The thread screen's
header has an "Info" button (screen-reader name "Thread info") that pushes Thread info: the title, the
"Archived. No new messages." line when archived, Messages (counted, not removed), Signed entries against
4,000 and Size against 8 MB (8 MiB, shown as MB), and a note that a thread near either limit is continued
in a new thread, which this app can't do yet. Archive thread is shown only to a key whose Abilities allow
`archive_thread` and only while the thread is not archived (the judge would honor a second archive; 01 has
no unarchive). It confirms first: "Archive this thread for the group? No one can post, edit or delete
messages in it again. This can't be undone. Its messages stay in the thread." Continue in a new thread and
the near-threshold prompt are not shown (G-2). The screen scrolls, so accessibility sizes do not clip. The
Info label is capped at 1.5x text size so it does not push the title out of the header.

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
- **Verify & audit.** Per replica: op count, frontier, relay generation, matches-relay (a retained
  match reads "changed since the last comparison" while the route is not live or ops wait), every
  grant with its state (usable, revoked, lapsed), and every op that is not counted with its
  reason. Read-only. This is where protocol words are allowed.
- **Export.** Save the held Space frames to a file (the existing D-31 export shape). As built
  (M1b.7) the app writes the file into its own documents directory under lattice-client's suggested
  name, says "Saved as {name}", and opens the share sheet on the file so iOS offers "Save to Files".
  If the write fails it shares the D-31 text instead (the M1a.7 behaviour). A refusal names
  `no_space` or `export_failed` with one line of copy.

As built at M1b.7: Verify & audit is a pushed screen from the Relay card. Grant states are worded
usable, revoked, lapsed or "not usable" (a grant neither live nor revoked nor lapsed); facts with
no relay result yet say "Not compared yet". The Pause sync switch follows the person's setting, not
the pill. Safety lists: readable by the relay operator; no recovery if this phone is lost; the
lost-admin line in Plan 178's terms; text only; Delete and Remove leave synced copies in the signed
history; and, in dev builds, the demo-keys line. My key says whether the key is in the Keychain or
is a test key the build loaded, and that it cannot be moved to another phone.

## Problem screens

| `SessionStatus` | Says | Offers |
|---|---|---|
| `identity_mismatch` | by reason (M1b.2): `outbox_other_key` "The key on this phone doesn't match the saved group."; `key_unavailable` "This phone's key can't be opened right now. Unlock the phone and open Treehouse again."; `key_missing` "This phone holds a saved group but not the key that goes with it." | Export, contact admin. Never "reset". |
| `history_invalid` | "Saved group data failed its check." with the reason code | Export, re-sync from relay into a fresh store after confirmation |
| `removed` | as above | Export |

As built at M1a.7, the re-sync confirmation says that posts in the failed store that never
reached the relay are not sent and are not in the saved file, and a failed carry-over of the
earlier version's data is shown as `history_invalid` with reason `carry_over: ...`; that data
stays on the phone untouched.

## Accessibility and platform notes

- Every state mark has a text label for screen readers; colour is never the only signal.
- Identicon colour is paired with the petname or key check everywhere.
- Dynamic type, dark mode and reduced motion are honoured from M1, not retrofitted.
- Android back gesture closes sheets before screens; ceremonies ask before discarding.
- QR screens raise brightness and keep the screen awake while shown.
