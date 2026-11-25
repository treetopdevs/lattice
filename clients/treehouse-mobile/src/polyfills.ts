import "react-native-get-random-values";

// Ensure structuredClone exists on older Hermes builds.
if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = (<T>(value: T): T => {
    if (value === null || typeof value !== "object") return value;
    return JSON.parse(JSON.stringify(value)) as T;
  }) as typeof globalThis.structuredClone;
}
