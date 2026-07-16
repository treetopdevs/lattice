# Applied Zero-Knowledge Cryptography for the Lattice Architecture
*A Research Investigation on the Integration of zk-SNARKs, zkVMs, and Folding Schemes into Lattice 2.0 & AtomVM Realms*

---

## Background

Lattice is an Elixir/Phoenix system designed for local-first, distributed replication. In its current iteration (Lattice 2.0), the system implements replicated state machines running on a **capability-attested log** (managed under `apps/lattice_core`). In parallel, recent work has introduced the **AtomVM browser-tab realm prototype** (`apps/lattice_tab`), which runs BEAM bytecode in an isolated WebAssembly sandbox inside the browser, communicating with the server and other tabs via an Emscripten-backed JavaScript bridge.

Currently, the Lattice 2.0 proof-of-concept (POC) handles security and replication through centralized or transparent mechanisms:
1. **Centralized Capability Verification:** The capability store (`Lattice.CapStore`) is a centralized, in-memory GenServer on the server. Replicas identify themselves using opaque, random capability IDs. Any authorization or delegation requires a round-trip to the server to look up and validate the capability's provenance, lifetime, and caveats.
2. **Transparent Delegation Chains:** If a capability is attenuated and delegated, the full delegation chain is visible to the validating authority. This compromises privacy, as the structure of the delegation chain reveals organizational relationships and access patterns.
3. **Unsecured Audit Log:** The replication and audit log (`Lattice.Audit`) is a simple, sequential in-memory list of maps. It lacks cryptographic tamper-evidence (e.g., hash-chaining or Merkle commitments), meaning there is no decentralized way to verify that a replica's log is untampered or matches the canonical state.
4. **All-or-Nothing State Sync:** State synchronization is performed by downloading a full snapshot of the server-side state (`LatticeServer.DemoHub.snapshot()`). This leaks the entire database state to the replica, preventing fine-grained, privacy-preserving or cell-level state synchronization.
5. **Constrained Client Environment:** The AtomVM browser realm runs in a highly constrained WebAssembly environment that lacks large integer support, bitstring utilities, and native parallel processing. Running traditional cryptographic operations (like generating heavy zero-knowledge proofs) directly inside the AtomVM virtual machine is computationally impossible.

Integrating **Zero-Knowledge (ZK) cryptography** (specifically 2024–2026 developments in client-side proving, recursive SNARKs, folding schemes, and zkVMs) presents a clear path to transition Lattice from a centralized proof-of-concept to a secure, private, and trustless local-first system.

---

## Key Findings

Developments in applied ZK cryptography between 2024 and 2026 have shifted the technology from theoretical academic research to a production-ready engineering tool. The combination of hardware-accelerated client provers, recursive folding schemes, and general-purpose zkVMs makes it feasible to run and verify cryptographic proofs directly in consumer web browsers.

Below is an analysis of how these technologies concretely apply to the five core challenges of the Lattice project.

### 1. Capability Attestation and Anonymous Verification
In Lattice 2.0, capabilities are verified by looking up their ID in a central database (`CapStore`). Under a zero-knowledge architecture, capabilities can be transformed into **self-verifying, anonymous credentials**.

*   **Mechanism:** Rather than storing the capability structure on the server and referencing it via an opaque ID, the issuer signs a capability token (containing target, ops, and caveats) using a standard signature scheme. To delegate, the parent holder signs a new attenuated token. The client holds this delegation chain privately.
*   **The ZK Proof:** When executing an operation, the client generates a zk-SNARK (using a modern proof system like Halo2 or Plonky3). The circuit takes the delegation chain and the client’s secret key as private inputs. It outputs public parameters:
    $$\text{Public Outputs} = \{ \text{Root Issuer Public Key}, \text{Target Resource Hash}, \text{Operation Mask}, \text{Current Epoch} \}$$
    The circuit proves:
    1. The client owns the private key corresponding to the final leaf capability.
    2. There is a valid chain of cryptographic signatures from the Root Issuer to the client.
    3. Each step in the chain correctly attenuates (narrows) the operations and targets of the parent.
    4. The capability has not expired.
*   **Lattice Integration:** The Elixir server (or other replicas) can verify this proof in constant time ($O(1)$) without querying a database or learning the identities of the intermediate delegators. This implements a zero-disclosure, offline-capable, and private authorization mechanism.

### 2. Log Integrity and Verifiable Replication
Lattice requires a method to guarantee that replication logs are consistent and untampered without forcing every light node or browser tab to download and re-execute the entire history of the system.

```mermaid
graph TD
    subgraph Prover (Browser/Server)
        T1[Tx 1] & T2[Tx 2] & T3[Tx N] --> MMR[Merkle Mountain Range]
        MMR --> Root1[MMR Root R_i]
        MMR --> Root2[MMR Root R_i+k]

        Root1 & Root2 & Steps[Transaction Logic] --> zkVM[zkVM / Folding Circuit]
        zkVM --> Proof[Succinct proof of validity π]
    end

    subgraph Verifier (Constrained Replica)
        Proof --> V[Constant-time verification]
        Root1 --> V
        Root2 --> V
        V -->|Accept/Reject| Result[State Transition Validated]
    end
```

*   **Merkle Mountain Ranges (MMR):** The audit log should be committed using an MMR—an append-only, balanced Merkle tree optimized for log structures. The root of the MMR serves as a succinct commitment to the entire history of the log.
*   **Incrementally Verifiable Computation (IVC) via Folding Schemes:** Proving the validity of a long transaction log in a single ZK circuit is memory-intensive. Folding schemes (such as **Nova**, **CycleFold**, and **Protostar**) solve this by "folding" two instances of a relation into one. Rather than compiling a loop of $N$ log updates into a massive circuit, folding enables the prover to maintain a running accumulator of the execution state.
*   **Lattice Integration:**
    *   For each new entry appended to the log, the replica folds the verification step (checking the capability proof and the state transition logic) into the running accumulator.
    *   When synchronizing state, a tab does not download the entire log. Instead, it downloads the target state snapshot, the new MMR root, and a succinct **decider proof** (e.g., a Spartan or Groth16 proof generated from the folded accumulator).
    *   The tab verifies the decider proof in milliseconds. This guarantees that the transition from its previous known state to the new state was executed correctly according to the system rules, without re-running the transactions.

### 3. Privacy-Preserving State Sync
Lattice replicas currently download the full state database. To support selective, privacy-preserving synchronization, the state representation must be cryptographically structured.

*   **Authenticated Key-Value Stores:** The replication state is represented as a **Sparse Merkle Tree (SMT)** or a **Verkle Tree** (which uses KZG polynomial commitments instead of hashes to reduce proof sizes). The database is committed as a single root hash.
*   **Verifiable State Subsets:** When a client tab requests state:
    1. The server filters the key-value store, selecting only the keys that the client's capability proof authorizes them to read.
    2. The server returns these key-value pairs along with **Merkle inclusion proofs** (or KZG open proofs) relative to the global state root.
    3. The client verifies that the returned data is a genuine subset of the canonical database state.
*   **Zero-Knowledge Information Flow Control (IFC):** By executing the data filtering step inside a zk-SNARK, the server can prove that it has withheld all unauthorized data and included all authorized data according to the client’s capability constraints, without exposing the metadata or keys of other database partitions.

### 4. Succinct Proofs in Constrained Environments (AtomVM/WASM)
Running ZK proof generation directly inside the AtomVM virtual machine is blocked by performance limitations: AtomVM does not natively support big integers, and running complex mathematical interpreters in WebAssembly adds double-virtualization overhead. The solution is a **hybrid split-execution architecture**.

```
 +-----------------------------------------------------------+
 |                    BROWSER TAB REALM                      |
 |                                                           |
 |  +-------------------+             +-------------------+  |
 |  |    AtomVM WASM    |  Request    | WebGPU-Accelerated|  |
 |  |                   | ----------->|    JS Prover      |  |
 |  |  (Elixir/BEAM)    |             | (e.g., ICICLE,    |  |
 |  |                   | <-----------|    Plonky3)       |  |
 |  | - State logic     |  ZK Proof   | - MSM/NTT on GPU  |  |
 |  | - Bridge handling |             | - Witness gen     |  |
 |  +-------------------+             +-------------------+  |
 +----------------------------------------|------------------+
                                          | Verify Proof
                                          v
                               +---------------------+
                               |   Elixir Server /   |
                               |    Peer Replica     |
                               +---------------------+
```

1.  **Verification is Cheap:** Verifying a zk-SNARK (like Groth16 or Plonk) requires only a few elliptic curve pairing operations, taking 5ms to 50ms. Verification logic can be compiled into a lightweight native library and linked to the AtomVM WASM bundle, or invoked via the existing `Lattice.Tab.Bridge` using JavaScript’s native crypto APIs.
2.  **Proving via WebGPU outside AtomVM:** Proof generation is offloaded to the host browser context.
    *   The AtomVM code writes the execution witness (the raw data inputs) to a shared memory buffer.
    *   The browser's JavaScript environment reads this buffer and invokes a WebGPU-accelerated ZK prover (such as **ICICLE** or **Plonky3**).
    *   The GPU handles the parallel Multi-Scalar Multiplication (MSM) and Number Theoretic Transform (NTT) operations, generating the proof in seconds.
    *   The proof is passed back to AtomVM via the bridge for outward replication.
3.  **Prover Delegation (Prover Markets / Coprocessors):** If the client device is extremely resource-constrained (e.g., a low-end mobile browser), the client can delegate the proving step. The client generates the execution witness locally, encrypts the private inputs under the public key of a decentralized proving service (like Aligned Layer or Succinct SP1 network), and uploads the witness. The network generates the proof and returns it, allowing the client to maintain $O(1)$ local memory overhead.

### 5. Authenticated Data Structures
To support ZK validation, the underlying data representation in the Elixir/AtomVM system must match the mathematical primitives of zero-knowledge circuits (primarily field elements of curves like BN254, BLS12-381, or BabyJubjub).

| Current Elixir Structure | ZK-Compliant Alternative | Purpose in Lattice |
| :--- | :--- | :--- |
| `Lattice.Audit` (List of maps) | **Merkle Mountain Range (MMR)** | Cryptographic, append-only log commitment. Enables light client state-sync. |
| State Maps (`%{"key" => val}`) | **Sparse Merkle Tree (SMT)** or **Verkle Tree** | Authenticated key-value storage. Allows verification of single-key state reads/writes. |
| Capability Struct (`Lattice.Cap`) | **ZK-Credential Token** (Poseidon hash of target, ops, and expiry) | Cryptographic delegation and attenuation proving without revealing identity. |
| Vector Clocks / Causality | **Vector Commitments** or **Poseidon Hash Chains** | Compact representation of logical history for verification in ZK. |

---

## Caveats and Open Questions

While the theoretical advantages of zero-knowledge proofs match Lattice's requirements, several practical constraints must be resolved:

1.  **Double-Virtualization Overhead & Performance Bottlenecks:**
    *   *Challenge:* Translating Elixir BEAM bytecode or execution logic into a zkVM-compatible ISA (like RISC-V for RISC Zero or SP1) introduces massive proving overhead (often $10,000\times$ to $100,000\times$ slower than native execution).
    *   *Impact:* Generating a state-transition proof by running the BEAM interpreter inside a zkVM is currently impractical for client devices. The system must use hand-written, specialized circuits (e.g., using Halo2 or Circom) for capability and log verification, rather than general zkVMs.
2.  **WebGPU Hardware & Driver Variability:**
    *   *Challenge:* While WebGPU is standard in 2026, compatibility depends on client hardware drivers. Devices with older GPUs or restricted permissions (such as secure enterprise browsers) may fallback to CPU-based Wasm proving, increasing proof times from sub-second to minutes.
    *   *Impact:* The system must maintain fallback paths, such as proof delegation to a trusted server or decentralized prover market.
3.  **Verification Code Size in AtomVM WASM:**
    *   *Challenge:* AtomVM is designed to be extremely lightweight (running on microcontrollers and embedded environments). Adding cryptographic pairing libraries (like `arkworks` or `bellman` compiled to WASM) to the verification engine will increase the WASM bundle size by several megabytes, conflicting with the goal of fast page loads.
    *   *Impact:* Optimizing the verifier compilation or relying entirely on host-side JavaScript verification (via the bridge) is necessary to keep the core AtomVM binary small.
4.  **Elliptic Curve Selection Compatibility:**
    *   *Challenge:* Standard Elixir libraries use `:crypto` (which binds to OpenSSL) supporting curves like secp256k1 or Ed25519. ZK proof systems require pairing-friendly curves (BN254 or BLS12-381) or hashing-friendly fields (Goldilocks for Plonky3).
    *   *Impact:* A translation layer or custom NIFs (Native Implemented Functions) in Elixir will be required to handle these ZK-friendly curves on the server side.
5.  **State Reification and Garbage Collection:**
    *   *Challenge:* Reconstructing a state machine's state from an MMR and proving its validity in a browser requires managing large chunks of memory. Constrained tabs may run out of memory (OOM) during witness generation.
    *   *Impact:* Replicas must strictly partition state into small, independent logical channels rather than maintaining a single global state tree.

---

## Sources

1.  **Folding Schemes & IVC:**
    *   *Nova: Recursive Zero-Knowledge Proofs without Trusted Setup* (Kothapalli et al.) – [IACR Cryptology ePrint 2021/370](https://eprint.iacr.org/2021/370).
    *   *CycleFold: Folding Schemes over a Cycle of Curves* (Kothapalli & Setty) – [IACR Cryptology ePrint 2023/1192](https://eprint.iacr.org/2023/1192).
    *   *Protostar: Generic folding protocols for Plonk-like customizations* (Bünz & Chen) – [IACR Cryptology ePrint 2023/620](https://eprint.iacr.org/2023/620).
    *   *Sonobe: A Modular Folding Scheme Library* (Ethereum Foundation PSE) – [GitHub Repository](https://github.com/privacy-scaling-explorations/sonobe).

2.  **Client-Side Browser Proving:**
    *   *ICICLE: GPU-Accelerated Cryptographic Library for Zero-Knowledge Proofs* (Ingonyama) – [ICICLE Documentation](https://github.com/ingonyama-zk/icicle).
    *   *WebGPU Specification and Performance Analysis for Cryptographic Kernels* (W3C WebGPU Working Group, 2025/2026).
    *   *Plonky3: Next-Generation Vectorized Prover* (Polygon Zero) – [GitHub Repository](https://github.com/Plonky3/Plonky3).

3.  **Decentralized Delegation & Credentials:**
    *   *User-Controlled Authorization Networks (UCAN) Spec* – [UCAN WG](https://github.com/ucan-wg/spec).
    *   *Anonymous Credentials and Verifiable Credentials in Zero-Knowledge* (W3C CCG, 2025).
    *   *Semaphore: Privacy-preserving identity verification* – [Semaphore documentation](https://semaphore.pse.dev/).

4.  **Authenticated Data Structures:**
    *   *Merkle Mountain Ranges (MMR) Spec* (Peter Todd) – [GitHub open-source reference](https://github.com/opentimestamps/opentimestamps-server/blob/master/doc/merkle-mountain-range.md).
    *   *Verkle Trees for Ethereum State* (Vitalik Buterin) – [Ethereum Research](https://ethresear.ch/t/verkle-trees/10423).
