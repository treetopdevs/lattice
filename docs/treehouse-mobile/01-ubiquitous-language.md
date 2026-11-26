# 1. Ubiquitous language

One word per concept, used in code, tests, docs and screen copy. The frozen contract
([Plan 178](../../plans/178-treehouse-contract-correction.md)) owns the domain terms; this
file maps them to what people see.

## Domain terms (signed, shared)

| Term in code | On screen | Meaning | Not to be called |
|---|---|---|---|
| Space | **Group** | One community: name, members, thread list, admin and moderator authority. One replica. | Server, channel, workspace |
| Thread | **Thread** | One conversation inside a Group. Its own replica, its own relay route. | Chat, room, channel |
| Post | **Message** | One text entry in a Thread. Text only. | |
| Author edit | **Edit** | The author replaces the text of their own message. | |
| Author tombstone | **Delete** | The author removes their own message from view. Irreversible. The signed history stays on devices and the relay. | Hide, unsend, recall |
| Moderator tombstone | **Remove (as moderator)** | The moderator removes someone else's message from view. Same permanence. | Hide, ban |
| Archive thread | **Archive** | The moderator closes a Thread to new messages, edits and deletes. No unarchive. History stays readable. | Delete thread, close, lock |
| Rollover | **Continue in a new thread** | Archive a full Thread and start its successor. Uses one of the Group's thread slots. | Compact, clean up, clear |
| Member | **Member** | A key in the Space's `members` set, holding grants to post. | User, account |
| `admin` | **Admin** | Current holder of the Space's `admin` authority. Transferable. | Founder, owner |
| `moderator` | **Moderator** | Current holder of `moderator` authority. One holder at a time. | Mod team |
| Root (genesis author) | **Started this group** | The key that created the Space. A permanent fact about history, not a role. | Founder as a role |
| Invitation | **Invitation** | A signed, recipient-bound record naming one key. Not a link anyone can use. | Invite link, invite code |
| Join request | **Join request** | The joiner's public key, shown to an admin. | |
| Offer | **Offer** | What the admin shows back: Group id, invitation id, routes, thread list. Carries no secret. | Invite |
| Acceptance | **Acceptance** | The joiner's signature over the invitation. | |
| Admit member | **Admit** | The admin's signed command that adds the member and issues grants. | Approve, accept |
| Remove member | **Remove from group** | Revokes grants and transport admission. The person keeps what their phone already synced. | Kick, block, ban |
| Grant (delegation) | not shown by default | A signed capability naming one key and a set of commands. Appears in Verify. | Permission, role |
| Lease | **Access renews** | A grant with an expiry epoch. | Session |
| Quarantine | **Not counted** | An op the judge refuses. It stays in the log and in Verify; it has no effect on the Group. | Blocked, rejected, spam |

## Transport terms (per device, about one relay)

| Term in code | On screen | Meaning |
|---|---|---|
| Relay | **Relay** | The host that stores and forwards the Group's log. It holds a readable copy. |
| Route | not shown by default | One replica's relay address plus the relay key the app expects there. |
| Realm | not shown | The transport identity the relay admits. Not membership. |
| Transport admission | **Relay access** | The relay's willingness to talk to a key. Separate from membership. |
| Outbox | **Waiting to send** | Ops this device authored. |
| Acked | **On relay** | The relay has stored the op durably. |
| Generation | not shown outside Verify | The relay's change counter for a route. |
| Refused | **Relay did not accept** | The relay quarantined or rejected a submitted op in the last sync. |

## Device-local terms (never signed, never synced)

| Term | On screen | Meaning |
|---|---|---|
| Petname | **Name you gave** | The label this phone shows for a key. Other members do not see it. |
| Fingerprint | **Key check** | Short digest of a public key, for comparing in person. |
| Identicon | avatar | Colour and shape derived from a key. |
| Draft | **Draft** | Unsent text for one Thread. |
| Read marker | unread dot and count | The set of message ids this phone has shown. |
| First-seen time | time label | When this phone first held a message. Not a send time. |
| Ceremony | **Invitation in progress** | The saved state of an unfinished invite or join. |

## Words the app never uses

- **Delivered**, **Read**, **Seen by**: nothing in the protocol proves either.
- **Encrypted**, **private**, **secure chat**: the relay holds a readable copy and E2EE is excluded.
- **Sent at 14:02**: no trusted time exists. Use first-seen time, and only as a soft label.
- **Account**, **log in**, **password**: identity is a device key.
- **Online** for a person: there is no presence.
- The Plan 178 prohibited phrases, listed in that file.

## Hosting sentence (the one approved form)

Every sentence about the relay names who can read and who can withhold. Short form for cards:

> The relay keeps a readable copy of this group. Its operator can read it and can take the
> relay offline. The relay cannot write messages in your name or change who is a member, and
> it cannot erase what is already on your phone.

For a member-operated relay, name the host device, its OS and administrator, its backups and
every transport peer the relay admits, as Plan 178 does. The M0 trust card says only that the
relay "holds a plaintext copy and can go offline"; it omits the reader and must be replaced
with the form above.
