# Township

Glossary for the Township civic instance on Lattice. Terms are pinned as design decisions settle.

## Language

**Election foundation**:
The research-safe account of one election: its authorized Matter link, its board, and the exact artifact bytes, replayed together. It makes no coercion-resistance claim.
_Avoid_: M4 election, receipt-free election, final tally

**Replay**:
The outcome of replaying an election foundation once. A successful replay includes the projection and the verified board detail. A failed replay is a reason and includes no projection.
_Avoid_: foundation view, verified election

**Projection**:
The public summary carried by a successful replay. While no construction profile is selected, it stays in setup, has no close id, and carries no final result.
_Avoid_: close evidence, tally, replay

**Close policy**:
A rule that replays an election foundation from its inputs and may produce close evidence. That evidence does not change the projection.
_Avoid_: finality, foundation phase

**Close evidence**:
The record a close policy produces when its rule holds. It stays separate from the projection.
_Avoid_: final result, projection

**Offline bundle**:
A package of an election foundation's public inputs and the projection those inputs produced. A check replays those packaged inputs and compares the projection.
_Avoid_: archive, receipt
