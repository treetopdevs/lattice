// Client identity: a self-certifying Ed25519 keypair held on the device.
//
// The interface is defined here; the concrete implementation depends on the
// shell and is deliberately NOT bundled into this framework-agnostic core:
//   • Expo / React Native: expo-secure-store + a WebCrypto/noble signer, or a
//     native module fronting iOS Secure Enclave / Android Keystore.
//   • Tauri v2: the Rust core holds the key (ring / ed25519-dalek) behind the
//     platform keystore, exposed to the Vue frontend over an IPC command.
//
// For pure-JS signing where a keystore isn't required, `@noble/ed25519`
// (audited, dependency-free, runs in RN/browser/Node) is the recommended
// implementation — pin the current major and confirm its sync/async API.
//
// NOTE: codec.ts owns carrier-frame canonical bytes, verification, and signing;
// township.ts owns command body/cap composition and frontier deps from local
// ops. A shell still needs durable local storage and real key custody.
export {};
