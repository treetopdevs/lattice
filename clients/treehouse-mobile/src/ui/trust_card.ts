// M1a.6: the trust card copy and the relay access state. Since M1a.5 the copy lives in strings.ts and
// relayAccess in M1a.4's link_status projection; this file re-exports both so the M0 screen keeps one
// import until M1a.7 replaces it.

export { HISTORY_INVALID, HOSTING_SENTENCE, NO_GROUP_YET, NO_RELAY_ACCESS, RELAY_REFUSED_PILL } from "./strings";

export { relayAccess } from "../session/projections/link_status";
export type { RelayAccess } from "../session/projections/link_status";
