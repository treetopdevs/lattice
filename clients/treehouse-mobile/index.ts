// Custom entry (SDK 58 Expo Router manual install): side effects first, then register the app through Expo
// Router, last. The polyfills (getRandomValues, the Hermes SHA-256 shim) must run before any route module.
import "./src/polyfills";
import "expo-router/entry";
