# Treehouse Mobile: design docs

Design set for `clients/treehouse-mobile` (Plan 296): a small-group chat app for iOS first and
Android next, built on `@treetopdevs/lattice-client` and `@treetopdevs/lattice-shell-kit`.

Written 2026-11-25 against commit `bd9ddcc55`. These docs describe the target design. What is
actually built and verified lives only in [PROGRESS.md](PROGRESS.md).

## Reading order

| # | File | Answers |
|---|---|---|
| 1 | [01-ubiquitous-language.md](01-ubiquitous-language.md) | What do we call things, in code and on screen? |
| 2 | [02-domain-and-contexts.md](02-domain-and-contexts.md) | Which parts own which facts, and how do they relate? |
| 3 | [03-application-layer.md](03-application-layer.md) | What does the UI call, and what does it subscribe to? |
| 4 | [04-screens-and-flows.md](04-screens-and-flows.md) | What does each screen show, do and say? |
| 5 | [05-capability-matrix.md](05-capability-matrix.md) | Which features does the substrate support today? |
| 6 | [06-milestones.md](06-milestones.md) | In what order do we build, and what is still undecided? |
| - | [PROGRESS.md](PROGRESS.md) | What is done, at which evidence tier, as of the last commit? |

## The six findings that shape everything else

1. **A phone that makes its own key cannot reach the relay yet.** The relay admits transport
   realms from a static manifest (`trusted_peers`, `relay_realms`). Tested 2026-11-25: a fresh
   device key was refused on both demo routes with `unauthenticated` and pulled nothing. The
   live demo lets `demo-founder` and `demo-neighbor` submit and lists `demo-observer` as a
   third participant. Joining a group, starting a group and adding a thread all need
   server-side admission or provisioning that does not exist as a self-service path. This is
   the main substrate gap; see [05](05-capability-matrix.md).
2. **Posts carry no timestamp, and order is canonical, not arrival.** A `CarrierOpFrame` has no
   time field. After an offline period a late post can land in the middle of a thread. The
   timeline, unread markers and "new" indicators are designed around op ids, with local
   first-seen times as a device-only hint.
3. **An invitation takes three hand-offs, not two.** Join request (173 chars), offer (about
   1.5 KB with one thread, 2.7 KB with three, 8.2 KB with twelve) and acceptance (560 chars).
   The admin's phone must also reach the relay between the first and third hand-off. The flow
   is designed as one in-person back-and-forth, with text sharing as the remote path.
4. **Delivery and validity are two separate axes.** "Is my post on the relay?" comes from the
   relay link. "Does the group honor my post?" comes from the local judge. A post can be on
   the relay and not honored, or honored locally and refused by the relay.
5. **A device can hold more than one signing key.** A Thread created under the bounded profile
   has its own root key, held by the phone that created it and needed to grant that Thread to
   new members. Custody is designed as a device key plus per-Thread keys, not a single key.
6. **Three kinds of facts must never blur.** Signed shared facts (ops), relay-link
   observations (acks, generations) and device-local facts (petnames, drafts, read markers).
   Only the first kind is group truth.

## Rules for anyone changing the app

- The frozen product contract is [Plan 178](../../plans/178-treehouse-contract-correction.md).
  These docs implement it and may not widen it.
- Never re-implement protocol logic in the app. Reducers, the authority judge, codecs and
  capability selection come from `lattice-client`. If the app needs something they lack, add
  it there (with Sim conformance) or to `lattice-shell-kit`.
- Use the words in [01](01-ubiquitous-language.md) in code, tests and copy.
- Update [PROGRESS.md](PROGRESS.md) in every commit that touches `clients/treehouse-mobile/`
  or this directory. `scripts/check_treehouse_mobile_progress.sh` checks this.
- Claim only the evidence tier that actually ran: Core, Simulator or Physical.
- When a design decision changes, edit the doc that owns it. Do not append a second version
  elsewhere.
