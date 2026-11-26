import type { Clock } from "../ports";

/** A clock that moves only when told to. */
export class ManualClock implements Clock {
  constructor(private ms = 0) {}
  now(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export const systemClock: Clock = { now: () => Date.now() };
