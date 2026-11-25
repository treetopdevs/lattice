import type { ReadModels, TreehouseSession } from "../session/session";

// The external store behind useReadModel (M1a.7): `subscribe` and `getSnapshot` over one session and one
// selector, in the shape useSyncExternalStore wants. The snapshot is cached per ReadModels object, so it
// stays identical until the session publishes new models, and a selector that returns an existing model
// object stays identical until that model changes. Selectors should pick, not build: projection work belongs
// to the session, never to the render path.

export interface ReadModelSource<T> {
  subscribe(onChange: () => void): () => void;
  getSnapshot(): T | null;
}

const NONE: ReadModelSource<never> = {
  subscribe: () => () => undefined,
  getSnapshot: () => null,
};

export function readModelSource<T>(session: TreehouseSession | null, select: (m: ReadModels) => T): ReadModelSource<T> {
  if (!session) return NONE;
  let models: ReadModels | null = null;
  let value: T | null = null;
  return {
    subscribe(onChange) {
      // The session notifies only when the selected value changes (Object.is).
      return session.subscribe(select, () => onChange());
    },
    getSnapshot() {
      const current = session.read();
      if (current !== models) {
        const next = select(current);
        models = current;
        if (!Object.is(next, value)) value = next;
      }
      return value;
    },
  };
}
